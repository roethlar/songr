import {
  DEFAULT_NETWORK_PORT,
  DEFAULT_SHELL_SETTINGS,
  SHELL_SETTINGS_FILE,
  SHELL_SETTINGS_VERSION,
  loadShellSettings,
  normalizeShellSettings,
  parseServerUrl,
  parseSettingsDocument,
  saveShellSettings,
  serializeShellSettings,
  settingsFilePath,
  shellSettingsFromForm,
} from '../shellSettings';
import type { SettingsFileIo } from '../shellSettings';

const FILE = `/userdata/${SHELL_SETTINGS_FILE}`;

function warnCollector(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message) => lines.push(message), lines };
}

function ioReturning(contents: string): SettingsFileIo {
  return {
    readFile: () => contents,
    writeFile: () => {
      throw new Error('not expected');
    },
  };
}

function ioThrowing(error: unknown): SettingsFileIo {
  return {
    readFile: () => {
      throw error;
    },
    writeFile: () => {
      throw new Error('not expected');
    },
  };
}

describe('defaults', () => {
  it('has both advanced features off', () => {
    expect(DEFAULT_SHELL_SETTINGS).toEqual({
      serverUrl: null,
      serveOnNetwork: false,
      networkPort: DEFAULT_NETWORK_PORT,
    });
  });

  it('puts the file in the per-user data directory', () => {
    expect(settingsFilePath('/userdata')).toBe(FILE);
  });
});

describe('parseServerUrl', () => {
  it('accepts http and https origins', () => {
    expect(parseServerUrl('http://nas.local:3333')).toBe('http://nas.local:3333/');
    expect(parseServerUrl('https://songr.example.com/')).toBe(
      'https://songr.example.com/',
    );
  });

  it('normalizes any path down to the origin (dt6-3)', () => {
    // Sub-path hosting looked supportable but is not: the UI's asset paths
    // are absolute and socket.io reads a URL path as a namespace, so a
    // stored path would show a broken page with a silently dead tray. The
    // stored value is always a bare origin.
    expect(parseServerUrl('http://nas.local/songr/')).toBe('http://nas.local/');
    expect(parseServerUrl('http://nas.local:3333/roon?x=1#y')).toBe(
      'http://nas.local:3333/',
    );
  });

  it('refuses a URL carrying credentials (dt6-2)', () => {
    // They would be persisted in plaintext and echoed into logs.
    expect(parseServerUrl('http://user:pass@nas.local:3333/')).toBeNull();
    expect(parseServerUrl('http://user@nas.local:3333/')).toBeNull();
  });

  it('trims surrounding whitespace from a pasted address', () => {
    expect(parseServerUrl('  http://nas.local:3333  ')).toBe(
      'http://nas.local:3333/',
    );
  });

  it('rejects every non-web scheme', () => {
    expect(parseServerUrl('file:///etc/passwd')).toBeNull();
    expect(parseServerUrl('javascript:alert(1)')).toBeNull();
    expect(parseServerUrl('ws://nas.local:3333')).toBeNull();
    expect(parseServerUrl('roon://core')).toBeNull();
  });

  it('rejects things that are not URLs at all', () => {
    expect(parseServerUrl('nas.local:3333')).toBeNull();
    expect(parseServerUrl('')).toBeNull();
    expect(parseServerUrl('   ')).toBeNull();
    expect(parseServerUrl(42)).toBeNull();
    expect(parseServerUrl(null)).toBeNull();
    expect(parseServerUrl(undefined)).toBeNull();
  });
});

describe('normalizeShellSettings', () => {
  it('reads a well-formed file', () => {
    expect(
      normalizeShellSettings({
        version: SHELL_SETTINGS_VERSION,
        serverUrl: 'http://nas.local:3333/',
        serveOnNetwork: true,
        networkPort: 4444,
      }),
    ).toEqual({
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: true,
      networkPort: 4444,
    });
  });

  it('falls back to defaults for anything that is not an object', () => {
    for (const raw of [null, 42, 'settings', ['a'], undefined]) {
      expect(normalizeShellSettings(raw)).toEqual(DEFAULT_SHELL_SETTINGS);
    }
  });

  it('drops an invalid serverUrl and warns, keeping the rest of the file', () => {
    const { warn, lines } = warnCollector();
    expect(
      normalizeShellSettings(
        {
          version: SHELL_SETTINGS_VERSION,
          serverUrl: 'file:///etc/passwd',
          serveOnNetwork: true,
          networkPort: 4444,
        },
        warn,
      ),
    ).toEqual({ serverUrl: null, serveOnNetwork: true, networkPort: 4444 });
    expect(lines.join('\n')).toContain('not an http(s) URL');
  });

  it('does not warn about a serverUrl that is simply absent or cleared', () => {
    for (const serverUrl of [undefined, null, '', '   ']) {
      const { warn, lines } = warnCollector();
      normalizeShellSettings(
        { version: SHELL_SETTINGS_VERSION, serverUrl },
        warn,
      );
      expect(lines).toEqual([]);
    }
  });

  it('drops a non-boolean serveOnNetwork', () => {
    const { warn, lines } = warnCollector();
    expect(
      normalizeShellSettings(
        { version: SHELL_SETTINGS_VERSION, serveOnNetwork: 'yes' },
        warn,
      ).serveOnNetwork,
    ).toBe(false);
    expect(lines.join('\n')).toContain('serveOnNetwork');
  });

  it('rejects ports outside the usable range, including 0', () => {
    for (const port of [0, -1, 65_536, 1.5, '3333', null]) {
      expect(
        normalizeShellSettings({
          version: SHELL_SETTINGS_VERSION,
          networkPort: port,
        }).networkPort,
      ).toBe(DEFAULT_NETWORK_PORT);
    }
    expect(
      normalizeShellSettings({ version: SHELL_SETTINGS_VERSION, networkPort: 1 })
        .networkPort,
    ).toBe(1);
    expect(
      normalizeShellSettings({
        version: SHELL_SETTINGS_VERSION,
        networkPort: 65_535,
      }).networkPort,
    ).toBe(65_535);
  });
});

describe('parseSettingsDocument', () => {
  it('reads a well-formed document', () => {
    expect(
      parseSettingsDocument({
        version: SHELL_SETTINGS_VERSION,
        serverUrl: 'http://nas.local:3333/',
        serveOnNetwork: true,
        networkPort: 4444,
      }),
    ).toEqual({
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: true,
      networkPort: 4444,
    });
  });

  it('refuses a document stamped with a version it does not know', () => {
    const { warn, lines } = warnCollector();
    expect(
      parseSettingsDocument(
        { version: 99, serverUrl: 'http://nas.local/', serveOnNetwork: true },
        warn,
      ),
    ).toEqual(DEFAULT_SHELL_SETTINGS);
    expect(lines.join('\n')).toContain('version 99');
  });

  it('refuses a document with no version at all', () => {
    expect(parseSettingsDocument({ serverUrl: 'http://nas.local/' })).toEqual(
      DEFAULT_SHELL_SETTINGS,
    );
  });

  it('does NOT apply the version check to a plain settings object', () => {
    // The version stamp belongs to the stored document, not to the settings
    // shape. Applying it to both is what made the settings page save defaults
    // over every value the user had just typed: the page's settings carry no
    // version, so the writer discarded them. Live-smoke defect; guard here.
    expect(
      normalizeShellSettings({
        serverUrl: 'http://nas.local:3333/',
        serveOnNetwork: true,
        networkPort: 4444,
      }),
    ).toEqual({
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: true,
      networkPort: 4444,
    });
  });
});

describe('loadShellSettings', () => {
  it('reads a stored file', () => {
    expect(
      loadShellSettings({
        filePath: FILE,
        io: ioReturning(
          JSON.stringify({
            version: SHELL_SETTINGS_VERSION,
            serverUrl: 'https://songr.example.com/',
            serveOnNetwork: false,
            networkPort: 3333,
          }),
        ),
      }),
    ).toEqual({
      serverUrl: 'https://songr.example.com/',
      serveOnNetwork: false,
      networkPort: 3333,
    });
  });

  it('is silent on first run, when there is no file yet', () => {
    const { warn, lines } = warnCollector();
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(loadShellSettings({ filePath: FILE, io: ioThrowing(missing), warn })).toEqual(
      DEFAULT_SHELL_SETTINGS,
    );
    expect(lines).toEqual([]);
  });

  it('falls back to defaults when the file cannot be read', () => {
    const { warn, lines } = warnCollector();
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(loadShellSettings({ filePath: FILE, io: ioThrowing(denied), warn })).toEqual(
      DEFAULT_SHELL_SETTINGS,
    );
    expect(lines.join('\n')).toContain('permission denied');
  });

  it('falls back to defaults when the file is not JSON', () => {
    const { warn, lines } = warnCollector();
    expect(
      loadShellSettings({ filePath: FILE, io: ioReturning('{ truncated'), warn }),
    ).toEqual(DEFAULT_SHELL_SETTINGS);
    expect(lines.join('\n')).toContain('not valid JSON');
  });

  it('never throws, whatever the file contains', () => {
    for (const contents of ['', 'null', '[]', '"a string"', '{"version":"1"}']) {
      expect(() =>
        loadShellSettings({ filePath: FILE, io: ioReturning(contents) }),
      ).not.toThrow();
    }
  });
});

describe('saveShellSettings', () => {
  it('writes a versioned document and returns what was stored', () => {
    const written: { path?: string; contents?: string } = {};
    const io: SettingsFileIo = {
      readFile: () => {
        throw new Error('not expected');
      },
      writeFile: (filePath, contents) => {
        written.path = filePath;
        written.contents = contents;
      },
    };

    const stored = saveShellSettings({
      filePath: FILE,
      io,
      settings: {
        version: SHELL_SETTINGS_VERSION,
        serverUrl: 'http://nas.local:3333',
        serveOnNetwork: true,
        networkPort: 4444,
      },
    });

    expect(stored).toEqual({
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: true,
      networkPort: 4444,
    });
    expect(written.path).toBe(FILE);
    expect(JSON.parse(written.contents ?? '')).toEqual({
      version: SHELL_SETTINGS_VERSION,
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: true,
      networkPort: 4444,
    });
  });

  it('round-trips through the serializer', () => {
    const settings = {
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: true,
      networkPort: 4444,
    };
    expect(
      normalizeShellSettings(JSON.parse(serializeShellSettings(settings))),
    ).toEqual(settings);
  });

  it('propagates a write failure so the page can say Save did not work', () => {
    const io: SettingsFileIo = {
      readFile: () => '',
      writeFile: () => {
        throw new Error('disk full');
      },
    };
    expect(() =>
      saveShellSettings({ filePath: FILE, io, settings: DEFAULT_SHELL_SETTINGS }),
    ).toThrow('disk full');
  });
});

describe('the settings page round trip (form -> disk -> next launch)', () => {
  /**
   * The seam the unit tests originally missed and the live smoke caught: the
   * settings page posts a form, the main process converts and writes it, and
   * the next launch reads it back. Each half was tested in isolation and both
   * passed while the join silently wrote defaults over everything.
   */
  function roundTrip(form: Record<string, unknown>) {
    let onDisk = '';
    const io: SettingsFileIo = {
      readFile: () => onDisk,
      writeFile: (_filePath, contents) => {
        onDisk = contents;
      },
    };
    const saved = saveShellSettings({
      filePath: FILE,
      io,
      settings: shellSettingsFromForm(form),
    });
    return { saved, reloaded: loadShellSettings({ filePath: FILE, io }), onDisk };
  }

  it('carries a network-serve toggle all the way to the next launch', () => {
    const { saved, reloaded } = roundTrip({
      serverUrl: '',
      serveOnNetwork: true,
      networkPort: '3333',
    });
    const expected = {
      serverUrl: null,
      serveOnNetwork: true,
      networkPort: 3333,
    };
    expect(saved).toEqual(expected);
    expect(reloaded).toEqual(expected);
  });

  it('carries a remote server URL all the way to the next launch', () => {
    const { saved, reloaded } = roundTrip({
      serverUrl: 'http://nas.local:3333',
      serveOnNetwork: false,
      networkPort: '3333',
    });
    const expected = {
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: false,
      networkPort: 3333,
    };
    expect(saved).toEqual(expected);
    expect(reloaded).toEqual(expected);
  });

  it('stamps the stored document with the schema version', () => {
    const { onDisk } = roundTrip({ serveOnNetwork: true, networkPort: '4444' });
    expect(JSON.parse(onDisk).version).toBe(SHELL_SETTINGS_VERSION);
  });
});

describe('shellSettingsFromForm', () => {
  it('turns the settings page string fields into stored settings', () => {
    expect(
      shellSettingsFromForm({
        serverUrl: 'http://nas.local:3333',
        serveOnNetwork: true,
        networkPort: '4444',
      }),
    ).toEqual({
      serverUrl: 'http://nas.local:3333/',
      serveOnNetwork: true,
      networkPort: 4444,
    });
  });

  it('treats an empty address box as no remote server', () => {
    expect(shellSettingsFromForm({ serverUrl: '', networkPort: '' })).toEqual(
      DEFAULT_SHELL_SETTINGS,
    );
  });

  it('reverts a port that is not a number, and says so', () => {
    const { warn, lines } = warnCollector();
    expect(
      shellSettingsFromForm({ networkPort: 'eighty' }, warn).networkPort,
    ).toBe(DEFAULT_NETWORK_PORT);
    expect(lines.join('\n')).toContain('networkPort');
  });

  it('treats a missing checkbox as off', () => {
    expect(shellSettingsFromForm({}).serveOnNetwork).toBe(false);
    expect(shellSettingsFromForm({ serveOnNetwork: 'on' }).serveOnNetwork).toBe(
      false,
    );
  });
});
