#!/usr/bin/env node
/**
 * Build one installable desktop artifact, from a checkout, in one command.
 *
 *   npm --prefix desktop run package             # host platform, installers
 *   npm --prefix desktop run package -- --dir    # unpacked app, no installer
 *   npm --prefix desktop run package -- --linux  # cross-build the Linux set
 *
 * What makes this a script rather than a line in `package.json`: the artifact
 * needs a payload that no single build command produces. The shell is one
 * program and the engine is another — the repository's own compiled backend,
 * its built UI, and a production-only dependency tree — and the engine has to
 * be assembled into a directory shaped like a checkout before electron-builder
 * can copy it in.
 *
 * Determinism. Every step is a locked or pinned operation: `npm ci` against the
 * committed lockfile, `tsc` and `vite` against committed sources, a file copy,
 * and electron-builder against `electron-builder.yml`. Two runs from one commit
 * produce the same file *contents*; the archives are not byte-identical,
 * because dmg, deb and AppImage all embed timestamps. Nothing here reads the
 * environment for a decision except the tree marker described below.
 *
 * The one decision this script makes: which application id to build under.
 * Plan §10 asks for "appId per tree (public/private suffix)". The tree is
 * identified by the presence of the agent governance directory, which is never
 * published (publication plan §5), so the export tree cannot carry it and a
 * public build cannot accidentally claim the private id. That is a property of
 * the tree, not a flag someone has to remember to pass.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..');
/**
 * The payload is staged one level below the directory electron-builder copies
 * from, and that indirection is load-bearing rather than tidiness.
 * `app-builder-lib/out/util/filter.js` rejects a directory whose path relative
 * to the copy root is exactly `node_modules`, before any filter pattern is
 * consulted — a rule aimed at app sources that no configuration can override.
 * Copying from the parent makes the engine's dependency tree
 * `engine/node_modules`, which that rule does not touch. Get this wrong and the
 * app packages successfully, installs, and dies on its first `require`.
 */
const STAGING_ROOT = path.join(DESKTOP_DIR, 'release', 'payload');
const ARTIFACT_DIR = path.join(DESKTOP_DIR, 'release', 'artifacts');

/** Governance never ships, so its absence is what a public tree looks like. */
const PRIVATE_TREE_MARKER = '.agents';

/** Copied verbatim from the repository root into the staged payload. */
const ENGINE_MANIFESTS = ['package.json', 'package-lock.json'];

/**
 * The `file:` dependencies. npm installs these as symlinks into `vendor/`,
 * which is fine in a checkout and useless in an app bundle: the link target
 * would not be there. They are copied in, installed, then materialized.
 */
const VENDORED_PACKAGES = [
  'node-roon-api',
  'node-roon-api-browse',
  'node-roon-api-image',
  'node-roon-api-transport',
];

/**
 * The layout constants come from the shell's own compiled sources, so the
 * staging step and the runtime resolver cannot drift apart — they are the same
 * module. `createRequire` rather than a bare `import`, because those sources
 * compile to CommonJS and this script is ESM; the interop is unambiguous this
 * way, and a missing build produces a sentence instead of a resolver error.
 */
const requireCompiled = createRequire(import.meta.url);
let packaging;
try {
  packaging = requireCompiled('../dist/packaging.js');
} catch {
  process.stderr.write(
    '[package] FAILED: desktop/dist is not built. Run `npm --prefix desktop run build` first, ' +
      'or use `npm --prefix desktop run package`, which does it for you.\n',
  );
  process.exit(1);
}
const {
  appIdForTree,
  ENGINE_LAYOUT,
  ENGINE_RESOURCE_DIR,
  engineUiBuildPath,
  productNameForTree,
} = packaging;

/** The payload itself, under the name it will carry inside the app's resources. */
const STAGING_DIR = path.join(STAGING_ROOT, ENGINE_RESOURCE_DIR);

function log(message) {
  process.stdout.write(`[package] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[package] FAILED: ${message}\n`);
  process.exit(1);
}

/**
 * npm is a `.cmd` shim on Windows, which `execFileSync` cannot execute bare —
 * the same platform mapping the electron-builder invocation already does; a
 * Windows host died at the very first build step without it (dt7-2).
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd, extraEnv = {}) {
  log(`${command} ${args.join(' ')}   (${path.relative(REPO_ROOT, cwd) || '.'})`);
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function parseArgs(argv) {
  const options = {
    stageOnly: false,
    skipBuilds: false,
    dirOnly: false,
    platforms: [],
    passthrough: [],
  };
  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  options.passthrough = separator === -1 ? [] : argv.slice(separator + 1);

  for (const flag of flags) {
    switch (flag) {
      case '--stage-only':
        options.stageOnly = true;
        break;
      case '--skip-builds':
        options.skipBuilds = true;
        break;
      case '--dir':
        options.dirOnly = true;
        break;
      case '--mac':
      case '--linux':
      case '--win':
        options.platforms.push(flag);
        break;
      default:
        fail(`unknown option ${flag}. See the comment at the top of this file.`);
    }
  }

  if (options.platforms.length === 0) {
    const host = { darwin: '--mac', linux: '--linux', win32: '--win' }[os.platform()];
    if (host === undefined) {
      fail(`no default target for platform ${os.platform()}; pass --mac, --linux or --win.`);
    }
    options.platforms.push(host);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Step 1 — build the three programs.
// ---------------------------------------------------------------------------

function buildEverything(options) {
  if (options.skipBuilds) {
    // A development convenience, and the one thing here that breaks the
    // determinism claim: it packages whatever happens to be on disk.
    log('SKIPPING builds (--skip-builds); packaging whatever is already built');
    return;
  }
  run(NPM, ['run', 'build'], REPO_ROOT);
  run(NPM, ['--prefix', 'ui', 'run', 'build'], REPO_ROOT);
  run(NPM, ['run', 'build'], DESKTOP_DIR);
}

// ---------------------------------------------------------------------------
// Step 2 — stage the engine payload.
// ---------------------------------------------------------------------------

function copyDir(from, to) {
  if (!fs.existsSync(from)) {
    fail(`${path.relative(REPO_ROOT, from)} does not exist. Run the build first.`);
  }
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

/**
 * Replace every symlink under a directory with a real copy of its target.
 *
 * npm links `file:` dependencies rather than copying them, and an installer
 * that carries a link to a path on the build machine is an installer that
 * fails on every other machine. Repeats until nothing is left to replace,
 * because a materialized package can in principle contain links of its own.
 */
function materializeSymlinks(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        found.push(absolute);
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
      }
    }
  };

  let replaced = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    found.length = 0;
    walk(root);
    if (found.length === 0) {
      return replaced;
    }
    for (const link of found) {
      let target;
      try {
        target = fs.realpathSync(link);
      } catch {
        // A link whose target is gone would break the app quietly; drop it.
        fs.rmSync(link, { force: true });
        continue;
      }
      fs.rmSync(link, { force: true, recursive: true });
      fs.cpSync(target, link, { recursive: true, dereference: true });
      replaced += 1;
    }
  }
  fail('symlinks under the staged node_modules did not settle after five passes');
  return replaced;
}

function stageEngine() {
  log(`staging the engine payload into ${path.relative(REPO_ROOT, STAGING_DIR)}`);
  fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  copyDir(path.join(REPO_ROOT, 'dist'), path.join(STAGING_DIR, ENGINE_LAYOUT.compiledBackend));
  copyDir(
    path.join(REPO_ROOT, 'ui', 'build'),
    path.join(STAGING_DIR, ...ENGINE_LAYOUT.uiBuild.split('/')),
  );
  // The vendored packages have to be present under their `file:` path before
  // `npm ci` runs, or the install cannot resolve them at all.
  copyDir(path.join(REPO_ROOT, 'vendor'), path.join(STAGING_DIR, 'vendor'));
  for (const manifest of ENGINE_MANIFESTS) {
    fs.copyFileSync(path.join(REPO_ROOT, manifest), path.join(STAGING_DIR, manifest));
  }

  // Production dependencies only, from the committed lockfile, with no
  // lifecycle scripts: nothing the engine depends on has one, and running
  // arbitrary install hooks inside a release payload is not a thing to do by
  // default.
  run(
    'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    STAGING_DIR,
  );

  const modulesDir = path.join(STAGING_DIR, ENGINE_LAYOUT.nodeModules);
  const materialized = materializeSymlinks(modulesDir);
  log(`materialized ${materialized} symlink(s) under the staged node_modules`);

  // Neither belongs in a shipped payload: `vendor/` is now duplicated inside
  // node_modules, and the lockfile describes an install nobody will repeat.
  fs.rmSync(path.join(STAGING_DIR, 'vendor'), { recursive: true, force: true });
  fs.rmSync(path.join(STAGING_DIR, 'package-lock.json'), { force: true });
}

// ---------------------------------------------------------------------------
// Step 3 — prove the payload before wrapping it in an installer.
// ---------------------------------------------------------------------------

function directorySize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      files += 1;
      bytes += fs.statSync(absolute).size;
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * Everything that has to be true of the payload, checked here rather than
 * discovered by launching the installed app.
 *
 * The UI check is the one worth spelling out: the engine resolves its static
 * assets from its own compiled location, so a payload with the UI in the wrong
 * place produces an app that starts, answers the API, and shows a blank
 * window. `engineUiBuildPath` is the backend's own rule, so this asserts the
 * staged layout against the consumer rather than against a second copy of the
 * expectation.
 */
function verifyStaging() {
  const entry = path.join(STAGING_DIR, ...ENGINE_LAYOUT.entry.split('/'));
  const problems = [];

  if (!fs.existsSync(entry)) {
    problems.push(`the engine entry ${ENGINE_LAYOUT.entry} is missing`);
  }
  const uiIndex = path.join(engineUiBuildPath(entry), 'index.html');
  if (!fs.existsSync(uiIndex)) {
    problems.push(
      `the engine resolves its UI at ${path.relative(STAGING_DIR, path.dirname(uiIndex))}, ` +
        'and there is no index.html there',
    );
  }
  for (const name of VENDORED_PACKAGES) {
    const packageDir = path.join(STAGING_DIR, ENGINE_LAYOUT.nodeModules, name);
    if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
      problems.push(`the vendored package ${name} did not survive the install`);
      continue;
    }
    if (fs.lstatSync(packageDir).isSymbolicLink()) {
      problems.push(`${name} is still a symlink; it would break on any other machine`);
    }
  }
  if (!fs.existsSync(path.join(STAGING_DIR, ENGINE_LAYOUT.manifest))) {
    problems.push('the engine manifest is missing');
  }
  if (fs.existsSync(path.join(STAGING_DIR, 'vendor'))) {
    problems.push('vendor/ is still in the payload; it is duplicated inside node_modules');
  }

  if (problems.length > 0) {
    fail(`the staged payload is not usable:\n  - ${problems.join('\n  - ')}`);
  }

  const size = directorySize(STAGING_DIR);
  log(
    `payload verified: ${String(size.files)} files, ` +
      `${(size.bytes / 1024 / 1024).toFixed(1)} MiB`,
  );
}

// ---------------------------------------------------------------------------
// Step 4 — electron-builder.
// ---------------------------------------------------------------------------

function packageApp(options) {
  const privateTree = fs.existsSync(path.join(REPO_ROOT, PRIVATE_TREE_MARKER));
  const appId = appIdForTree(privateTree);
  // The name splits with the id (dt7-1): Electron derives userData — and the
  // macOS single-instance lock — from the product name, so two builds sharing
  // "Songr" would share settings and could not run side by side.
  const productName = productNameForTree(privateTree);
  log(`${privateTree ? 'private' : 'public'} tree: building ${productName} as ${appId}`);

  const builder = path.join(
    DESKTOP_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
  );
  if (!fs.existsSync(builder)) {
    fail('electron-builder is not installed. Run `npm --prefix desktop install` first.');
  }

  const args = [
    '--config',
    'electron-builder.yml',
    `--config.appId=${appId}`,
    `--config.productName=${productName}`,
    '--publish',
    'never',
    ...options.platforms,
    ...(options.dirOnly ? ['--dir'] : []),
    ...options.passthrough,
  ];
  run(builder, args, DESKTOP_DIR, {
    // Belt and braces with `mac.identity: null`: this is what stops
    // electron-builder from finding a signing identity in the local keychain
    // and producing an artifact nobody else can reproduce.
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  });
}

function reportArtifacts() {
  if (!fs.existsSync(ARTIFACT_DIR)) {
    return;
  }
  log('artifacts:');
  for (const entry of fs.readdirSync(ARTIFACT_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const bytes = fs.statSync(path.join(ARTIFACT_DIR, entry.name)).size;
    log(`  ${entry.name}  ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  buildEverything(options);
  stageEngine();
  verifyStaging();
  if (options.stageOnly) {
    log('--stage-only: the payload is ready; electron-builder was not run');
    return;
  }
  packageApp(options);
  reportArtifacts();
}

main();

