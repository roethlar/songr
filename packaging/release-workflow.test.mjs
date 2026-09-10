import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { load: parse } = require('js-yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs.build.steps;
const step = (name) => {
  const found = steps.find((entry) => entry.name === name);
  assert.ok(found, name);
  return found;
};

test('missing macOS certificate stops the release before import or packaging', () => {
  const result = spawnSync('bash', ['-c', step('Import Developer ID certificate').run], {
    encoding: 'utf8', env: { PATH: process.env.PATH, MAC_CERT_P12: '', MAC_CERT_PASSWORD: '' },
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /MAC_CERT_P12/);
});

test('canonical release requires signatures on each platform before upload', () => {
  assert.equal(workflow.jobs.build.if, "github.repository == 'roethlar/songr'");
  assert.equal(step('Sign Windows executable').if, "runner.os == 'Windows'");
  assert.equal(step('Verify Windows signature').if, "runner.os == 'Windows'");
  assert.equal(step('Notarize and staple macOS DMG').if, "runner.os == 'macOS'");
  assert.equal(step('Verify macOS signature and notarization').if, "runner.os == 'macOS'");
  assert.doesNotMatch(step('Build and package').run, /identity=null|AZURE_SIGNING_ENABLED/);
  assert.match(step('Build and package').run, /forceCodeSigning=true/);
  const verify = steps.findIndex((entry) => entry.name === 'Verify macOS signature and notarization');
  const upload = steps.findIndex((entry) => entry.uses?.startsWith('softprops/action-gh-release@'));
  assert.ok(upload > verify);
});

for (const filename of ['release.yml', 'publish-packages.yml']) {
  test(`${filename} requires all six supported manifests before publishing`, () => {
    const source = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8');
    assert.match(source, /packaging\/render\.mjs.*--check/);
    assert.doesNotMatch(source, /HAVE_RENDERED_|Detect which manifests actually rendered/);
  });
}

for (const platform of ['macOS', 'Windows']) {
  test(`missing ${platform} signing inputs prevent packaging`, (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'songr-signing-gate-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const called = join(scratch, 'npm-called');
    writeFileSync(join(scratch, 'npm'), '#!/bin/sh\n: > "$SONGR_TEST_NPM_CALLED"\n', { mode: 0o755 });
    const script = step('Build and package').run
      .replaceAll('${{ runner.os }}', platform)
      .replaceAll('${{ matrix.target }}', platform === 'macOS' ? '--mac' : '--win')
      .replaceAll('${{ matrix.arches }}', '--x64');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
      PATH: `${scratch}:${process.env.PATH}`,
      SONGR_TEST_NPM_CALLED: called,
      GITHUB_ENV: join(scratch, 'github-env'),
    } });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /required for a signed/);
    assert.equal(existsSync(called), false, 'packaging must not start');
  });
}
