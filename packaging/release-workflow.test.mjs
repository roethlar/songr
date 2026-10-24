import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { load: parse } = require('js-yaml');
const workflowSource = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const workflow = parse(workflowSource);
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

const stepIndex = (predicate) => {
  const index = steps.findIndex(predicate);
  assert.ok(index >= 0);
  return index;
};
const uploadIndex = () => stepIndex((entry) => entry.uses?.startsWith('softprops/action-gh-release@'));

test('canonical macOS release is signed and notarized before upload', () => {
  assert.equal(workflow.jobs.build.if, "github.repository == 'roethlar/songr'");
  assert.equal(step('Notarize and staple macOS DMG').if, "runner.os == 'macOS'");
  assert.equal(step('Verify macOS signature and notarization').if, "runner.os == 'macOS'");
  assert.doesNotMatch(step('Build and package').run, /identity=null|AZURE_SIGNING_ENABLED/);
  assert.match(step('Build and package').run, /forceCodeSigning=true/);
  const verify = stepIndex((entry) => entry.name === 'Verify macOS signature and notarization');
  assert.ok(uploadIndex() > verify);
});

// Windows ships unsigned (owner decision 2026-10-23): no signing step, no
// signing secret, and an unsigned-installer verification gates the upload, so
// the windows leg can pass and publish-packages (needs: build) runs.
test('canonical Windows release is verified unsigned before upload', () => {
  assert.equal(steps.some((entry) => /Sign Windows|Verify Windows signature/.test(entry.name ?? '')), false);
  assert.doesNotMatch(workflowSource, /AZURE_|TrustedSigning|Get-AuthenticodeSignature/);
  const verify = step('Verify unsigned Windows installer');
  assert.equal(verify.if, "runner.os == 'Windows'");
  assert.equal(verify.run.trim(), 'node desktop/scripts/verify-windows-installer.mjs');
  assert.ok(existsSync(new URL('../desktop/scripts/verify-windows-installer.mjs', import.meta.url)));
  const build = stepIndex((entry) => entry.name === 'Build and package');
  const index = stepIndex((entry) => entry.name === 'Verify unsigned Windows installer');
  assert.ok(build < index && index < uploadIndex());
  assert.equal(workflow.jobs['publish-packages'].needs, 'build');
});

for (const filename of ['release.yml', 'publish-packages.yml']) {
  test(`${filename} requires all six supported manifests before publishing`, () => {
    const source = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8');
    assert.match(source, /packaging\/render\.mjs.*--check/);
    assert.doesNotMatch(source, /HAVE_RENDERED_|Detect which manifests actually rendered/);
  });
}

const packagingScript = (platform) => step('Build and package').run
  .replaceAll('${{ runner.os }}', platform)
  .replaceAll('${{ matrix.target }}', platform === 'macOS' ? '--mac' : '--win')
  .replaceAll('${{ matrix.arches }}', '--x64');

// A stub npm that records its arguments and the signing variables it saw.
const stubNpm = (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'songr-signing-gate-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const called = join(scratch, 'npm-called');
  writeFileSync(join(scratch, 'npm'), [
    '#!/bin/sh',
    '{ printf "args=%s\\n" "$*"',
    '  printf "CSC_LINK=%s\\n" "${CSC_LINK-unset}"',
    '  printf "CSC_KEY_PASSWORD=%s\\n" "${CSC_KEY_PASSWORD-unset}"; } > "$SONGR_TEST_NPM_CALLED"',
    '',
  ].join('\n'), { mode: 0o755 });
  const env = {
    PATH: `${scratch}${delimiter}${process.env.PATH}`,
    SONGR_TEST_NPM_CALLED: called,
    GITHUB_ENV: join(scratch, 'github-env'),
  };
  return { called, env };
};

test('missing macOS signing inputs prevent packaging', (t) => {
  const { called, env } = stubNpm(t);
  const result = spawnSync('bash', ['-c', packagingScript('macOS')], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /required for a signed/);
  assert.equal(existsSync(called), false, 'packaging must not start');
});

test('Windows packages without signing inputs and never sees the macOS certificate', (t) => {
  const { called, env } = stubNpm(t);
  const result = spawnSync('bash', ['-c', packagingScript('Windows')], { encoding: 'utf8', env: {
    ...env, CSC_LINK: 'macos-developer-id-p12', CSC_KEY_PASSWORD: 'macos-p12-password',
  } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(called), 'packaging must start');
  const seen = readFileSync(called, 'utf8');
  assert.match(seen, /^args=.*--win/m);
  assert.doesNotMatch(seen, /forceCodeSigning/);
  assert.match(seen, /^CSC_LINK=unset$/m);
  assert.match(seen, /^CSC_KEY_PASSWORD=unset$/m);
});
