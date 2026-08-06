/**
 * Where the engine lives and what environment it runs under. Pure functions —
 * no Electron, no filesystem — so the launch contract is unit-testable.
 *
 * The engine is the repository's own compiled backend (`dist/index.js`). During
 * development it sits next to this workspace; once the app is packaged it is an
 * `extraResources` payload beside `app.asar`. Those are the two locations, and
 * `EngineLocation` makes the caller say which one it is in rather than letting
 * a path guess.
 */

import path from 'path';

import { packagedEngineEntry } from './packaging';

/** Overrides the resolved engine entry file. Set by packaging, and by hand. */
export const ENGINE_ENTRY_ENV = 'ROON_CONTROLLER_ENGINE_ENTRY';

/**
 * Loopback only. The desktop app's engine is private to the machine it runs on;
 * a LAN-visible bind is a separate, opt-in setting (plan §1), not a default.
 */
export const ENGINE_HOST = '127.0.0.1';

/**
 * The bind address the opt-in "serve on the local network" setting uses. Same
 * posture as the appliance install, caveats included: there is no
 * authentication, so this is a trusted-LAN choice the user makes explicitly.
 */
export const NETWORK_BIND_HOST = '0.0.0.0';

export interface EngineLaunchPlan {
  /** Absolute path to the Node entry file the shell forks. */
  readonly entryPath: string;
  /** Working directory for the child. */
  readonly cwd: string;
  /** Full environment for the child. */
  readonly env: Record<string, string>;
}

/**
 * Which of the two engine locations this process is running against.
 *
 * A discriminated union rather than an `isPackaged` boolean plus a nullable
 * path, because the two modes need different information and neither one's
 * field is meaningful in the other. A packaged app whose `resourcesPath` went
 * missing is not a state this type can express, so there is no confusing
 * fallback to write: the dev path resolving inside a packaged app's `Resources`
 * directory would produce an ENOENT four levels away from its cause.
 */
export type EngineLocation =
  | {
      readonly kind: 'dev';
      /**
       * The desktop workspace root — the directory holding this app's
       * `package.json`. The engine is its sibling `../dist/index.js`.
       */
      readonly appRoot: string;
    }
  | {
      readonly kind: 'packaged';
      /** Electron's `process.resourcesPath`. */
      readonly resourcesPath: string;
    };

export interface EnginePlanInput {
  readonly location: EngineLocation;
  /** Per-user writable base directory (`app.getPath('userData')`). */
  readonly userDataDir: string;
  /** The shell's own environment, used as the base for the child's. */
  readonly parentEnv: NodeJS.ProcessEnv;
  /**
   * The two shell settings that change how the engine binds. Absent means the
   * defaults, which is the loopback/ephemeral behaviour every normal run gets.
   */
  readonly settings?: EngineBindSettings;
}

/** The slice of `ShellSettings` that reaches the engine's environment. */
export interface EngineBindSettings {
  readonly serveOnNetwork: boolean;
  readonly networkPort: number;
}

/**
 * Resolve the engine entry file.
 *
 * Precedence, highest first:
 *
 *   1. `ROON_CONTROLLER_ENGINE_ENTRY`, so any build can be pointed at any
 *      engine by hand — the dev-run escape hatch documented in `README.md`,
 *      and the only way to test a packaged shell against a checkout.
 *   2. Packaged: the `extraResources` payload under `process.resourcesPath`.
 *   3. Dev: the repository build one level up from the desktop workspace.
 *
 * The override stays above the packaged branch on purpose. It is the mechanism
 * that made the packaged layout testable before the packaged layout existed,
 * and a build that cannot be pointed somewhere else is harder to diagnose in
 * the field, where there is no terminal and no checkout.
 */
export function resolveEngineEntry(
  location: EngineLocation,
  parentEnv: NodeJS.ProcessEnv,
): string {
  const override = parentEnv[ENGINE_ENTRY_ENV];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override.trim());
  }
  if (location.kind === 'packaged') {
    return packagedEngineEntry(location.resourcesPath);
  }
  return path.resolve(location.appRoot, '..', 'dist', 'index.js');
}

/**
 * Build the whole launch plan.
 *
 * `PORT=0` asks the OS for a free port and makes the `listening` handshake the
 * only way to learn it — which is the point: no fixed port to collide with the
 * appliance install or a second copy of anything. `CONFIG_DIR` and `DATA_DIR`
 * move the engine's pairing state and caches under the per-user app directory,
 * so the desktop app never writes into the checkout it was launched from.
 *
 * "Serve on the local network" is the one thing that changes that: a LAN client
 * cannot discover an ephemeral port, so the setting trades the ephemeral
 * loopback bind for a fixed one on every interface. It changes **only** these
 * two environment variables — the backend already honours `HOST` and `PORT`,
 * and the handshake still reports the bound port, so the window and the tray
 * keep reaching the engine over loopback exactly as before.
 */
export function buildEngineLaunchPlan(input: EnginePlanInput): EngineLaunchPlan {
  const entryPath = resolveEngineEntry(input.location, input.parentEnv);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const networkServe =
    input.settings !== undefined && input.settings.serveOnNetwork
      ? input.settings
      : null;
  env.PORT = networkServe === null ? '0' : String(networkServe.networkPort);
  env.HOST = networkServe === null ? ENGINE_HOST : NETWORK_BIND_HOST;
  env.CONFIG_DIR = path.join(input.userDataDir, 'config');
  env.DATA_DIR = path.join(input.userDataDir, 'data');

  if (input.location.kind === 'packaged') {
    // A packaged payload carries production dependencies only, and the
    // engine's logger reaches for the `pino-pretty` transport unless it is
    // told it is in production — a devDependency, so the child died on its
    // first log line with an error four levels below the real cause. Found by
    // launching the packaged app, not by any test, which is why the packaged
    // smoke run is part of this slice rather than optional.
    //
    // Not set in a dev run: a checkout has `pino-pretty`, and readable logs
    // are the whole point of running from one.
    env.NODE_ENV = 'production';
  }

  return {
    entryPath,
    // The engine's own package root, two levels up from `dist/index.js`: the
    // repository root in a dev run, the `extraResources` payload root in a
    // packaged one. The engine resolves its UI assets relative to its own file
    // rather than to the cwd, but a predictable cwd keeps relative paths in
    // dotenv and logs sane, and it is where the production `node_modules` sits.
    cwd: path.dirname(path.dirname(entryPath)),
    env,
  };
}

/** The URL the window loads once the engine reports its port. */
export function engineUrl(port: number): string {
  return `http://${ENGINE_HOST}:${String(port)}`;
}
