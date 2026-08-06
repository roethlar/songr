/**
 * The packaged layout, as data.
 *
 * Three different programs have to agree about where the engine's files sit
 * once the app is an installer artifact rather than a checkout:
 *
 *   - `engineConfig.ts` (runtime) resolves the entry file the shell forks;
 *   - `scripts/package-app.mjs` (build time) stages those files;
 *   - the engine itself resolves its own UI assets, relative to its own code.
 *
 * They agree because all three read this module. Nothing here touches the
 * filesystem or Electron, so the layout is unit-testable on its own, and a
 * change to it fails a test rather than producing an app that starts and then
 * serves a blank page.
 *
 * Nothing in this file is specific to the private tree. It is deliberately
 * plain: the desktop shell is product code that ships in both trees.
 */

import path from 'path';

/**
 * Directory name of the engine payload inside the packaged app's resources.
 *
 * electron-builder copies it there via `extraResources`, which puts it
 * *beside* `app.asar` rather than inside it. That is required, not a
 * preference: the engine is forked as a plain Node program, and Node cannot
 * `require` its way into an asar archive from a child process.
 */
export const ENGINE_RESOURCE_DIR = 'engine';

/**
 * The engine payload's internal layout, relative to its own root.
 *
 * `entry` and `uiBuild` are not free choices. The compiled backend resolves its
 * static assets from its own location (see `engineUiBuildPath`), so `dist/` and
 * `ui/build/` have to be siblings, exactly as they are in a checkout. Keeping
 * the packaged tree shaped like the checkout is what lets one code path serve
 * both.
 */
export const ENGINE_LAYOUT = {
  /** Node entry file the shell forks. */
  entry: 'dist/index.js',
  /** Compiled backend, the repository's own `npm run build` output. */
  compiledBackend: 'dist',
  /** Built SvelteKit static site, the repository's `ui/build`. */
  uiBuild: 'ui/build',
  /** Production-only dependency tree, vendored packages materialized. */
  nodeModules: 'node_modules',
  /** The backend's manifest, so the child sees the same package metadata. */
  manifest: 'package.json',
} as const;

/** Absolute path to the engine payload root inside a packaged app. */
export function packagedEngineRoot(resourcesPath: string): string {
  return path.join(resourcesPath, ENGINE_RESOURCE_DIR);
}

/** Absolute path to the engine entry file inside a packaged app. */
export function packagedEngineEntry(resourcesPath: string): string {
  return path.join(packagedEngineRoot(resourcesPath), ...ENGINE_LAYOUT.entry.split('/'));
}

/**
 * Where the engine will look for the built UI, given its entry file.
 *
 * A mirror of the backend's own rule, the same way `engineProcess.ts` mirrors
 * the handshake message: the desktop workspace compiles on its own and must not
 * pull backend sources into its build, so the two are a contract. The backend
 * side is `src/server/http/app.ts`, which resolves
 * `path.join(__dirname, "../../../ui/build")` from the compiled
 * `dist/server/http/` directory unless `UI_BUILD_PATH` overrides it.
 *
 * The staging step asserts its own output against this function. Without that
 * assertion a layout drift produces an app that launches, serves the API and
 * shows nothing — the most expensive kind of packaging bug to diagnose.
 */
export function engineUiBuildPath(entryPath: string): string {
  const compiledRoot = path.dirname(entryPath);
  return path.resolve(compiledRoot, 'server', 'http', '..', '..', '..', 'ui', 'build');
}

/**
 * Public application name. Plan §10's stated default, flagged there for the
 * owner: "Public app name/id defaults: productName Songr".
 */
export const PRODUCT_NAME = 'Songr';

/**
 * Public application id. Plan §10's stated default, and the literal that lives
 * in `electron-builder.yml` so a plain `electron-builder` run outside the build
 * script still produces the public identity.
 */
export const PUBLIC_APP_ID = 'app.songr.desktop';

/**
 * Suffix the private tree's build appends. Plan §10 asks for "appId per tree
 * (public/private suffix)": two installed apps that do not collide in the
 * operating system's application registry, so the owner can run their own
 * build beside a public release without either one shadowing the other.
 */
export const PRIVATE_APP_ID_SUFFIX = '.private';

/**
 * The application id for a tree.
 *
 * `privateTree` is decided by the caller from a marker the export pipeline
 * cannot carry (see `scripts/package-app.mjs`), never by a build-time flag: an
 * artifact's identity should follow from what was built, not from what the
 * person building it remembered to type.
 */
export function appIdForTree(privateTree: boolean): string {
  return privateTree ? `${PUBLIC_APP_ID}${PRIVATE_APP_ID_SUFFIX}` : PUBLIC_APP_ID;
}

/**
 * The product name for a tree.
 *
 * The name has to split with the id, not just the id (dt7-1): Electron derives
 * `userData` from the product name, and macOS's single-instance lock lives in
 * that directory — two builds sharing "Songr" would share settings, engine
 * CONFIG_DIR/DATA_DIR and the instance lock, so the private build could not
 * run beside a public release, which is the entire point of the split.
 * Owner-vetoable naming, same as the id.
 */
export function productNameForTree(privateTree: boolean): string {
  return privateTree ? `${PRODUCT_NAME} Private` : PRODUCT_NAME;
}
