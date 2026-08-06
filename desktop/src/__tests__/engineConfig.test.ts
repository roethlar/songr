import fs from 'fs';
import path from 'path';

import {
  buildEngineLaunchPlan,
  engineUrl,
  ENGINE_ENTRY_ENV,
  ENGINE_HOST,
  NETWORK_BIND_HOST,
  resolveEngineEntry,
} from '../engineConfig';
import { engineUiBuildPath, packagedEngineEntry } from '../packaging';
import {
  GET_SETTINGS_CHANNEL,
  RETRY_ENGINE_CHANNEL,
  SAVE_SETTINGS_CHANNEL,
} from '../shellChannels';
import { DEFAULT_NETWORK_PORT } from '../shellSettings';

const DEV_LOCATION = { kind: 'dev', appRoot: '/opt/app/desktop' } as const;
const PACKAGED_LOCATION = {
  kind: 'packaged',
  resourcesPath: '/Applications/Songr.app/Contents/Resources',
} as const;

describe('resolveEngineEntry', () => {
  it('defaults to the repository build beside the desktop workspace', () => {
    expect(resolveEngineEntry(DEV_LOCATION, {})).toBe('/opt/app/dist/index.js');
  });

  it('honours the manual override', () => {
    expect(
      resolveEngineEntry(DEV_LOCATION, {
        [ENGINE_ENTRY_ENV]: '/Applications/App.app/Contents/Resources/engine/dist/index.js',
      }),
    ).toBe('/Applications/App.app/Contents/Resources/engine/dist/index.js');
  });

  it('ignores a blank override rather than resolving it to the cwd', () => {
    expect(resolveEngineEntry(DEV_LOCATION, { [ENGINE_ENTRY_ENV]: '   ' })).toBe(
      '/opt/app/dist/index.js',
    );
  });

  it('reads the extraResources payload when the app is packaged', () => {
    // The load-bearing line of the whole packaging slice: packaged, the engine
    // is beside app.asar, not one level up from the app root — that walk lands
    // inside the archive, where the file has never existed.
    expect(resolveEngineEntry(PACKAGED_LOCATION, {})).toBe(
      '/Applications/Songr.app/Contents/Resources/engine/dist/index.js',
    );
  });

  it('never falls back to the dev path when packaged', () => {
    // A packaged build has no sibling checkout. Resolving one would produce an
    // ENOENT naming a path that could not exist on the user's machine.
    expect(resolveEngineEntry(PACKAGED_LOCATION, {})).not.toContain('desktop');
    expect(resolveEngineEntry(PACKAGED_LOCATION, {})).toBe(
      packagedEngineEntry(PACKAGED_LOCATION.resourcesPath),
    );
  });

  it('still honours the override when packaged, so a build can be pointed at a checkout', () => {
    expect(
      resolveEngineEntry(PACKAGED_LOCATION, { [ENGINE_ENTRY_ENV]: '/checkout/dist/index.js' }),
    ).toBe('/checkout/dist/index.js');
  });
});

describe('buildEngineLaunchPlan when packaged', () => {
  const plan = buildEngineLaunchPlan({
    location: PACKAGED_LOCATION,
    userDataDir: '/Users/someone/Library/Application Support/Songr',
    parentEnv: {},
  });

  it('forks the staged engine entry', () => {
    expect(plan.entryPath).toBe(
      '/Applications/Songr.app/Contents/Resources/engine/dist/index.js',
    );
  });

  it('runs it from the payload root, where the production node_modules sits', () => {
    expect(plan.cwd).toBe('/Applications/Songr.app/Contents/Resources/engine');
  });

  it('keeps the per-user data directories, unchanged from the dev run', () => {
    expect(plan.env.CONFIG_DIR).toBe(
      path.join('/Users/someone/Library/Application Support/Songr', 'config'),
    );
    expect(plan.env.PORT).toBe('0');
    expect(plan.env.HOST).toBe(ENGINE_HOST);
  });

  it('tells the engine it is in production, whatever the launching shell said', () => {
    // Load-bearing. The staged payload has production dependencies only, and
    // the engine's logger transport is a devDependency it only skips in
    // production. Without this the packaged child exits 1 on its first log
    // line and the app never leaves its relaunch backoff.
    expect(plan.env.NODE_ENV).toBe('production');
    expect(
      buildEngineLaunchPlan({
        location: PACKAGED_LOCATION,
        userDataDir: '/userdata',
        parentEnv: { NODE_ENV: 'development' },
      }).env.NODE_ENV,
    ).toBe('production');
  });

  it('leaves the engine able to find the UI it was staged with', () => {
    // The engine resolves `ui/build` from its own compiled location. If the
    // staged payload ever stops being shaped like a checkout, this is the
    // assertion that says so — the app would otherwise start, answer the API
    // and show an empty window.
    expect(engineUiBuildPath(plan.entryPath)).toBe(
      '/Applications/Songr.app/Contents/Resources/engine/ui/build',
    );
  });
});

describe('buildEngineLaunchPlan', () => {
  const plan = buildEngineLaunchPlan({
    location: DEV_LOCATION,
    userDataDir: '/home/someone/.config/desktop-app',
    parentEnv: { PATH: '/usr/bin', PORT: '3000', HOST: '0.0.0.0', DATA_DIR: '/srv/data' },
  });

  it('asks the operating system for a port and keeps the engine on loopback', () => {
    expect(plan.env.PORT).toBe('0');
    expect(plan.env.HOST).toBe(ENGINE_HOST);
  });

  it('overrides inherited appliance settings instead of deferring to them', () => {
    expect(plan.env.DATA_DIR).toBe(path.join('/home/someone/.config/desktop-app', 'data'));
    expect(plan.env.CONFIG_DIR).toBe(path.join('/home/someone/.config/desktop-app', 'config'));
  });

  it('passes the rest of the environment through', () => {
    expect(plan.env.PATH).toBe('/usr/bin');
  });

  it('leaves a dev run in whatever mode the shell was launched in', () => {
    // The mirror of the packaged case: a checkout has the pretty-print
    // transport installed, and forcing production here would throw away the
    // readable logs that are the reason to run from a checkout at all.
    expect(plan.env.NODE_ENV).toBeUndefined();
  });

  it('runs the engine from its own package root', () => {
    expect(plan.entryPath).toBe('/opt/app/dist/index.js');
    expect(plan.cwd).toBe('/opt/app');
  });
});

describe('buildEngineLaunchPlan with "serve on the local network" on', () => {
  const plan = buildEngineLaunchPlan({
    location: DEV_LOCATION,
    userDataDir: '/home/someone/.config/desktop-app',
    parentEnv: {},
    settings: { serveOnNetwork: true, networkPort: DEFAULT_NETWORK_PORT },
  });

  it('binds every interface on the fixed port instead of an ephemeral one', () => {
    // A LAN client cannot discover an ephemeral port, so the setting has to
    // trade both halves at once: the bind host AND the port.
    expect(plan.env.HOST).toBe(NETWORK_BIND_HOST);
    expect(plan.env.PORT).toBe(String(DEFAULT_NETWORK_PORT));
  });

  it('changes nothing else about the launch', () => {
    expect(plan.entryPath).toBe('/opt/app/dist/index.js');
    expect(plan.env.CONFIG_DIR).toBe(
      path.join('/home/someone/.config/desktop-app', 'config'),
    );
    expect(plan.env.DATA_DIR).toBe(
      path.join('/home/someone/.config/desktop-app', 'data'),
    );
  });

  it('honours a non-default port', () => {
    expect(
      buildEngineLaunchPlan({
        location: DEV_LOCATION,
        userDataDir: '/userdata',
        parentEnv: {},
        settings: { serveOnNetwork: true, networkPort: 4444 },
      }).env.PORT,
    ).toBe('4444');
  });

  it('stays on loopback while the toggle is off, whatever the port says', () => {
    const off = buildEngineLaunchPlan({
      location: DEV_LOCATION,
      userDataDir: '/userdata',
      parentEnv: {},
      settings: { serveOnNetwork: false, networkPort: 4444 },
    });
    expect(off.env.HOST).toBe(ENGINE_HOST);
    expect(off.env.PORT).toBe('0');
  });
});

describe('engineUrl', () => {
  it('points at the loopback interface on the reported port', () => {
    expect(engineUrl(51_234)).toBe('http://127.0.0.1:51234');
  });
});

describe('preload channels', () => {
  // A sandboxed preload cannot require shellChannels.ts, so the strings are
  // duplicated there. These guard against the copies drifting — and against
  // the settings channels creeping back into the main window's preload,
  // which remote content shares (dt6-1).
  it('main preload carries the retry channel and ONLY that', () => {
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '..', 'preload.ts'),
      'utf8',
    );
    expect(preloadSource).toContain(`'${RETRY_ENGINE_CHANNEL}'`);
    expect(preloadSource).not.toContain(`'${GET_SETTINGS_CHANNEL}'`);
    expect(preloadSource).not.toContain(`'${SAVE_SETTINGS_CHANNEL}'`);
  });

  it('settings preload carries the settings channels and never retry', () => {
    const settingsPreloadSource = fs.readFileSync(
      path.join(__dirname, '..', 'settingsPreload.ts'),
      'utf8',
    );
    expect(settingsPreloadSource).toContain(`'${GET_SETTINGS_CHANNEL}'`);
    expect(settingsPreloadSource).toContain(`'${SAVE_SETTINGS_CHANNEL}'`);
    expect(settingsPreloadSource).not.toContain(`'${RETRY_ENGINE_CHANNEL}'`);
  });
});
