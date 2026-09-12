/** Exercise the real main-process wiring with controlled Electron events. */
import { EventEmitter } from 'node:events';

function launch(options: { serverUrl?: string; ownsLock?: boolean; appVersion?: string } = {}) {
  jest.resetModules();
  let ready = false;
  let resolveReady!: () => void;
  const readiness = new Promise<void>((resolve) => { resolveReady = resolve; });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    isReady: () => ready,
    whenReady: () => readiness,
    getPath: jest.fn(() => '/isolated/songr-test'),
    getVersion: jest.fn(() => options.appVersion ?? '1.4.3'),
    requestSingleInstanceLock: () => options.ownsLock !== false,
    quit: jest.fn(),
  });
  const windows: FakeWindow[] = [];
  class FakeWindow extends EventEmitter {
    static getAllWindows() { return windows.filter((window) => !window.destroyed); }
    destroyed = false;
    minimized = false;
    visible = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: jest.fn(),
      getURL: () => '',
    });
    loadFile = jest.fn().mockResolvedValue(undefined);
    loadURL = jest.fn().mockResolvedValue(undefined);
    isVisible = () => this.visible;
    isMinimized = () => this.minimized;
    isDestroyed = () => this.destroyed;
    show = jest.fn(() => { this.visible = true; });
    hide = jest.fn(() => { this.visible = false; });
    restore = jest.fn(() => { this.minimized = false; });
    focus = jest.fn();
    constructor() {
      super();
      if (!ready) throw new Error('Cannot create BrowserWindow before app is ready');
      windows.push(this);
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const start = jest.fn();
  const stop = jest.fn().mockResolvedValue(undefined);
  const connect = jest.fn();
  const trayCreate = jest.fn();
  const ipcMain = Object.assign(new EventEmitter(), { handle: jest.fn() });
  const showMessageBox = jest.fn().mockResolvedValue({ response: 1 });
  const openExternal = jest.fn().mockResolvedValue(undefined);
  const fetchRelease = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    tag_name: 'v1.4.4', draft: false, prerelease: false,
  })));
  jest.doMock('electron', () => ({
    app, BrowserWindow: FakeWindow, ipcMain,
    dialog: { showMessageBox }, shell: { openExternal },
  }),
    { virtual: true });
  jest.doMock('../engineClient', () => ({
    EngineTrayClient: jest.fn(() => ({ connect, disconnect: jest.fn() })),
  }));
  jest.doMock('../engineLifecycle', () => ({
    EngineSupervisor: jest.fn(() => ({ start, stop, port: null })),
  }));
  jest.doMock('../engineProcess', () => ({ createEngineSpawner: jest.fn() }));
  jest.doMock('../tray', () => ({
    TrayController: jest.fn(() => ({
      create: trayCreate, render: jest.fn(), destroy: jest.fn(),
    })),
  }));
  jest.doMock('../shellSettings', () => {
    const actual = jest.requireActual<typeof import('../shellSettings')>('../shellSettings');
    return {
      ...actual,
      loadShellSettings: () => ({ ...actual.DEFAULT_SHELL_SETTINGS, serverUrl: options.serverUrl }),
    };
  });
  // Loading this module registers the actual production event handlers.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../main');
  return {
    app, windows, start, connect, trayCreate, ipcMain, showMessageBox, openExternal, fetchRelease,
    async becomeReady(beforeCallbacks?: () => void) {
      ready = true;
      beforeCallbacks?.();
      resolveReady();
      await readiness;
    },
  };
}

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => undefined); });
afterEach(() => { jest.restoreAllMocks(); });

describe('main-process startup and window activation', () => {
  it.each(['activate', 'second-instance'])(
    '%s before readiness waits for one initialized startup window', async (event) => {
      const h = launch();
      expect(() => { h.app.emit(event); h.app.emit(event); }).not.toThrow();
      expect(h.windows).toHaveLength(0);
      expect(h.start).not.toHaveBeenCalled();
      await h.becomeReady();
      expect(h.windows).toHaveLength(1);
      expect(h.windows[0]!.loadFile).toHaveBeenCalledWith(expect.stringContaining('starting.html'));
      expect(h.start).toHaveBeenCalledTimes(1);
      h.app.emit(event);
      expect(h.windows).toHaveLength(1);
      expect(h.windows[0]!.focus).toHaveBeenCalledTimes(1);
      expect(h.start).toHaveBeenCalledTimes(1);
    },
  );

  it('loads remote settings before activation can create a window, including the ready callback gap', async () => {
    const h = launch({ serverUrl: 'http://127.0.0.1:43210' });
    h.app.emit('activate');
    await h.becomeReady(() => {
      h.app.emit('activate');
      h.app.emit('second-instance');
    });
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]!.loadURL).toHaveBeenCalledWith('http://127.0.0.1:43210/');
    expect(h.windows[0]!.loadFile).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['activate', 'second-instance'])(
    '%s restores a hidden/minimized window and recreates a destroyed main window', async (event) => {
      const h = launch();
      await h.becomeReady();
      const first = h.windows[0]!;
      first.minimized = true;
      first.visible = false;
      h.app.emit(event);
      expect(first.restore).toHaveBeenCalledTimes(1);
      expect(first.show).toHaveBeenCalledTimes(1);
      expect(first.focus).toHaveBeenCalledTimes(1);
      expect(h.windows).toHaveLength(1);
      first.destroy();
      h.app.emit(event);
      expect(h.windows).toHaveLength(2);
      expect(h.windows[1]!.loadFile).toHaveBeenCalledWith(expect.stringContaining('starting.html'));
      expect(h.start).toHaveBeenCalledTimes(1);
    },
  );

  it('does not start a window, tray or engine if quit was requested before readiness', async () => {
    const h = launch();
    h.app.emit('before-quit', { preventDefault: jest.fn() });
    await h.becomeReady();
    h.app.emit('activate');
    expect(h.windows).toHaveLength(0);
    expect(h.trayCreate).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('exits without initializing when another instance owns the lock', async () => {
    const h = launch({ ownsLock: false });
    await h.becomeReady();
    h.app.emit('activate');
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.windows).toHaveLength(0);
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('desktop update startup wiring', () => {
  const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

  it.each([undefined, 'http://127.0.0.1:43210'])(
    'checks the installed desktop version after showing the window in mode %s', async (serverUrl) => {
      const h = launch({ serverUrl, appVersion: '1.4.3' });
      await h.becomeReady();
      expect(h.fetchRelease).not.toHaveBeenCalled();
      if (serverUrl === undefined) expect(h.start).toHaveBeenCalledTimes(1);
      else expect(h.connect).toHaveBeenCalledTimes(1);
      const window = h.windows[0]!;
      window.emit('ready-to-show');
      expect(window.show).toHaveBeenCalledTimes(1);
      expect(h.app.getVersion).toHaveBeenCalledTimes(1);
      await settle();
      expect(h.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({
        message: 'Songr 1.4.4 is available. Update recommended.',
        detail: expect.stringContaining('Songr desktop 1.4.3'),
        buttons: ['View release', 'Later'], defaultId: 1, cancelId: 1,
      }));
      expect(h.openExternal).not.toHaveBeenCalled();
      h.app.emit('activate');
      h.app.emit('second-instance');
      window.destroy();
      h.app.emit('activate');
      h.windows[1]!.emit('ready-to-show');
      await settle();
      expect(h.fetchRelease).toHaveBeenCalledTimes(1);
      expect(h.showMessageBox).toHaveBeenCalledTimes(1);
    },
  );

  it('opens the system browser only when the native View release button is selected', async () => {
    const h = launch();
    h.showMessageBox.mockResolvedValue({ response: 0 });
    await h.becomeReady();
    h.windows[0]!.emit('ready-to-show');
    await settle();
    expect(h.openExternal).toHaveBeenCalledWith('https://github.com/roethlar/songr/releases/tag/v1.4.4');
  });

  it.each(['quit', 'destroy'])('does not show the update dialog after %s while checking', async (action) => {
    const h = launch();
    await h.becomeReady();
    h.windows[0]!.emit('ready-to-show');
    if (action === 'quit') h.app.emit('before-quit', { preventDefault: jest.fn() });
    else h.windows[0]!.destroy();
    await settle();
    expect(h.showMessageBox).not.toHaveBeenCalled();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('does not show a window or request an update after quitting before ready-to-show', async () => {
    const h = launch();
    await h.becomeReady();
    h.app.emit('before-quit', { preventDefault: jest.fn() });
    h.windows[0]!.emit('ready-to-show');
    await settle();
    expect(h.windows[0]!.show).not.toHaveBeenCalled();
    expect(h.fetchRelease).not.toHaveBeenCalled();
  });
});
