#!/usr/bin/env node
// Renders every package-manager manifest from the templates beside this file.
//
// Checksums are never typed by a human and never carried from one release to
// the next: they are read from the SHA256SUMS asset the release workflow
// computes over the artifacts it just uploaded. A template that still holds a
// placeholder after substitution is a hard failure, so a renamed asset breaks
// the release loudly instead of publishing a manifest with "@SHA256_...@" in
// the hash field.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
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
    [`Songr-${version}.AppImage`]: 'SHA256_APPIMAGE_X64',
  };
}

/**
 * Extensions copied through verbatim rather than read as UTF-8 text and
 * placeholder-substituted. Reading a binary file (the Flathub icon) as utf8
 * and writing it back out would corrupt it -- this is the guard against that,
 * not a style choice.
 */
const BINARY_EXTENSIONS = new Set(['.png']);
function isBinary(path) {
  return BINARY_EXTENSIONS.has(path.slice(path.lastIndexOf('.')));
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
  const wingetDir = `winget/manifests/r/roethlar/Songr/${version}`;
  return [
    ['homebrew/songr.rb', 'homebrew/Casks/songr.rb'],
    ['scoop/songr.json', 'scoop/bucket/songr.json'],
    ['aur/PKGBUILD', 'aur/PKGBUILD'],
    ['winget/roethlar.Songr.yaml', `${wingetDir}/roethlar.Songr.yaml`],
    ['winget/roethlar.Songr.installer.yaml', `${wingetDir}/roethlar.Songr.installer.yaml`],
    ['winget/roethlar.Songr.locale.en-US.yaml', `${wingetDir}/roethlar.Songr.locale.en-US.yaml`],
    ['flatpak/io.github.roethlar.songr.yml', 'flatpak/io.github.roethlar.songr.yml'],
    ['flatpak/songr.sh', 'flatpak/songr.sh'],
    ['flatpak/io.github.roethlar.songr.desktop', 'flatpak/io.github.roethlar.songr.desktop'],
    ['flatpak/io.github.roethlar.songr.metainfo.xml', 'flatpak/io.github.roethlar.songr.metainfo.xml'],
    ['flatpak/io.github.roethlar.songr.png', 'flatpak/io.github.roethlar.songr.png'],
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
  for (const dir of ['homebrew', 'scoop', 'aur', 'winget', 'flatpak']) {
    for (const name of readdirSync(join(here, dir))) {
      if (name === 'README.md') continue;
      const rel = `${dir}/${name}`;
      if (!known.has(rel)) throw new Error(`template ${rel} is not in the output plan`);
    }
  }

  // Each template renders independently: one target held back by an
  // unresolved placeholder (a real case today -- @AUR_MAINTAINER@ pending D5
  // in the plan) must not stop every OTHER target from publishing. The first
  // version of this loop let one substitute() throw abort the whole run, which
  // would have meant Homebrew, Scoop and WinGet could never auto-publish
  // until an unrelated AUR decision was made -- caught before it shipped.
  const skipped = [];
  for (const [from, to] of plan) {
    if (isBinary(from)) {
      // No placeholders possible in a binary file -- it always "renders".
      if (args.check) continue;
      const target = join(resolve(args.out ?? 'rendered'), to);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(here, from), target);
      process.stdout.write(`${to}\n`);
      continue;
    }
    let rendered;
    try {
      rendered = substitute(readFileSync(join(here, from), 'utf8'), values, from);
    } catch (error) {
      skipped.push({ to, message: error.message });
      process.stderr.write(`skip ${to}: ${error.message}\n`);
      continue;
    }
    if (args.check) continue;
    const target = join(resolve(args.out ?? 'rendered'), to);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered);
    process.stdout.write(`${to}\n`);
  }

  const rendered = plan.length - skipped.length;
  if (args.check) {
    process.stdout.write(`ok: ${rendered}/${plan.length} templates render for ${version}\n`);
    // --check is the CI pre-flight and local dry-run path: it exists to catch
    // exactly this before a release runs, so unlike a real render it fails
    // when anything is left unresolved.
    if (skipped.length) process.exit(1);
    return;
  }
  process.stdout.write(`rendered ${rendered}/${plan.length} templates for ${version}\n`);
  if (skipped.length) {
    process.stdout.write(`skipped (see stderr for why): ${skipped.map((s) => s.to).join(', ')}\n`);
  }
  // A real render only fails the process outright if NOTHING could be
  // published -- a partial release (some targets held back) is the intended,
  // expected steady state, not an error.
  if (rendered === 0) process.exit(1);
}

main();
