import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const templates = dirname(fileURLToPath(import.meta.url));
const version = '9.8.7';
const expected = [
  'aur/PKGBUILD',
  'homebrew/Casks/songr.rb',
  'scoop/bucket/songr.json',
  ...['installer', 'locale.en-US', ''].map((suffix) =>
    `winget/manifests/r/roethlar/Songr/${version}/roethlar.Songr${suffix ? `.${suffix}` : ''}.yaml`),
].sort();

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'songr-render-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'packaging');
  cpSync(templates, source, { recursive: true });
  const sums = join(dir, 'SHA256SUMS');
  writeFileSync(sums, [
    `Songr-${version}-arm64.dmg`, `Songr-${version}.dmg`, `Songr.Setup.${version}.exe`,
    `songr_${version}_amd64.deb`, `songr_${version}_arm64.deb`, `Songr-${version}.AppImage`,
  ].map((name) => `${'a'.repeat(64)}  ${name}`).join('\n') + '\n');
  const output = join(dir, 'rendered');
  return { source, sums, output,
    run: (...extra) => spawnSync(process.execPath, [join(source, 'render.mjs'),
      '--version', version, '--sums', sums, '--date', '2026-09-10', '--out', output, ...extra],
    { encoding: 'utf8' }),
  };
}

function files(root, prefix = '') {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(root, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]).sort();
}

test('renders exactly the supported channels with substituted release identity', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files(f.output), expected);
  for (const name of expected) {
    const manifest = readFileSync(join(f.output, name), 'utf8');
    assert.ok(manifest.includes(version), name);
    assert.doesNotMatch(manifest, /@[A-Z0-9_]+@/, name);
  }
});

test('an invalid supported template fails before any outputs are written', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'aur', 'PKGBUILD'), 'pkgver=@UNRESOLVED@\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNRESOLVED/);
  assert.deepEqual(files(f.output), []);
});

test('a missing supported template fails before any outputs are written', (t) => {
  const f = fixture(t);
  rmSync(join(f.source, 'scoop', 'songr.json'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(files(f.output), []);
});

test('missing required asset checksum fails without output', (t) => {
  const f = fixture(t);
  writeFileSync(f.sums, '');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing these release assets/);
  assert.deepEqual(files(f.output), []);
});

test('check validates every template without creating output', (t) => {
  const f = fixture(t);
  const result = f.run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok: 6\/6 templates/);
  assert.deepEqual(files(f.output), []);
});
