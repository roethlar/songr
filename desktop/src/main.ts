/**
 * Electron main process — the thin adapter around the engine lifecycle.
 *
 * Everything with interesting ordering lives in `engineLifecycle.ts`, which
 * knows nothing about Electron. This file only wires that machine to the real
 * world: one window, one child process, one instance of the app.
 *
 * Startup order: take the single-instance lock, read the shell's own settings,
 * show a window immediately with a local "starting" page (never a blank frame),
 * spawn the engine, and swap the window over to `http://127.0.0.1:<port>` the
 * moment the engine reports the port it bound. If the engine never gets there,
 * the same window shows a local error page with a retry button instead.
 *
 * Unless, that is, the buried `serverUrl` advanced setting names another
 * controller server — then nothing is spawned at all and the window shows that
 * origin. See `shellMode.ts` for why that mode never falls back to spawning.
 *
 * The app lives in the tray, not in the window: closing the window hides it,
 * and only Quit ends the process. That is the same bargain a music player makes
 * everywhere else — you close the window, the music keeps playing.
 */

import path from 'path';

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { WebContents } from 'electron';

import { EngineTrayClient } from './engineClient';
import { buildEngineLaunchPlan } from './engineConfig';
import type { EngineLocation } from './engineConfig';
import { EngineSupervisor } from './engineLifecycle';
import type { EngineFailure } from './engineLifecycle';
import { createEngineSpawner } from './engineProcess';
import { decideNavigation } from './navigationPolicy';
import {
  GET_SETTINGS_CHANNEL,
  RETRY_ENGINE_CHANNEL,
  SAVE_SETTINGS_CHANNEL,
} from './shellChannels';
import {
  isSettingsSender,
  LOCAL_MODE,
  resolveShellMode,
  shouldReportLoadFailure,
  windowOrigin,
  windowUrl,
} from './shellMode';
import type { ShellMode } from './shellMode';
import {
  DEFAULT_SHELL_SETTINGS,
  loadShellSettings,
  saveShellSettings,
  settingsFilePath,
  shellSettingsFromForm,
} from './shellSettings';
import type { ShellSettings } from './shellSettings';
import { TrayController } from './tray';
import { TrayZoneTracker, deriveTrayMenuState } from './trayModel';

/** `__dirname` is `desktop/dist` once compiled, so the app root is one up. */
const APP_ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(APP_ROOT, 'resources');
const STARTING_PAGE = path.join(RESOURCES_DIR, 'starting.html');
const ERROR_PAGE = path.join(RESOURCES_DIR, 'error.html');
const SETTINGS_PAGE = path.join(RESOURCES_DIR, 'settings.html');
const TRAY_ICON = path.join(RESOURCES_DIR, 'trayIconTemplate.png');
const PRELOAD_SCRIPT = path.join(__dirname, 'preload.js');
/** Settings channels live in their own preload, for the one window that may
 * use them — the main window can show remote content (dt6-1). */
const SETTINGS_PRELOAD_SCRIPT = path.join(__dirname, 'settingsPreload.js');

/**
 * Where the engine lives for this run.
 *
 * Packaged, `__dirname` is inside `app.asar` and the engine is *not* — it is an
 * `extraResources` payload beside the archive, because it is forked as a plain
 * Node program and Node cannot read an asar. So the packaged branch reads
 * `process.resourcesPath` instead of walking up from the app root, which would
 * resolve to a path inside the bundle that has never existed.
 */
const ENGINE_LOCATION: EngineLocation = app.isPackaged
  ? { kind: 'packaged', resourcesPath: process.resourcesPath }
  : { kind: 'dev', appRoot: APP_ROOT };

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let supervisor: EngineSupervisor | null = null;
let engineShutdownDone = false;

/**
 * Read once at startup and never re-read. A change takes effect on the next
 * launch, which is what the settings page says: switching between a local and a
 * remote engine mid-session would mean tearing down a paired Roon extension
 * under a playing window, for a setting almost nobody touches.
 */
let settings: ShellSettings = DEFAULT_SHELL_SETTINGS;
let settingsPath = '';
let mode: ShellMode = LOCAL_MODE;

/**
 * Set the moment a real quit begins, so the window's `close` handler stops
 * intercepting. Without it, Quit would hide the window forever instead of
 * ending the app.
 */
let quitRequested = false;

const trayZones = new TrayZoneTracker();
let tray: TrayController | null = null;

function log(message: string): void {
  console.log(`[shell] ${message}`);
}

const trayClient = new EngineTrayClient({
  tracker: trayZones,
  onChange: () => {
    renderTray();
  },
  log,
});

function renderTray(): void {
  tray?.render(
    deriveTrayMenuState({
      target: trayZones.target,
      windowVisible: mainWindow?.isVisible() ?? false,
    }),
  );
}

function toggleWindow(): void {
  if (mainWindow !== null && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    return;
  }
  focusExistingWindow();
}

function quitApp(): void {
  quitRequested = true;
  app.quit();
}

function currentEngineOrigin(): string | null {
  return windowOrigin(mode, supervisor?.port ?? null);
}

function describeUrlForLog(url: string | undefined): string {
  if (!url) {
    return '(gone)';
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' ? 'local page' : parsed.origin;
  } catch {
    return '(unparseable)';
  }
}


function decide(url: string): ReturnType<typeof decideNavigation> {
  return decideNavigation(url, currentEngineOrigin(), RESOURCES_DIR);
}

function showStartingPage(): void {
  void mainWindow?.loadFile(STARTING_PAGE);
}

interface ErrorPageCopy {
  readonly title?: string;
  readonly summary?: string;
  readonly reason: string;
  readonly attempts?: number;
}

function showErrorPage(copy: ErrorPageCopy): void {
  const params = new URLSearchParams({ reason: copy.reason });
  if (copy.title !== undefined) {
    params.set('title', copy.title);
  }
  if (copy.summary !== undefined) {
    params.set('summary', copy.summary);
  }
  if (copy.attempts !== undefined) {
    params.set('attempts', String(copy.attempts));
  }
  void mainWindow?.loadFile(ERROR_PAGE, { search: params.toString() });
}

function showEngineErrorPage(failure: EngineFailure): void {
  showErrorPage({ reason: failure.message, attempts: failure.attempts });
}

function showRemoteErrorPage(description: string): void {
  if (mode.kind !== 'remote') {
    return;
  }
  showErrorPage({
    title: 'Could not reach that server',
    summary: `${mode.origin} did not respond.`,
    reason: description,
  });
}

/**
 * Apply the navigation policy to a window's contents. Every window the shell
 * creates gets the preload bridge, so every window needs the same containment —
 * not just the one showing the app.
 */
function containNavigation(contents: WebContents): void {
  // Anything that wants a new window (an external link in the UI) belongs in
  // the user's browser, not in a chromeless Electron frame — and only web
  // schemes are handed to the OS.
  contents.setWindowOpenHandler(({ url }) => {
    if (decide(url) === 'open-external') {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Plain anchor navigation must not replace the app frame either (dt2-2),
  // and a server-side redirect must not hop origins past the same policy —
  // will-navigate does not fire for redirects, will-redirect does (dt3-2).
  const contain = (event: { preventDefault(): void }, url: string): void => {
    const decision = decide(url);
    if (decision === 'allow') {
      return;
    }
    event.preventDefault();
    if (decision === 'open-external') {
      void shell.openExternal(url);
    }
  };
  contents.on('will-navigate', contain);
  contents.on('will-redirect', contain);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Close hides; only Quit quits. The engine stays up, so playback and the
  // Roon extension registration survive closing the window.
  mainWindow.on('close', (event) => {
    if (quitRequested || mainWindow === null) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    renderTray();
  });

  // The tray's first item is a Show/Hide toggle, so its label has to follow
  // the window rather than only the zone state.
  mainWindow.on('show', () => {
    renderTray();
  });
  mainWindow.on('hide', () => {
    renderTray();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // Origin only: the full URL may carry a query — and in remote mode the
    // user's server address is theirs to keep out of support bundles (dt6-2).
    log(`window loaded ${describeUrlForLog(mainWindow?.webContents.getURL())}`);
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, code, description, url, isMainFrame) => {
      // Same origin-only treatment as did-finish-load (dt7-3, dt6-2 residual).
      log(
        `window failed to load ${describeUrlForLog(url)}: ${description} (${String(code)})`,
      );
      // In local mode the supervisor owns the error state; in remote mode
      // nothing else is watching, so this is the only thing between an
      // unreachable server and a permanently blank frame.
      if (shouldReportLoadFailure({ mode, failedUrl: url, errorCode: code, isMainFrame })) {
        showRemoteErrorPage(description);
      }
    },
  );

  containNavigation(mainWindow.webContents);

  const target = windowUrl(mode, supervisor?.port ?? null);
  if (target !== null) {
    void mainWindow.loadURL(target);
  } else {
    showStartingPage();
  }
}

function focusExistingWindow(): void {
  if (mainWindow === null) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * The advanced settings page, in its own small window so opening it does not
 * throw away whatever the app window was showing. Reachable only from the tray.
 */
function openSettingsWindow(): void {
  if (settingsWindow !== null) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 620,
    height: 760,
    resizable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Advanced Settings',
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    webPreferences: {
      preload: SETTINGS_PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  containNavigation(settingsWindow.webContents);
  void settingsWindow.loadFile(SETTINGS_PAGE);
}

function createSupervisor(userDataDir: string): EngineSupervisor {
  const plan = buildEngineLaunchPlan({
    location: ENGINE_LOCATION,
    userDataDir,
    parentEnv: process.env,
    settings,
  });

  log(`engine location ${ENGINE_LOCATION.kind}`);
  log(`engine entry ${plan.entryPath}`);
  log(`engine cwd ${plan.cwd}`);
  log(`engine config dir ${String(plan.env.CONFIG_DIR)}`);
  log(`engine bind ${String(plan.env.HOST)}:${String(plan.env.PORT)}`);

  return new EngineSupervisor({
    spawn: createEngineSpawner({ plan }),
    observer: {
      onStateChange: (state, previous) => {
        log(`engine ${previous} -> ${state}`);
        if (state !== 'running') {
          // Anything other than `running` means the socket the tray was using
          // is gone or about to be. Dropping it clears the zone state, so the
          // tray cannot offer transport for an engine that is not there.
          trayClient.disconnect();
        }
      },
      onReady: (port) => {
        const url = windowUrl(mode, port);
        if (url === null) {
          return;
        }
        void mainWindow?.loadURL(url);
        trayClient.connect(url);
      },
      onRetryScheduled: (failure, retryInMs) => {
        log(`${failure.message}; relaunching in ${String(retryInMs)}ms`);
        showStartingPage();
      },
      onFailed: (failure) => {
        log(`giving up after ${String(failure.attempts)} attempts: ${failure.message}`);
        showEngineErrorPage(failure);
      },
    },
  });
}

function startApp(): void {
  app.on('second-instance', () => {
    // A second launch is a request to see the window that already exists, not
    // a request for a second engine.
    focusExistingWindow();
  });

  ipcMain.on(RETRY_ENGINE_CHANNEL, () => {
    if (mode.kind === 'remote') {
      // Try the configured server again — and only that. Falling back to a
      // local engine here is exactly the "two brains" behaviour the owner
      // rejected: the user would be looking at a different library than the
      // one they configured, with no indication anything had changed.
      void mainWindow?.loadURL(mode.url);
      return;
    }
    showStartingPage();
    supervisor?.retry();
  });

  // Second wall behind the per-window preload split: the handlers act only
  // for the settings page itself, so remote content can never reach these
  // channels even through a future preload mistake (dt6-1).
  ipcMain.handle(GET_SETTINGS_CHANNEL, (event) => {
    if (!isSettingsSender(event.senderFrame?.url, SETTINGS_PAGE)) {
      log('settings: get refused for a non-settings sender');
      return null;
    }
    return settings;
  });

  ipcMain.handle(SAVE_SETTINGS_CHANNEL, (event, form: unknown) => {
    if (!isSettingsSender(event.senderFrame?.url, SETTINGS_PAGE)) {
      log('settings: save refused for a non-settings sender');
      return null;
    }
    try {
      const stored = saveShellSettings({
        filePath: settingsPath,
        settings: shellSettingsFromForm(form, (message) => {
          log(`settings: ${message}`);
        }),
      });
      settings = stored;
      log(
        `settings saved to ${settingsPath} (applies on next launch): ` +
          `serverUrl=${stored.serverUrl ?? '(none)'} ` +
          `serveOnNetwork=${String(stored.serveOnNetwork)} ` +
          `networkPort=${String(stored.networkPort)}`,
      );
      return { ok: true, settings: stored };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`could not save settings: ${message}`);
      return { ok: false, error: `Could not save settings: ${message}` };
    }
  });

  // Deliberately does not quit on any platform: the tray is the app's home
  // now, and the window closing is a hide. This only fires if a window is
  // genuinely destroyed, and then the tray is still there to bring it back.
  app.on('window-all-closed', () => {
    // Intentionally empty. Quit is explicit, via the tray or the app menu.
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      focusExistingWindow();
    }
  });

  // Quitting must not leave an orphan engine behind, so the quit is deferred
  // until the child is actually gone.
  app.on('before-quit', (event) => {
    // Whatever asked for the quit — tray, app menu, Cmd-Q, a signal — the
    // window must stop intercepting its own close from here on.
    quitRequested = true;
    trayClient.disconnect();
    tray?.destroy();
    tray = null;
    if (engineShutdownDone || supervisor === null) {
      return;
    }
    event.preventDefault();
    void supervisor.stop().then(() => {
      engineShutdownDone = true;
      app.quit();
    });
  });

  void app.whenReady().then(() => {
    const userDataDir = app.getPath('userData');
    settingsPath = settingsFilePath(userDataDir);
    settings = loadShellSettings({
      filePath: settingsPath,
      warn: (message) => {
        log(`settings: ${message}`);
      },
    });
    mode = resolveShellMode(settings);

    tray = new TrayController({
      iconPath: TRAY_ICON,
      onToggleWindow: toggleWindow,
      onPlayPause: () => {
        trayClient.playPause();
      },
      onNext: () => {
        trayClient.next();
      },
      onPrevious: () => {
        trayClient.previous();
      },
      onOpenSettings: openSettingsWindow,
      onQuit: quitApp,
    });
    tray.create();
    createWindow();
    renderTray();

    if (mode.kind === 'remote') {
      log(`remote mode: using ${mode.url}; no engine will be spawned`);
      trayClient.connect(mode.url);
      return;
    }

    supervisor = createSupervisor(userDataDir);
    supervisor.start();
  });
}

if (!app.requestSingleInstanceLock()) {
  // Another copy owns the lock; it will get the `second-instance` event.
  app.quit();
} else {
  startApp();
}
