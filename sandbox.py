import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

# -I omits the script directory; only add the protected worker's own directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from git_push import GitPush


class Cancelled(Exception):
    pass


class Sandbox:
    def __init__(self, workspace, protected=()):
        if sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").is_file():
            raise ValueError("This agent requires macOS sandbox-exec. There is no unsandboxed fallback.")

        self.workspace = Path(workspace).expanduser().resolve(strict=True)
        if not self.workspace.is_dir():
            raise ValueError("Workspace must be a directory.")

        runtime_paths = {
            Path("/bin"), Path("/usr/bin"), Path("/usr/lib"), Path("/System/Library"),
            Path(sys.base_prefix).resolve(), Path(sys.prefix).resolve(),
            Path(sys.executable).parent, Path(sys.executable).resolve().parent,
        }
        self.git = Path(subprocess.check_output(['/usr/bin/xcrun', '-f', 'git'], text=True).strip()).resolve()
        runtime_paths.add(self.git.parent.parent)
        def fail_scan(error):
            raise error

        for directory, _, names in os.walk(self.workspace, followlinks=False, onerror=fail_scan):
            for name in names:
                info = (Path(directory) / name).lstat()
                if stat.S_ISLNK(info.st_mode) or stat.S_ISSOCK(info.st_mode):
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("Workspace files must be regular files without hard links, or symlinks. Found: " + str(Path(directory) / name))

        self.temporary_directory = tempfile.TemporaryDirectory(prefix="minimal-ifc-")
        self.scratch = Path(self.temporary_directory.name).resolve()
        if self.scratch.is_relative_to(self.workspace):
            self.close()
            raise ValueError("The workspace cannot contain the agent's temporary directory.")

        readable = runtime_paths | {self.workspace, self.scratch}
        ancestors = {parent for path in readable for parent in path.parents}

        self.profile = "\n".join([
            "(version 1)",
            "(deny default)",
            '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
            "(allow process-exec process-fork)",
            "(allow signal (target same-sandbox))",
            "(allow process-info* (target same-sandbox))",
            '(allow sysctl-read (sysctl-name "hw.ncpu") (sysctl-name "hw.pagesize") '
            '(sysctl-name "hw.memsize") (sysctl-name "hw.machine") '
            '(sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") '
            '(sysctl-name "kern.version") (sysctl-name "kern.hostname"))',
            '(allow file-read* (literal "/dev/null") (literal "/dev/urandom"))',
            '(allow file-write-data (literal "/dev/null"))',
            *(f"(allow file-read* (subpath {json.dumps(str(path), ensure_ascii=False)}))" for path in sorted(readable)),
            *(f"(allow file-read-metadata (literal {json.dumps(str(path), ensure_ascii=False)}))" for path in sorted(ancestors)),
            *(f"(allow file-write* (subpath {json.dumps(str(path), ensure_ascii=False)}))" for path in (self.workspace, self.scratch)),
            *(f"(deny file-read* file-write* (subpath {json.dumps(str(path), ensure_ascii=False)}))" for path in protected),
        ])

        self.environment = {
            "PATH": f"{self.git.parent}:{Path(sys.prefix) / 'bin'}:{Path(sys.base_prefix) / 'bin'}:/usr/bin:/bin",
            "HOME": str(self.scratch),
            "TMPDIR": str(self.scratch),
            "LANG": "en_US.UTF-8",
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
        }

        result = self.run([str(Path(sys.executable).resolve()), "-I", "-S", "-c", "print('sandbox ready')"])
        if result.returncode != 0 or result.stdout.strip() != "sandbox ready":
            self.close()
            raise ValueError(f"Sandbox startup failed (exit {result.returncode}): {result.stdout.strip()}")

    def close(self):
        self.temporary_directory.cleanup()

    def run(self, command, *, payload=None, timeout=60, allowed_read=None, binary=False):
        profile = self.profile
        if allowed_read is not None:
            profile += f"\n(allow file-read* (literal {json.dumps(str(allowed_read), ensure_ascii=False)}))"
            profile += "".join(
                f"\n(allow file-read-metadata (literal {json.dumps(str(parent), ensure_ascii=False)}))"
                for parent in allowed_read.parents
            )

        process = subprocess.Popen(
            ["/usr/bin/sandbox-exec", "-p", profile, *command],
            cwd=self.workspace,
            env=self.environment,
            stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if binary else subprocess.STDOUT,
            text=not binary,
            errors=None if binary else "replace",
            close_fds=True,
            start_new_session=True,
        )

        try:
            output, _ = process.communicate(payload, timeout=timeout)
            return subprocess.CompletedProcess(command, process.returncode, output)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
            if process.stdin is not None:
                process.stdin.close()


FILE_WORKER = r"""
import json
import os
import stat
import sys
from pathlib import Path

operation, arguments = json.load(sys.stdin)
path = Path(arguments['path']).resolve()
if operation != 'outside_read' and not path.is_relative_to(Path.cwd()):
    raise ValueError('Path must be inside the workspace.')

def read_text():
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('Only regular files can be read.')
        return source.read(8 * 1024 * 1024 + 1).decode('utf-8')

if operation in ('read', 'outside_read'):
    value = read_text()
    if len(value.encode('utf-8')) > 8 * 1024 * 1024:
        raise ValueError('File exceeds 8 MiB.')
    if 'offset' in arguments or 'limit' in arguments:
        start = max(0, arguments.get('offset', 1) - 1)
        lines = value.splitlines(keepends=True)
        value = ''.join(lines[start:start + arguments.get('limit', len(lines))])
elif operation == 'write':
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(arguments['content'], encoding='utf-8')
    value = 'Written.'
elif operation == 'edit':
    old, new = arguments['oldText'], arguments['newText']
    value = read_text()
    if not old or value.count(old) != 1:
        raise ValueError('oldText must be nonempty and occur exactly once; file unchanged.')
    path.write_text(value.replace(old, new, 1), encoding='utf-8')
    value = 'Edited.'
else:
    raise ValueError('Unknown file operation.')
print(json.dumps(value))
"""


def git(sandbox, *arguments):
    command = [
        str(sandbox.git), '--no-pager', '--no-replace-objects',
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        *arguments,
    ]
    result = sandbox.run(command)
    if result.returncode:
        raise ValueError('Git operation failed.')
    return result.stdout


def dispatch(sandbox, request, pushes=None):
    operation = request['operation']
    args = request.get('arguments', {})

    if operation == 'resolve':
        path = (sandbox.workspace / Path(args['path']).expanduser()).resolve()
        return {'path': str(path), 'inside': path.is_relative_to(sandbox.workspace)}

    if operation in ('read', 'outside_read', 'write', 'edit'):
        allowed = Path(args['path']) if operation == 'outside_read' else None
        result = sandbox.run(
            [str(Path(sys.executable).resolve()), '-I', '-S', '-c', FILE_WORKER],
            payload=json.dumps([operation, args]), allowed_read=allowed,
        )
        if result.returncode:
            raise ValueError('File operation failed: check permissions, UTF-8 encoding, and edit match.')
        return json.loads(result.stdout)

    if operation == 'bash':
        result = sandbox.run(
            ['/bin/bash', '--noprofile', '--norc', '-c', args['command']],
            timeout=min(300, max(1, args.get('timeout', 60))),
        )
        return f'Exit code: {result.returncode}\n{result.stdout}'

    if operation == 'baseline':
        try:
            root = Path(git(sandbox, 'rev-parse', '--show-toplevel').strip()).resolve()
            if root != sandbox.workspace:
                return None
            commit = git(sandbox, 'rev-parse', '--verify', 'HEAD^{commit}').strip()
            if len(commit) not in (40, 64) or any(c not in '0123456789abcdef' for c in commit):
                raise ValueError('Invalid Git baseline.')
            return commit
        except ValueError:
            return None

    if operation == 'prepare_push':
        return pushes.prepare(args.get('baseline'))

    if operation == 'push':
        return pushes.push(args['commit'], args['digest'])

    if operation == 'discard_push':
        pushes.discard()
        return None

    raise ValueError('Unknown operation.')


def main():
    def interrupt(*_):
        raise Cancelled('Cancelled.')

    signal.signal(signal.SIGUSR1, interrupt)
    sandbox = Sandbox(Path(sys.argv[1]), [Path(p).resolve() for p in sys.argv[2:]])
    config = json.loads(os.environ.get('PI_IFC_CONFIG', '{}'))
    pushes = GitPush(sandbox, Path(sys.argv[2]), config.get('push'))
    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                result = {'value': dispatch(sandbox, request, pushes)}
            except subprocess.TimeoutExpired:
                result = {'error': 'Push timed out; check the remote before retrying.'
                          if request.get('operation') == 'push' else 'Operation timed out.'}
            except (OSError, UnicodeError, ValueError, KeyError, TypeError, Cancelled) as error:
                result = {'error': str(error) if isinstance(error, ValueError) else type(error).__name__}
            print(json.dumps(result), flush=True)
    finally:
        pushes.discard()
        sandbox.close()


if __name__ == '__main__':
    main()
