/**
 * Which desktop platform is the browser running on?
 *
 * Used for display copy only — "Get Roon Bridge for macOS" reads better
 * than "Get Roon Bridge" — and never to gate behaviour. An unrecognised
 * platform falls back to neutral wording rather than guessing.
 */
export type DesktopPlatform = 'linux' | 'macos' | 'windows' | 'unknown';

/**
 * The official Roon downloads page. Deliberately the page and not a
 * platform-specific installer URL: those move, and hotlinking somebody
 * else's binaries is not this app's business.
 */
export const ROON_DOWNLOADS_URL = 'https://roon.app/downloads';

export interface PlatformSource {
	/** `navigator.userAgentData.platform`, where the browser has it. */
	readonly platform?: string | null;
	readonly userAgent?: string | null;
}

/**
 * Order matters: "Android" contains "Linux" in its user-agent string, and
 * iOS/iPadOS user agents mention "Mac OS X". Neither runs Roon Bridge, so
 * both must be ruled out before the desktop checks.
 */
export function detectPlatform(source: PlatformSource | null | undefined): DesktopPlatform {
	const hint = `${source?.platform ?? ''} ${source?.userAgent ?? ''}`.toLowerCase();
	if (!hint.trim()) return 'unknown';
	if (/android|iphone|ipad|ipod/.test(hint)) return 'unknown';
	// mac/darwin before win: "darwin" contains "win", so the other order
	// labels a Mac's engine string as Windows (dt5-3).
	if (/mac|darwin/.test(hint)) return 'macos';
	if (/win/.test(hint)) return 'windows';
	if (/linux|x11|cros|bsd/.test(hint)) return 'linux';
	return 'unknown';
}

export function platformLabel(platform: DesktopPlatform): string {
	switch (platform) {
		case 'linux':
			return 'Linux';
		case 'macos':
			return 'macOS';
		case 'windows':
			return 'Windows';
		default:
			return 'this computer';
	}
}

/** Reads the live browser, or nothing when there is no browser. */
export function detectCurrentPlatform(): DesktopPlatform {
	if (typeof navigator === 'undefined') return 'unknown';
	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	return detectPlatform({
		platform: data?.platform ?? navigator.platform ?? null,
		userAgent: navigator.userAgent ?? null
	});
}
