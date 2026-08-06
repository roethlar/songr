/**
 * The Node-side implementation of the lifecycle's `spawn` port.
 *
 * Why `child_process.fork` and not Electron's `utilityProcess.fork`: the
 * backend answers the port handshake through `process.send` (see the repository's
 * `src/server/listeningHandshake.ts`). A `utilityProcess` child does not get
 * `process.send` — it gets `process.parentPort.postMessage`, a different channel
 * (`electron.d.ts`: "Emitted when the child process sends a message using
 * `process.parentPort.postMessage()`"). Using it would mean a second, shell-only
 * handshake path in the backend. `child_process.fork` from the Electron main
 * process re-executes the Electron binary with `ELECTRON_RUN_AS_NODE`, giving a
 * plain Node child with a plain Node IPC channel, which is exactly what the
 * existing contract expects.
 */

import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';

import type { EngineCallbacks, EngineHandle, SpawnEngine } from './engineLifecycle';
import type { EngineLaunchPlan } from './engineConfig';

/**
 * Mirror of the backend's handshake message.
 *
 * Canonical definition: `src/server/listeningHandshake.ts` in the repository
 * root. It is mirrored rather than imported because the desktop workspace
 * compiles on its own and must not pull backend sources into its build; the two
 * are a wire contract, so a change there is a change here.
 */
const LISTENING_MESSAGE_TYPE = 'listening';

interface ListeningMessage {
  readonly type: typeof LISTENING_MESSAGE_TYPE;
  readonly port: number;
}

export function asListeningMessage(message: unknown): ListeningMessage | null {
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const candidate = message as { type?: unknown; port?: unknown };
  if (candidate.type !== LISTENING_MESSAGE_TYPE) {
    return null;
  }
  if (typeof candidate.port !== 'number' || !Number.isInteger(candidate.port)) {
    return null;
  }
  // A TCP port outside 1-65535 cannot be loaded; treating such a message as
  // noise lets the supervisor's listen timeout reach its error state instead
  // of parking `running` on an unloadable URL (dt2-3).
  if (candidate.port < 1 || candidate.port > 65535) {
    return null;
  }
  return { type: LISTENING_MESSAGE_TYPE, port: candidate.port };
}

export interface EngineSpawnerOptions {
  readonly plan: EngineLaunchPlan;
  /** Where the engine's stdout/stderr go. Defaults to the shell's console. */
  readonly log?: (line: string) => void;
}

function pipeOutput(child: ChildProcess, log: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') {
          log(line);
        }
      }
    });
  }
}

/** Build the `spawn` port the supervisor calls for each launch attempt. */
export function createEngineSpawner(options: EngineSpawnerOptions): SpawnEngine {
  const { plan } = options;
  const log =
    options.log ??
    ((line: string) => {
      console.log(`[engine] ${line}`);
    });

  return (callbacks: EngineCallbacks): EngineHandle => {
    const child = fork(plan.entryPath, [], {
      cwd: plan.cwd,
      env: plan.env,
      // An explicit `ipc` slot is what gives the child `process.send`; piping
      // the other two keeps engine logs visible in the shell's terminal.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    pipeOutput(child, log);

    child.on('message', (message: unknown) => {
      const listening = asListeningMessage(message);
      if (listening !== null) {
        callbacks.onListening(listening.port);
      }
    });

    child.on('error', (error: Error) => {
      callbacks.onError(error);
    });

    child.on('exit', (code, signal) => {
      callbacks.onExit({ code, signal });
    });

    return {
      requestShutdown: () => {
        // The backend installs SIGTERM/SIGINT handlers that close the HTTP
        // server and Roon subscriptions before exiting. On Windows there are no
        // POSIX signals and this terminates the child outright; the grace-period
        // kill below is then a no-op.
        child.kill('SIGTERM');
      },
      forceKill: () => {
        child.kill('SIGKILL');
      },
    };
  };
}
