#!/usr/bin/env node
// Patches an extracted songr-server-<version>/ payload into a publishable npm
// package and (unless --dry-run) publishes it. See README.md in this
// directory for why bundledDependencies is required here, not ordinary
// dependencies, and what was proven about it empirically.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--dir') {
      out.dir = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/** Top-level node_modules entry names, expanding one level for @scope/pkg. */
function topLevelDependencyNames(dir) {
  const root = join(dir, 'node_modules');
  const names = [];
  for (const entry of readdirSync(root)) {
    if (entry === '.bin' || entry === '.package-lock.json') continue;
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(join(root, entry))) {
        names.push(`${entry}/${sub}`);
      }
    } else {
      names.push(entry);
    }
  }
  return names.sort();
}

function patchPackageJson(dir) {
  const path = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (pkg.name !== 'songr') {
    throw new Error(`expected the payload's package.json name to be "songr", got "${pkg.name}"`);
  }
  pkg.name = 'songr-server';
  pkg.description =
    'Headless engine for Songr, a Roon controller. Runs the same backend and web UI as the Songr desktop app, without Electron.';
  pkg.bin = { 'songr-server': 'bin/songr-server.js' };
  pkg.bundledDependencies = topLevelDependencyNames(dir);
  delete pkg.devDependencies;
  pkg.scripts = { start: 'node dist/index.js' };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg;
}

function writeBinWrapper(dir) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const wrapperPath = join(binDir, 'songr-server.js');
  writeFileSync(wrapperPath, '#!/usr/bin/env node\nrequire("../dist/index.js");\n');
  chmodSync(wrapperPath, 0o755);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) throw new Error('--dir <extracted songr-server-VERSION directory> is required');

  const pkg = patchPackageJson(args.dir);
  writeBinWrapper(args.dir);

  const publishArgs = ['publish'];
  if (args.dryRun) publishArgs.push('--dry-run');
  const result = spawnSync('npm', publishArgs, { cwd: args.dir, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);

  process.stdout.write(`${args.dryRun ? 'dry-run packed' : 'published'}: ${pkg.name}@${pkg.version}\n`);
}

main();
