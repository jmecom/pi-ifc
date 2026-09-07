import hashlib
import os
import re
import signal
import subprocess
import tempfile
from pathlib import Path


class GitPush:
    """The only worker operation allowed to use the network."""

    def __init__(self, sandbox, state_directory, destination):
        self.sandbox = sandbox
        self.state_directory = state_directory
        self.destination = destination
        self.snapshot = None
        self.commit = None
        self.digest = None
        self.environment = {
            'HOME': str(Path.home()),
            'PATH': f'{sandbox.git.parent}:/usr/bin:/bin',
            'LANG': 'en_US.UTF-8',
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_TERMINAL_PROMPT': '0',
            'GIT_ALLOW_PROTOCOL': 'ssh',
            'GIT_SSH_COMMAND': '/usr/bin/ssh -oBatchMode=yes -oStrictHostKeyChecking=yes '
                               '-oUpdateHostKeys=no -oClearAllForwardings=yes '
                               '-oForwardAgent=no -oForwardX11=no -oPermitLocalCommand=no',
        }
        if os.environ.get('SSH_AUTH_SOCK'):
            self.environment['SSH_AUTH_SOCK'] = os.environ['SSH_AUTH_SOCK']
        self.configure(destination)

    def configure(self, destination):
        self.discard()
        if destination:
            url = destination['url']
            # Keep shell syntax and transport options out of the destination.
            if not re.fullmatch(r'(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*:|'
                                r'ssh://[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]+)?/)'
                                r'[A-Za-z0-9_][A-Za-z0-9_./-]*', url):
                raise ValueError('Use an SSH push URL, for example git@github.com:owner/repo.git.')
            branch = destination['branch']
            if branch.startswith('-') or self.run('check-ref-format', f'refs/heads/{branch}').returncode:
                raise ValueError('Invalid push branch.')
        self.destination = destination

    def run(self, *arguments, repository=None, allow_bundle=False):
        environment = dict(self.environment)
        if allow_bundle:
            environment['GIT_ALLOW_PROTOCOL'] = 'file'
        command = [str(self.sandbox.git), '--no-pager', '--no-replace-objects',
                   '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                   '-c', 'maintenance.auto=false', '-c', 'gc.auto=0']
        if repository:
            command.extend(['--git-dir', str(repository)])
        process = subprocess.Popen(
            [*command, *arguments], cwd=self.state_directory, env=environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors='replace', start_new_session=True,
        )
        try:
            output, _ = process.communicate(timeout=120)
            return subprocess.CompletedProcess(command, process.returncode, output)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            process.stdout.close()

    def checked(self, *arguments, **options):
        result = self.run(*arguments, **options)
        if result.returncode:
            raise ValueError('Could not prepare Git commits for pushing. Check that the repository has complete history.')
        return result.stdout

    def discard(self):
        if self.snapshot:
            self.snapshot.cleanup()
        self.snapshot = self.commit = self.digest = None

    def prepare(self, baseline):
        if not self.destination:
            raise ValueError('Choose a push destination with /ifc push first.')
        self.discard()
        try:
            root = self.sandbox.run([str(self.sandbox.git), 'rev-parse', '--show-toplevel'])
            if root.returncode or Path(root.stdout.strip()).resolve() != self.sandbox.workspace:
                raise ValueError('git_push requires a Git repository at the workspace root.')
            bundle = self.sandbox.run([
                str(self.sandbox.git), '--no-replace-objects', '-c', 'core.hooksPath=/dev/null',
                '-c', 'core.fsmonitor=false', 'bundle', 'create', '-', 'HEAD',
            ], binary=True)
            if bundle.returncode:
                raise ValueError('Commit your changes before pushing. A complete Git history is required.')
            if len(bundle.stdout) > 64 * 1024 * 1024:
                raise ValueError('Commit snapshot exceeds the 64 MiB limit.')

            # The host imports Git objects, never the workspace's Git config or hooks.
            self.snapshot = tempfile.TemporaryDirectory(prefix='push-', dir=self.state_directory)
            snapshot = Path(self.snapshot.name)
            archive, repository = snapshot / 'commits.bundle', snapshot / 'repo.git'
            archive.write_bytes(bundle.stdout)
            self.checked('clone', '--bare', '--no-local', '--template=', str(archive), str(repository), allow_bundle=True)
            self.checked('fsck', '--strict', '--no-reflogs', repository=repository)
            self.commit = self.checked('rev-parse', '--verify', 'HEAD^{commit}', repository=repository).strip()
            if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', self.commit):
                raise ValueError('Invalid commit ID.')

            history = self.checked('log', '--format=%H %s', self.commit, repository=repository)
            scope = self.commit
            description = 'Diff of the tip commit.'
            if isinstance(baseline, str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', baseline):
                ancestor = self.run('merge-base', '--is-ancestor', baseline, self.commit, repository=repository)
                if ancestor.returncode == 0 and baseline != self.commit:
                    scope = f'{baseline}..{self.commit}'
                    description = 'Each commit since the initial workspace commit.'
            patch = self.checked('log', '--format=fuller', '--patch', '--root', '--diff-merges=separate',
                                 '--no-ext-diff', '--no-textconv', '--binary', '--full-index',
                                 *(['-1'] if scope == self.commit else []), scope, '--', repository=repository)
            review = (f'Push {self.commit}\nTo {self.destination["url"]}\nBranch {self.destination["branch"]}\n\n'
                      'This sends the commit and any ancestors missing from the remote, including old file contents.\n'
                      f'Complete reachable commit list:\n{history}\n{description}\n{patch}')
            if len(review.encode('utf-8')) > 2 * 1024 * 1024:
                raise ValueError('Push review exceeds the 2 MiB limit.')
            self.digest = hashlib.sha256(bundle.stdout).hexdigest()
            return {'commit': self.commit, 'digest': self.digest, 'review': review}
        except BaseException:
            self.discard()
            raise

    def push(self, commit, digest):
        if not self.snapshot or commit != self.commit or digest != self.digest:
            raise ValueError('No matching prepared push. Review a new snapshot.')
        try:
            result = self.run('push', '--porcelain', '--no-verify', '--no-follow-tags',
                              '--no-signed', '--recurse-submodules=no', '--', self.destination['url'],
                              f'{self.commit}:refs/heads/{self.destination["branch"]}',
                              repository=Path(self.snapshot.name) / 'repo.git')
            return {'exitCode': result.returncode, 'output': result.stdout}
        finally:
            self.discard()
