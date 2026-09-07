import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const split = process.argv.indexOf('--', 2);
const { values } = parseArgs({
  args: process.argv.slice(2, split < 0 ? undefined : split),
  options: {
    workspace: { type: 'string', default: process.cwd() },
    'push-url': { type: 'string' },
    'push-branch': { type: 'string' },
    'private-remote': { type: 'boolean', default: false },
    python: { type: 'string', default: 'python3' },
    refresh: { type: 'boolean', default: false },
    debug: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log('npm start -- --workspace PATH [--push-url SSH_URL --push-branch BRANCH] [--private-remote] [--debug] [--refresh] [-- PI_OPTIONS]\nmacOS; Python 3.10+. Push destinations are public unless explicitly marked private.');
  process.exit(0);
}

if (!!values['push-url'] !== !!values['push-branch'] || (values['private-remote'] && !values['push-url'])) {
  throw new Error('Configure both --push-url SSH_URL and --push-branch BRANCH. --private-remote applies to that destination.');
}

const workspace = realpathSync(resolve(values.workspace));
const key = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
const state = join(homedir(), '.local', 'state', 'pi-ifc', key);
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
};
if (inside(workspace, state)) throw new Error('Choose a project workspace that does not contain ~/.local/state/pi-ifc.');
const agentDir = (process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')).replace(/^~(?=\/|$)/, homedir());
const profile = existsSync(agentDir) ? realpathSync(agentDir) : resolve(agentDir);
if (inside(workspace, profile)) throw new Error('The workspace cannot contain your Pi profile and credentials.');
mkdirSync(state, { recursive: true, mode: 0o700 });

const lock = join(state, 'running');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  try { process.kill(pid, 0); throw new Error('This workspace already has a Pi IFC session running.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  rmSync(lock);
}
const descriptor = openSync(lock, 'wx', 0o600);
writeFileSync(descriptor, String(process.pid));
closeSync(descriptor);
process.on('exit', () => rmSync(lock, { force: true }));

const control = join(state, 'control');
const runtime = join(state, 'runtime');
mkdirSync(control, { recursive: true, mode: 0o700 });
mkdirSync(runtime, { recursive: true, mode: 0o700 });
for (const file of ['extension.ts', 'sandbox.py', 'git_push.py']) {
  if (values.refresh || !existsSync(join(runtime, file))) copyFileSync(join(root, file), join(runtime, file));
}
if (!existsSync(join(runtime, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(runtime, 'node_modules'));

const python = spawnSync(values.python, ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
if (python.status !== 0) throw new Error('Python 3.10+ is required. Use --python /path/to/python.');
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: profile,
  PI_CODING_AGENT_SESSION_DIR: join(state, 'sessions'),
  PI_IFC_CONFIG: JSON.stringify({
    workspace, state, control, debug: values.debug,
    push: values['push-url'] ? { url: values['push-url'], branch: values['push-branch'], private: values['private-remote'] } : undefined,
    python: python.stdout.trim(), dependencies: realpathSync(join(root, 'node_modules')),
  }),
};
const forwarded = split < 0 ? [] : process.argv.slice(split + 1);
const optionsWithValues = new Set(['--provider', '--model', '--thinking', '--mode']);
const switches = new Set(['--continue', '-c', '--resume', '-r', '--print', '-p', '--no-session', '--verbose']);
for (let i = 0; i < forwarded.length; i++) {
  const argument = forwarded[i];
  if (optionsWithValues.has(argument)) {
    const value = forwarded[++i];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${argument}.`);
    if (argument === '--mode' && value !== 'json') throw new Error('Only interactive and JSON/print modes are supported; Pi RPC bash bypasses extension hooks.');
  } else if (argument.startsWith('-') && !switches.has(argument)) {
    throw new Error(`Unsupported Pi option: ${argument}. This launcher fixes tool and extension loading.`);
  } else if (argument.startsWith('@')) {
    throw new Error('Use read for file inputs so IFC labels them.');
  }
}
const child = spawn(process.execPath, [
  join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
  '--no-builtin-tools', '--no-extensions', '-e', join(runtime, 'extension.ts'),
  '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes',
  '--provider', 'openai', '--model', process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  ...forwarded,
], { cwd: control, env, stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
