#!/usr/bin/env node
/**
 * Verify the Windows installer that `package-app.mjs --win` just built, before
 * anything uploads it.
 *
 *   node desktop/scripts/verify-windows-installer.mjs
 *
 * Songr's Windows installer ships unsigned (owner decision, 2026-10-23), so
 * this asserts that no signature is present instead of checking a valid one,
 * and proves the installer carries this checkout's build:
 *
 *  - exactly one installer, `Songr Setup <version>.exe`;
 *  - no Authenticode signature on the installer or on the Songr.exe inside it
 *    (an empty PE security directory). Signing that happens by accident fails
 *    here: given CSC_LINK, electron-builder signs Windows binaries with
 *    whatever certificate that names;
 *  - Songr.exe's version resource names Songr at this version;
 *  - the shell (app.asar) and engine manifests are `songr` at this version,
 *    and the engine's `engines.node` is the root manifest's;
 *  - the engine UI revision is this checkout's commit;
 *  - the engine inside the installer is file-for-file identical to the
 *    payload `package-app.mjs` staged and verified in `desktop/release/payload`.
 *
 * It reads only: neither the installer nor the application runs. 7-Zip opens
 * the NSIS installer and the PE resources: SEVEN_ZIP if set, else its default
 * install path (present on GitHub's Windows runners), else `7z` on PATH.
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
const ARTIFACT_DIR = path.join(DESKTOP_DIR, 'release', 'artifacts');
const STAGED_ENGINE = path.join(DESKTOP_DIR, 'release', 'payload', 'engine');
const DEFAULT_SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';
const SEVEN_ZIP =
  process.env.SEVEN_ZIP || (fs.existsSync(DEFAULT_SEVEN_ZIP) ? DEFAULT_SEVEN_ZIP : '7z');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const version = readJson(path.join(DESKTOP_DIR, 'package.json')).version;
const nodeEngines = readJson(path.join(REPO_ROOT, 'package.json')).engines?.node;

function log(message) {
  process.stdout.write(`[verify-windows] ${message}\n`);
}

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sevenZip(args) {
  execFileSync(SEVEN_ZIP, ['x', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function walk(root, dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(root, absolute);
    return [path.relative(root, absolute).split(path.sep).join('/')];
  });
}

/** PE data directory 4 is the security (Authenticode) directory: [offset, size]. */
function securityDirectory(file) {
  const data = fs.readFileSync(file);
  const pe = data.readUInt32LE(0x3c);
  check(data.toString('latin1', pe, pe + 4) === 'PE\0\0', `${path.basename(file)} is not a PE file`);
  const optional = pe + 24;
  const magic = data.readUInt16LE(optional);
  check(magic === 0x10b || magic === 0x20b, `${path.basename(file)} has an unknown optional header`);
  const directories = optional + (magic === 0x10b ? 96 : 112);
  return [data.readUInt32LE(directories + 32), data.readUInt32LE(directories + 36)];
}

function assertUnsigned(file) {
  const [offset, size] = securityDirectory(file);
  check(
    offset === 0 && size === 0,
    `${path.basename(file)} carries a signature (security directory ${offset}, ${size}); ` +
      'the Windows installer ships unsigned',
  );
}

function versionResource(exe, scratch) {
  const out = path.join(scratch, 'rsrc');
  sevenZip([`-o${out}`, exe, '-r', 'version.txt']);
  const found = walk(out).find((name) => name.endsWith('version.txt'));
  check(found, 'Songr.exe has no version resource');
  const raw = fs.readFileSync(path.join(out, found));
  const text =
    (raw[0] === 0xff && raw[1] === 0xfe) || raw.subarray(0, 4).includes(0)
      ? raw.toString('utf16le')
      : raw.toString('utf8');
  return Object.fromEntries(
    [...text.matchAll(/VALUE\s+"([^"]+)",\s*"([^"]*)"/g)].map((m) => [m[1], m[2].replace(/\0/g, '')]),
  );
}

function main() {
  check(typeof nodeEngines === 'string' && nodeEngines.length > 0, 'root package.json has no engines.node');
  check(fs.existsSync(STAGED_ENGINE), `no staged payload at ${path.relative(REPO_ROOT, STAGED_ENGINE)}`);

  const installers = fs
    .readdirSync(ARTIFACT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => entry.name);
  const expected = `Songr Setup ${version}.exe`;
  check(
    installers.length === 1 && installers[0] === expected,
    `expected exactly ${expected} in ${path.relative(REPO_ROOT, ARTIFACT_DIR)}, found [${installers.join(', ')}]`,
  );
  const installer = path.join(ARTIFACT_DIR, expected);
  assertUnsigned(installer);
  log(`${expected}: no signature`);

  const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'songr-win-verify-'));
  try {
    const unpacked = path.join(scratch, 'installer');
    sevenZip([`-o${unpacked}`, installer]);
    const appArchive = walk(unpacked).find((name) => name.endsWith('/app-64.7z'));
    check(appArchive, 'the installer has no app-64.7z payload');
    const app = path.join(scratch, 'app');
    sevenZip([`-o${app}`, path.join(unpacked, appArchive)]);

    const songrExe = path.join(app, 'Songr.exe');
    check(fs.existsSync(songrExe), 'the installer has no Songr.exe');
    assertUnsigned(songrExe);
    log('Songr.exe: no signature');

    const resource = versionResource(songrExe, scratch);
    check(
      resource.ProductName === 'Songr' &&
        resource.FileDescription === 'Songr' &&
        (resource.ProductVersion ?? '').startsWith(version),
      `Songr.exe version resource is ${JSON.stringify(resource)}`,
    );
    log(`version resource: ${resource.ProductName} ${resource.ProductVersion}`);

    const asar = createRequire(path.join(DESKTOP_DIR, 'package.json'))('@electron/asar');
    const shell = JSON.parse(
      asar.extractFile(path.join(app, 'resources', 'app.asar'), 'package.json').toString('utf8'),
    );
    check(shell.name === 'songr' && shell.version === version, `shell is ${shell.name} ${shell.version}`);

    const engine = path.join(app, 'resources', 'engine');
    const manifest = readJson(path.join(engine, 'package.json'));
    check(
      manifest.name === 'songr' && manifest.version === version,
      `engine is ${manifest.name} ${manifest.version}`,
    );
    check(
      manifest.engines?.node === nodeEngines,
      `engine engines.node is ${manifest.engines?.node}, root is ${nodeEngines}`,
    );
    log(`shell and engine: songr ${version}, engines.node ${nodeEngines}`);

    const revision = readJson(path.join(engine, 'ui', 'build', '_app', 'version.json')).version;
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT })
      .toString()
      .trim();
    check(revision === commit, `engine UI revision is ${revision}, checkout is ${commit}`);
    log(`UI revision: ${revision}`);

    const staged = walk(STAGED_ENGINE).sort();
    const stagedSet = new Set(staged);
    const shipped = new Set(walk(engine));
    const missing = staged.filter((name) => !shipped.has(name));
    const extra = [...shipped].filter((name) => !stagedSet.has(name));
    const differing = staged.filter(
      (name) =>
        shipped.has(name) &&
        !fs.readFileSync(path.join(STAGED_ENGINE, name)).equals(fs.readFileSync(path.join(engine, name))),
    );
    check(
      missing.length === 0 && extra.length === 0 && differing.length === 0,
      `the installer's engine differs from the staged payload: ` +
        `missing [${missing.slice(0, 10).join(', ')}], extra [${extra.slice(0, 10).join(', ')}], ` +
        `different [${differing.slice(0, 10).join(', ')}]`,
    );
    log(`engine payload: ${String(staged.length)} files identical to the staged payload`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  log(`verified unsigned ${expected}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[verify-windows] FAILED: ${error.message}\n`);
  process.exit(1);
}
