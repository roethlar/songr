import { decideNavigation } from '../navigationPolicy';
import {
  isSettingsSender,
  LOCAL_MODE,
  resolveShellMode,
  shouldReportLoadFailure,
  windowOrigin,
  windowUrl,
} from '../shellMode';
import { DEFAULT_SHELL_SETTINGS } from '../shellSettings';
import { abs, fileUrl } from './support/platformPaths';

const REMOTE = resolveShellMode({
  ...DEFAULT_SHELL_SETTINGS,
  serverUrl: 'http://nas.local:3333/',
});

describe('resolveShellMode', () => {
  it('is local when no server URL is configured', () => {
    expect(resolveShellMode(DEFAULT_SHELL_SETTINGS)).toEqual(LOCAL_MODE);
  });

  it('is remote when one is', () => {
    expect(REMOTE).toEqual({
      kind: 'remote',
      url: 'http://nas.local:3333/',
      origin: 'http://nas.local:3333',
    });
  });

  it('keeps a sub-path in the URL but not in the origin', () => {
    expect(
      resolveShellMode({
        ...DEFAULT_SHELL_SETTINGS,
        serverUrl: 'https://home.example.com/songr/',
      }),
    ).toEqual({
      kind: 'remote',
      url: 'https://home.example.com/songr/',
      origin: 'https://home.example.com',
    });
  });
});

describe('windowUrl / windowOrigin', () => {
  it('shows nothing in local mode until the engine reports its port', () => {
    expect(windowUrl(LOCAL_MODE, null)).toBeNull();
    expect(windowOrigin(LOCAL_MODE, null)).toBeNull();
  });

  it('follows the engine port in local mode', () => {
    expect(windowUrl(LOCAL_MODE, 51_234)).toBe('http://127.0.0.1:51234');
    expect(windowOrigin(LOCAL_MODE, 51_234)).toBe('http://127.0.0.1:51234');
  });

  it('ignores the engine port entirely in remote mode', () => {
    // Nothing is spawned in remote mode, so a port here could only come from a
    // stale supervisor; the window must still point at the configured server.
    expect(windowUrl(REMOTE, 51_234)).toBe('http://nas.local:3333/');
    expect(windowOrigin(REMOTE, 51_234)).toBe('http://nas.local:3333');
    expect(windowOrigin(REMOTE, null)).toBe('http://nas.local:3333');
  });
});

describe('the navigation policy in remote mode', () => {
  const RESOURCES = abs('/app/resources');

  it('lets the configured server load in the app frame', () => {
    expect(
      decideNavigation(
        'http://nas.local:3333/library',
        windowOrigin(REMOTE, null),
        RESOURCES,
      ),
    ).toBe('allow');
  });

  it('still keeps the local shell pages loadable', () => {
    expect(
      decideNavigation(
        fileUrl('/app/resources/settings.html'),
        windowOrigin(REMOTE, null),
        RESOURCES,
      ),
    ).toBe('allow');
  });

  it('does not also allow loopback once a remote server is configured', () => {
    expect(
      decideNavigation(
        'http://127.0.0.1:3333/',
        windowOrigin(REMOTE, null),
        RESOURCES,
      ),
    ).toBe('open-external');
  });

  it('does not allow a different host on the same port', () => {
    expect(
      decideNavigation(
        'http://elsewhere.local:3333/',
        windowOrigin(REMOTE, null),
        RESOURCES,
      ),
    ).toBe('open-external');
  });
});

describe('shouldReportLoadFailure', () => {
  const failure = (over: Partial<Parameters<typeof shouldReportLoadFailure>[0]>) =>
    shouldReportLoadFailure({
      mode: REMOTE,
      failedUrl: 'http://nas.local:3333/',
      errorCode: -102,
      isMainFrame: true,
      ...over,
    });

  it('reports an unreachable configured server', () => {
    expect(failure({})).toBe(true);
  });

  it('stays quiet in local mode, where the supervisor owns failure', () => {
    expect(
      shouldReportLoadFailure({
        mode: LOCAL_MODE,
        failedUrl: 'http://127.0.0.1:51234/',
        errorCode: -102,
        isMainFrame: true,
      }),
    ).toBe(false);
  });

  it('ignores subframe failures', () => {
    expect(failure({ isMainFrame: false })).toBe(false);
  });

  it('ignores an aborted load, which every superseded navigation reports', () => {
    expect(failure({ errorCode: -3 })).toBe(false);
  });

  it('ignores a failure of the error page itself, which would loop forever', () => {
    expect(failure({ failedUrl: fileUrl('/app/resources/error.html') })).toBe(false);
  });

  it('ignores a failure on some other origin', () => {
    expect(failure({ failedUrl: 'http://somewhere.else/' })).toBe(false);
  });

  it('ignores an unparseable failed URL', () => {
    expect(failure({ failedUrl: '' })).toBe(false);
  });
});

describe('isSettingsSender (dt6-1)', () => {
  const page = abs('/app/resources/settings.html');
  const pageUrl = fileUrl('/app/resources/settings.html');

  it('accepts the settings page itself, with or without query and hash', () => {
    expect(isSettingsSender(pageUrl, page)).toBe(true);
    expect(isSettingsSender(`${pageUrl}?tab=network#top`, page)).toBe(true);
  });

  // Chromium keeps `~`, `[` and `]` literal in the frame URL; Node's
  // pathToFileURL encodes them as %7E, %5B, %5D. Electron 43.8.3 on Windows
  // refused the settings page from such directories while the string
  // comparison stood (.agents/plans/desktop-settings-sender-url.md).
  it.each([
    ['a tilde (8.3 short name)', '/Users/SONGRU~1/Programs/Songr/resources/settings.html'],
    ['a tilde and other punctuation', '/opt/tilde~&bang!/resources/settings.html'],
    ['square brackets', '/Applications/sq[x]/Songr.app/Contents/Resources/settings.html'],
    ['all three', '/home/u/[builds]~old/resources/settings.html'],
  ])('accepts the settings page from a directory with %s, spelled as Chromium spells it', (_label, posixPath) => {
    const chromiumUrl = fileUrl(posixPath);
    expect(chromiumUrl).toMatch(/[~[\]]/);
    expect(isSettingsSender(chromiumUrl, abs(posixPath))).toBe(true);
    expect(isSettingsSender(`${chromiumUrl}?tab=network#top`, abs(posixPath))).toBe(true);
  });

  it('accepts a percent-encoded space, which both spellings share', () => {
    expect(
      isSettingsSender(
        fileUrl('/Program%20Files/Songr/resources/settings.html'),
        abs('/Program Files/Songr/resources/settings.html'),
      ),
    ).toBe(true);
  });

  it('refuses every other sender, which is what keeps remote content out', () => {
    expect(isSettingsSender(fileUrl('/app/resources/error.html'), page)).toBe(false);
    expect(isSettingsSender(fileUrl('/other/resources/settings.html'), page)).toBe(false);
    expect(isSettingsSender(fileUrl('/app/resources/settings.html.bak'), page)).toBe(false);
    expect(isSettingsSender(fileUrl('/app/resources'), page)).toBe(false);
    expect(isSettingsSender('file://evil.example/app/resources/settings.html', page)).toBe(false);
    expect(isSettingsSender('http://127.0.0.1:53533/library', page)).toBe(false);
    expect(isSettingsSender('http://evil.example/settings.html', page)).toBe(false);
    expect(isSettingsSender('http://evil.example/app/resources/settings.html', page)).toBe(false);
    expect(isSettingsSender('not a url', page)).toBe(false);
    expect(isSettingsSender(undefined, page)).toBe(false);
    expect(isSettingsSender(null, page)).toBe(false);
    expect(isSettingsSender('', page)).toBe(false);
  });

  it('compares case-insensitively on Windows only, as the filesystems do', () => {
    const upper = fileUrl('/APP/Resources/Settings.html');
    expect(isSettingsSender(upper, page)).toBe(process.platform === 'win32');
  });

  it('refuses a tilde directory that only differs from the page directory', () => {
    const tildePage = abs('/opt/t~1/resources/settings.html');
    expect(isSettingsSender(fileUrl('/opt/t~2/resources/settings.html'), tildePage)).toBe(false);
    expect(isSettingsSender(fileUrl('/opt/t/resources/settings.html'), tildePage)).toBe(false);
  });
});
