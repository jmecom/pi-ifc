import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readScopes, type ConfidentialityScope } from './ifc.ts';

export type PushDestination = {
  url: string;
  branch: string;
  allowedScopes: readonly ConfidentialityScope[];
};

export type Preferences = {
  push?: PushDestination;
  debug?: boolean;
};

export type Runtime = Preferences & {
  workspace: string;
  state: string;
  worker: string;
  python: string;
  protected: string[];
  savePreferences: () => void;
  release: () => void;
};

export function inside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);

  if (relativePath === '') {
    return true;
  }

  return relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !relativePath.startsWith(sep);
}

function acquireWorkspaceLock(stateDirectory: string): () => void {
  const lockPath = join(stateDirectory, 'running');

  // Two Pi processes sharing this file could overwrite each other's label
  // changes. The tool queue only protects calls within one process.
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) {
      throw new Error('Invalid IFC workspace lock.');
    }

    let processIsRunning = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
      processIsRunning = false;
    }

    if (processIsRunning) {
      throw new Error('This workspace already has an IFC session running.');
    }

    rmSync(lockPath);
  }

  writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });

  function release() {
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === String(process.pid)) {
      rmSync(lockPath);
    }
    process.removeListener('exit', release);
  }

  process.on('exit', release);
  return release;
}

function readPreferences(filename: string): Preferences {
  const preferences: Preferences = existsSync(filename)
    ? JSON.parse(readFileSync(filename, 'utf8'))
    : {};

  if (preferences.debug !== undefined && typeof preferences.debug !== 'boolean') {
    throw new Error('Invalid IFC debug setting.');
  }

  if (preferences.push) {
    const hasValidFields = typeof preferences.push.url === 'string'
      && typeof preferences.push.branch === 'string';

    if (!hasValidFields) {
      throw new Error('Invalid IFC push settings.');
    }

    preferences.push.allowedScopes = readScopes(preferences.push.allowedScopes);
  }

  return preferences;
}

export function startRuntime(cwd: string, sessionDirectory: string): Runtime {
  const extensionDirectory = dirname(fileURLToPath(import.meta.url));
  const workspace = realpathSync(cwd);
  const workspaceId = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  const stateDirectory = join(homedir(), '.local', 'state', 'pi-ifc', workspaceId);

  const configuredProfile = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const profilePath = configuredProfile.replace(/^~(?=\/|$)/, homedir());
  const profile = existsSync(profilePath) ? realpathSync(profilePath) : resolve(profilePath);

  const sessionPaths: string[] = [];
  if (sessionDirectory) {
    const path = existsSync(sessionDirectory)
      ? realpathSync(sessionDirectory)
      : resolve(sessionDirectory);
    sessionPaths.push(path);
  }

  const protectedPaths = [stateDirectory, profile, ...sessionPaths];
  if (protectedPaths.some(path => inside(workspace, path))) {
    throw new Error('The workspace cannot contain IFC state, Pi credentials, or Pi sessions.');
  }

  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const release = acquireWorkspaceLock(stateDirectory);

  try {
    // The live workers use these copies. Editing the project cannot rewrite
    // their code before the user reloads the extension.
    const workerDirectory = join(stateDirectory, 'runtime');
    mkdirSync(workerDirectory, { recursive: true, mode: 0o700 });

    for (const filename of ['sandbox.py', 'git_push.py']) {
      copyFileSync(join(extensionDirectory, filename), join(workerDirectory, filename));
    }

    const python = spawnSync(
      'python3',
      ['-I', '-S', '-c', 'import sys; assert sys.version_info >= (3, 10); print(sys.executable)'],
      { encoding: 'utf8' },
    );
    if (python.status !== 0) {
      throw new Error('Python 3.10+ must be available as python3.');
    }

    const preferencesPath = join(stateDirectory, 'preferences.json');
    const preferences = readPreferences(preferencesPath);
    const dependenciesPath = join(extensionDirectory, 'node_modules');

    if (existsSync(dependenciesPath)) {
      protectedPaths.push(realpathSync(dependenciesPath));
    }

    const runtime: Runtime = {
      ...preferences,
      workspace,
      state: stateDirectory,
      worker: join(workerDirectory, 'sandbox.py'),
      python: python.stdout.trim(),
      protected: protectedPaths,
      savePreferences() {
        const currentPreferences = { push: runtime.push, debug: runtime.debug };
        writeFileSync(preferencesPath, JSON.stringify(currentPreferences), { mode: 0o600 });
      },
      release,
    };

    return runtime;
  } catch (error) {
    release();
    throw error;
  }
}
