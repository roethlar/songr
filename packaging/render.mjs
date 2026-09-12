#!/usr/bin/env node
// Renders every package-manager manifest from the templates beside this file.
//
// Checksums are never typed by a human and never carried from one release to
// the next: they are read from the SHA256SUMS asset the release workflow
// computes over the artifacts it just uploaded. A template that still holds a
// placeholder after substitution is a hard failure, so a renamed asset breaks
// the release loudly instead of publishing a manifest with "@SHA256_...@" in
// the hash field.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'check') {
      out.check = true;
      continue;
    }
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

/**
 * Maps a release's asset names onto placeholder names. Keyed by version
 * because every asset name embeds it.
 */
function assetPlaceholders(version) {
  return {
    [`Songr-${version}-arm64.dmg`]: 'SHA256_DMG_ARM64',
    [`Songr-${version}.dmg`]: 'SHA256_DMG_X64',
    [`Songr.Setup.${version}.exe`]: 'SHA256_EXE_X64',
    [`songr_${version}_amd64.deb`]: 'SHA256_DEB_AMD64',
    [`songr_${version}_arm64.deb`]: 'SHA256_DEB_ARM64',
  };
}

/** Reads `<sha256>  <name>` lines, the shasum/sha256sum output format. */
function readSums(path) {
  const sums = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

function buildSubstitutions(version, date, sums) {
  const values = { VERSION: version, RELEASE_DATE: date };
  const missing = [];
  for (const [asset, name] of Object.entries(assetPlaceholders(version))) {
    const hash = sums.get(asset);
    if (!hash) {
      missing.push(asset);
      continue;
    }
    values[name] = hash;
    values[`${name}_UPPER`] = hash.toUpperCase();
  }
  if (missing.length) {
    throw new Error(`SHA256SUMS is missing these release assets: ${missing.join(', ')}`);
  }
  return values;
}

function substitute(text, values, sourceLabel) {
  const rendered = text.replace(/@([A-Z0-9_]+)@/g, (whole, key) => {
    if (!(key in values)) throw new Error(`${sourceLabel}: no value for ${whole}`);
    return values[key];
  });
  const leftover = /@[A-Z0-9_]+@/.exec(rendered);
  if (leftover) throw new Error(`${sourceLabel}: unsubstituted placeholder ${leftover[0]}`);
  return rendered;
}

/** Template path relative to this directory → path relative to the output root. */
function outputPlan(version) {
  const wingetDir = `winget/manifests/r/Roethlar/Songr/${version}`;
  return [
    ['homebrew/songr.rb', 'homebrew/Casks/songr.rb'],
    ['scoop/songr.json', 'scoop/bucket/songr.json'],
    ['aur/PKGBUILD', 'aur/PKGBUILD'],
    ['winget/Roethlar.Songr.yaml', `${wingetDir}/Roethlar.Songr.yaml`],
    ['winget/Roethlar.Songr.installer.yaml', `${wingetDir}/Roethlar.Songr.installer.yaml`],
    ['winget/Roethlar.Songr.locale.en-US.yaml', `${wingetDir}/Roethlar.Songr.locale.en-US.yaml`],
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = (args.version ?? '').replace(/^v/, '');
  if (!version) throw new Error('--version is required');
  if (!args.sums) throw new Error('--sums <path to SHA256SUMS> is required');
  const date = args.date ?? new Date().toISOString().slice(0, 10);

  const values = buildSubstitutions(version, date, readSums(resolve(args.sums)));
  const plan = outputPlan(version);

  // Guard against a template being added and silently never rendered.
  // README.md is documentation, not a template, and is exempt.
  const known = new Set(plan.map(([from]) => from));
  for (const dir of ['homebrew', 'scoop', 'aur', 'winget']) {
    for (const name of readdirSync(join(here, dir))) {
      if (name === 'README.md') continue;
      const rel = `${dir}/${name}`;
      if (!known.has(rel)) throw new Error(`template ${rel} is not in the output plan`);
    }
  }

  // Validate the complete supported set before creating any publishable output.
  // A missing file or unresolved placeholder is a failed release preparation.
  const rendered = plan.map(([from, to]) => ({
    to,
    contents: substitute(readFileSync(join(here, from), 'utf8'), values, from),
  }));
  if (args.check) {
    process.stdout.write(`ok: ${rendered.length}/${plan.length} templates render for ${version}\n`);
    return;
  }
  for (const { to, contents } of rendered) {
    const target = join(resolve(args.out ?? 'rendered'), to);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    process.stdout.write(`${to}\n`);
  }
  process.stdout.write(`rendered ${rendered.length}/${plan.length} templates for ${version}\n`);
}

main();
