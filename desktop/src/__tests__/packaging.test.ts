import path from 'path';

import {
  builderIdentityArgs,
  ENGINE_LAYOUT,
  ENGINE_RESOURCE_DIR,
  engineUiBuildPath,
  packagedEngineEntry,
  packagedEngineRoot,
  PRODUCT_NAME,
  PUBLIC_APP_ID,
} from '../packaging';

const MAC_RESOURCES = '/Applications/Songr.app/Contents/Resources';
const LINUX_RESOURCES = '/opt/Songr/resources';

describe('the packaged engine payload', () => {
  it('sits beside app.asar, not inside it', () => {
    // extraResources, never `files`: the engine is forked as a plain Node
    // program and Node cannot require its way into an asar archive.
    expect(packagedEngineRoot(MAC_RESOURCES)).toBe(`${MAC_RESOURCES}/${ENGINE_RESOURCE_DIR}`);
    expect(packagedEngineEntry(MAC_RESOURCES)).toBe(`${MAC_RESOURCES}/engine/dist/index.js`);
  });

  it('has the same shape on every platform', () => {
    expect(packagedEngineEntry(LINUX_RESOURCES)).toBe(`${LINUX_RESOURCES}/engine/dist/index.js`);
  });

  it('names its entry file relative to the payload root', () => {
    expect(ENGINE_LAYOUT.entry).toBe('dist/index.js');
    expect(path.posix.dirname(ENGINE_LAYOUT.entry)).toBe(ENGINE_LAYOUT.compiledBackend);
  });
});

describe('the engine finding its UI', () => {
  /*
   * The whole point of this pair of assertions: the staging step and the
   * backend must agree, and they agree only because `dist/` and `ui/build/` are
   * siblings. Nothing at runtime notices when they stop being siblings — the
   * app launches, the API answers, and the window is blank.
   */
  it('resolves ui/build as a sibling of dist, the way a checkout is laid out', () => {
    expect(engineUiBuildPath('/checkout/dist/index.js')).toBe('/checkout/ui/build');
  });

  it('lands exactly where the staged layout puts the UI', () => {
    const payloadRoot = packagedEngineRoot(MAC_RESOURCES);
    const entry = packagedEngineEntry(MAC_RESOURCES);
    expect(engineUiBuildPath(entry)).toBe(
      path.join(payloadRoot, ...ENGINE_LAYOUT.uiBuild.split('/')),
    );
  });
});

describe('one public application identity', () => {
  it('preserves every published bundle, runtime, and Linux package identity', () => {
    expect(PRODUCT_NAME).toBe('Songr');
    expect(PUBLIC_APP_ID).toBe('app.songr.desktop');
    expect(builderIdentityArgs()).toEqual([
      '--config.appId=app.songr.desktop',
      '--config.productName=Songr',
      '--config.extraMetadata.name=songr',
      '--config.extraMetadata.productName=Songr',
      '--config.linux.executableName=songr',
      '--config.deb.packageName=songr',
      '--config.rpm.packageName=songr',
      '--config.extraMetadata.desktopName=songr.desktop',
    ]);
  });

  it('uses that identity without inspecting a checkout marker', () => {
    const fs = require('fs') as typeof import('fs');
    const script = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'package-app.mjs'), 'utf8',
    );
    expect(script).toContain('builderIdentityArgs()');
    expect(script).not.toContain('PRIVATE_TREE_MARKER');
    expect(script).not.toContain('privateTree');
    expect(script).not.toMatch(/--config\\.appId=\\$\\{/);
  });
});
describe('packaging script spawning (dt7-2, revised)', () => {
  it('never spawns a .cmd shim, which Node refuses without a shell', () => {
    // The v1.1.0 CI run proved the first fix wrong on a real Windows host:
    // execFileSync of npm.cmd throws EINVAL (CVE-2024-27980 hardening). npm
    // runs via its own JS entry from npm_execpath, and electron-builder via
    // its cli.js — both under process.execPath, no shim on any platform.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const script = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'package-app.mjs'),
      'utf8',
    );
    // No quoted .cmd literal may appear in code (prose may discuss the shim).
    expect(script).not.toMatch(/'[^']*\.cmd'/);
    // Exactly ONE bare 'npm' literal is allowed: NPM_ARGV's POSIX fallback.
    // The first guard checked only for single-line run('npm' and a
    // multi-line call site sailed past it into the v1.1.0 CI run.
    expect(script.match(/'npm'/g) ?? []).toHaveLength(1);
    expect(script).toContain('npm_execpath');
    expect(script).toContain("'electron-builder', 'cli.js'");
  });
});
