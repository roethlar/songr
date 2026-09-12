import {
  DesktopUpdateCheck,
  fetchLatestStableRelease,
  LATEST_RELEASE_API,
  MAX_RELEASE_BYTES,
  parseStableRelease,
  UPDATE_CHECK_TIMEOUT_MS,
} from '../updateCheck';

const release = (tag = 'v1.4.4') => ({ tag_name: tag, draft: false, prerelease: false });
const response = (tag = 'v1.4.4') => new Response(JSON.stringify(release(tag)));
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function harness(installedVersion = '1.4.3', latestTag = 'v1.4.4') {
  const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(response(latestTag));
  const prompt = jest.fn<Promise<'view-release' | 'later'>, []>().mockResolvedValue('later');
  const openRelease = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
  const canPrompt = jest.fn(() => true);
  const log = jest.fn();
  const check = new DesktopUpdateCheck({
    getVersion: () => installedVersion,
    fetchRelease, prompt, openRelease, canPrompt, log,
  });
  return { check, fetchRelease, prompt, openRelease, canPrompt, log };
}

describe('stable public release metadata', () => {
  it.each(['v1.4.4', '1.4.4', 'v1.4.4+build.2'])(
    'accepts %s and derives its link from the fixed repository', (tag) => {
      expect(parseStableRelease({ ...release(tag), html_url: 'https://attacker.invalid/download' }))
        .toEqual({
          version: '1.4.4',
          url: `https://github.com/roethlar/songr/releases/tag/${encodeURIComponent(tag)}`,
        });
    },
  );

  it.each([
    null, [], {}, { ...release(), draft: true }, { ...release(), prerelease: true },
    { ...release(), prerelease: undefined }, { ...release(), draft: undefined },
    release('v1.5.0-beta.1'), release('v1.4'), release('v01.4.4'), release(' v1.4.4'),
    release('v1.4.4\n'), release('v1.4.4/path'), release('v1.4.4+'), release('v1.4.4+build..1'),
  ])('rejects malformed, draft or unstable metadata: %j', (payload) => {
    expect(() => parseStableRelease(payload)).toThrow();
  });
});

describe('bounded unauthenticated release request', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('makes only the fixed public request and forbids redirects and credentials', async () => {
    const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(response());
    await expect(fetchLatestStableRelease(fetchRelease)).resolves.toEqual({
      version: '1.4.4', url: 'https://github.com/roethlar/songr/releases/tag/v1.4.4',
    });
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    expect(fetchRelease).toHaveBeenCalledWith(LATEST_RELEASE_API, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Songr-desktop-update-check',
      },
      redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal),
    });
  });

  it.each([403, 404, 429, 500])('rejects HTTP %s without retrying', async (status) => {
    const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response('', { status }));
    await expect(fetchLatestStableRelease(fetchRelease)).rejects.toThrow(`HTTP ${String(status)}`);
    expect(fetchRelease).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging request to five seconds and aborts it', async () => {
    jest.useFakeTimers();
    const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(() => new Promise(() => undefined));
    const check = fetchLatestStableRelease(fetchRelease);
    const rejection = expect(check).rejects.toThrow('timed out');
    const signal = fetchRelease.mock.calls[0]![1]!.signal!;
    await jest.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('includes a stalled response body in the same deadline', async () => {
    jest.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{')); },
    });
    const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response(body));
    const check = fetchLatestStableRelease(fetchRelease);
    const rejection = expect(check).rejects.toThrow('timed out');
    await jest.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    await rejection;
    expect(fetchRelease.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('bounds accumulated response bytes and aborts oversized responses', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RELEASE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response(body));
    await expect(fetchLatestStableRelease(fetchRelease)).rejects.toThrow('too large');
    expect(fetchRelease.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('rejects malformed JSON', async () => {
    const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(new Response('{broken'));
    await expect(fetchLatestStableRelease(fetchRelease)).rejects.toThrow('invalid release JSON');
  });

  it('does not disclose network error contents in its failure message', async () => {
    const fetchRelease = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockRejectedValue(new Error('private machine details'));
    await expect(fetchLatestStableRelease(fetchRelease)).rejects.toThrow(/^release request failed$/);
  });
});

describe('desktop startup update recommendation', () => {
  it.each([
    ['1.4.3', 'v1.4.4', true],
    ['1.4.3', 'v1.4.3', false],
    ['1.4.3', 'v1.4.2', false],
    ['1.9.0', 'v1.10.0', true],
    ['1.10.0', 'v1.9.0', false],
    ['1.4.4-beta.1', 'v1.4.4', true],
    ['1.4.5-beta.1', 'v1.4.4', false],
    ['1.4.4+local', 'v1.4.4+release', false],
    ['unknown', 'v1.4.4', false],
  ])('compares installed %s with public %s (prompt: %s)', async (installed, latest, newer) => {
    const h = harness(installed, latest);
    h.check.start();
    await settle();
    expect(h.prompt).toHaveBeenCalledTimes(newer ? 1 : 0);
    expect(h.openRelease).not.toHaveBeenCalled();
  });

  it('opens the validated release only after View release is chosen', async () => {
    const h = harness();
    h.prompt.mockResolvedValue('view-release');
    h.check.start();
    expect(h.openRelease).not.toHaveBeenCalled();
    await settle();
    expect(h.prompt).toHaveBeenCalledWith({
      version: '1.4.4', url: 'https://github.com/roethlar/songr/releases/tag/v1.4.4',
    }, '1.4.3');
    expect(h.openRelease).toHaveBeenCalledTimes(1);
    expect(h.openRelease).toHaveBeenCalledWith('https://github.com/roethlar/songr/releases/tag/v1.4.4');
  });

  it('checks once across repeated startup calls, including while pending and after completion', async () => {
    const h = harness();
    h.check.start();
    h.check.start();
    await settle();
    h.check.start();
    await settle();
    expect(h.fetchRelease).toHaveBeenCalledTimes(1);
    expect(h.prompt).toHaveBeenCalledTimes(1);
  });

  it('logs failed checks quietly without a prompt or a repeated attempt', async () => {
    const h = harness();
    h.fetchRelease.mockRejectedValue(new Error('offline'));
    h.check.start();
    await settle();
    h.check.start();
    expect(h.fetchRelease).toHaveBeenCalledTimes(1);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.openRelease).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith('updates: release request failed');
  });

  it('does not request if the app cannot present a prompt at startup', async () => {
    const h = harness();
    h.canPrompt.mockReturnValue(false);
    h.check.start();
    await settle();
    expect(h.fetchRelease).not.toHaveBeenCalled();
  });

  it('does not prompt if its window is destroyed or the app quits during the request', async () => {
    const h = harness();
    h.check.start();
    h.canPrompt.mockReturnValue(false);
    await settle();
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it('does not open the browser after the app quits during the prompt', async () => {
    const h = harness();
    h.prompt.mockImplementation(async () => {
      h.canPrompt.mockReturnValue(false);
      return 'view-release';
    });
    h.check.start();
    await settle();
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(h.openRelease).not.toHaveBeenCalled();
  });

  it.each(['prompt', 'browser'])('handles a failed %s action without an unhandled rejection', async (action) => {
    const h = harness();
    if (action === 'prompt') h.prompt.mockRejectedValue(new Error('dialog failed'));
    else {
      h.prompt.mockResolvedValue('view-release');
      h.openRelease.mockRejectedValue(new Error('browser failed'));
    }
    h.check.start();
    await settle();
    expect(h.log).toHaveBeenCalledWith('updates: update check could not complete');
  });
});
