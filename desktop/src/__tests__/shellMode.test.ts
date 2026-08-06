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
  const RESOURCES = '/app/resources';

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
        'file:///app/resources/settings.html',
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
    expect(failure({ failedUrl: 'file:///app/resources/error.html' })).toBe(false);
  });

  it('ignores a failure on some other origin', () => {
    expect(failure({ failedUrl: 'http://somewhere.else/' })).toBe(false);
  });

  it('ignores an unparseable failed URL', () => {
    expect(failure({ failedUrl: '' })).toBe(false);
  });
});

describe('isSettingsSender (dt6-1)', () => {
  const page = '/app/resources/settings.html';
  const pageUrl = 'file:///app/resources/settings.html';

  it('accepts the settings page itself, with or without query and hash', () => {
    expect(isSettingsSender(pageUrl, page)).toBe(true);
    expect(isSettingsSender(`${pageUrl}?tab=network#top`, page)).toBe(true);
  });

  it('refuses every other sender, which is what keeps remote content out', () => {
    expect(isSettingsSender('file:///app/resources/error.html', page)).toBe(false);
    expect(isSettingsSender('http://127.0.0.1:53533/library', page)).toBe(false);
    expect(isSettingsSender('http://evil.example/settings.html', page)).toBe(false);
    expect(isSettingsSender(undefined, page)).toBe(false);
    expect(isSettingsSender(null, page)).toBe(false);
    expect(isSettingsSender('', page)).toBe(false);
  });
});
