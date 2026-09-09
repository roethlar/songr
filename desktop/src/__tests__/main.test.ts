/** Exercise the real main-process wiring with controlled Electron events. */
import { EventEmitter } from 'node:events';

function launch(options: { serverUrl?: string; ownsLock?: boolean } = {}) {
  jest.resetModules();
  let ready = false;
  let resolveReady!: () => void;
  const readiness = new Promise<void>((resolve) => { resolveReady = resolve; });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    isReady: () => ready,
    whenReady: () => readiness,
    getPath: jest.fn(() => '/isolated/songr-test'),
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
  jest.doMock('electron', () => ({ app, BrowserWindow: FakeWindow, ipcMain, shell: {} }),
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
    app, windows, start, connect, trayCreate, ipcMain,
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
