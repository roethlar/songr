import { gt, prerelease, valid } from 'semver';

export const LATEST_RELEASE_API = 'https://api.github.com/repos/roethlar/songr/releases/latest';
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;
export const MAX_RELEASE_BYTES = 256 * 1024;

export interface StableRelease {
  readonly version: string;
  readonly url: string;
}

class UpdateCheckError extends Error {}

/** Only the fixed repository and a validated stable tag can supply a link. */
export function parseStableRelease(payload: unknown): StableRelease {
  if (payload === null || typeof payload !== 'object') {
    throw new UpdateCheckError('invalid release metadata');
  }
  const release = payload as Record<string, unknown>;
  const tag = release.tag_name;
  if (
    release.draft !== false || release.prerelease !== false ||
    typeof tag !== 'string' || tag !== tag.trim() ||
    !/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(tag)
  ) {
    throw new UpdateCheckError('invalid stable release metadata');
  }
  const version = valid(tag);
  if (version === null || prerelease(version) !== null) {
    throw new UpdateCheckError('invalid stable release version');
  }
  return {
    version,
    url: `https://github.com/roethlar/songr/releases/tag/${encodeURIComponent(tag)}`,
  };
}

/** The deadline includes reading the body; neither redirects nor credentials are used. */
export async function fetchLatestStableRelease(fetchRelease: typeof fetch = fetch): Promise<StableRelease> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new UpdateCheckError('release request timed out'));
      controller.abort();
    }, UPDATE_CHECK_TIMEOUT_MS);
  });
  const request = async (): Promise<StableRelease> => {
    const response = await fetchRelease(LATEST_RELEASE_API, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Songr-desktop-update-check',
      },
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new UpdateCheckError(`release request failed (HTTP ${String(response.status)})`);
    }
    if (response.body === null) {
      throw new UpdateCheckError('empty release response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RELEASE_BYTES) {
          throw new UpdateCheckError('release response too large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new UpdateCheckError('invalid release JSON');
    }
    return parseStableRelease(payload);
  };
  try {
    return await Promise.race([request(), deadline]);
  } catch (error) {
    if (error instanceof UpdateCheckError) throw error;
    throw new UpdateCheckError('release request failed');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

interface DesktopUpdateDependencies {
  readonly getVersion: () => string;
  readonly canPrompt: () => boolean;
  readonly prompt: (release: StableRelease, installedVersion: string) => Promise<'view-release' | 'later'>;
  readonly openRelease: (url: string) => Promise<void>;
  readonly log: (message: string) => void;
  readonly fetchRelease?: typeof fetch;
}

/** One background check per process, independent of the engine's version or mode. */
export class DesktopUpdateCheck {
  private started = false;

  constructor(private readonly dependencies: DesktopUpdateDependencies) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.check();
  }

  private async check(): Promise<void> {
    const { getVersion, canPrompt, prompt, openRelease, log, fetchRelease } = this.dependencies;
    try {
      if (!canPrompt()) return;
      const installedVersion = valid(getVersion());
      if (installedVersion === null) {
        throw new UpdateCheckError('installed app version is invalid');
      }
      const release = await fetchLatestStableRelease(fetchRelease);
      if (!canPrompt() || !gt(release.version, installedVersion)) return;
      const action = await prompt(release, installedVersion);
      if (action === 'view-release' && canPrompt()) {
        await openRelease(release.url);
      }
    } catch (error) {
      log(`updates: ${error instanceof UpdateCheckError ? error.message : 'update check could not complete'}`);
    }
  }
}
