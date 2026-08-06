import { describe, expect, it } from 'vitest';

import { ROON_DOWNLOADS_URL, detectPlatform, platformLabel } from '../platform';

describe('detectPlatform', () => {
	it('reads the three desktop platforms from a user-agent string', () => {
		expect(
			detectPlatform({
				userAgent:
					'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
			})
		).toBe('linux');
		expect(
			detectPlatform({
				userAgent:
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
			})
		).toBe('macos');
		expect(
			detectPlatform({
				userAgent:
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
			})
		).toBe('windows');
	});

	it('prefers the platform hint when the browser supplies one', () => {
		expect(detectPlatform({ platform: 'Linux', userAgent: '' })).toBe('linux');
		expect(detectPlatform({ platform: 'macOS', userAgent: '' })).toBe('macos');
		expect(detectPlatform({ platform: 'Windows', userAgent: '' })).toBe('windows');
	});

	it('reads darwin as macOS, not Windows (dt5-3)', () => {
		// "darwin" contains "win": with the checks in the wrong order this
		// string labels a Mac's engine as Windows.
		expect(detectPlatform({ platform: 'darwin', userAgent: '' })).toBe('macos');
		expect(detectPlatform({ userAgent: 'node/22 (darwin; arm64)' })).toBe('macos');
	});

	it('refuses to call a phone or tablet a desktop platform', () => {
		expect(
			detectPlatform({
				userAgent:
					'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'
			})
		).toBe('unknown');
		expect(
			detectPlatform({
				userAgent:
					'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
			})
		).toBe('unknown');
	});

	it('answers unknown rather than guessing when there is nothing to read', () => {
		expect(detectPlatform(null)).toBe('unknown');
		expect(detectPlatform({})).toBe('unknown');
		expect(detectPlatform({ platform: '   ', userAgent: '' })).toBe('unknown');
	});
});

describe('platformLabel', () => {
	it('names each platform the way its vendor does, and stays neutral otherwise', () => {
		expect(platformLabel('linux')).toBe('Linux');
		expect(platformLabel('macos')).toBe('macOS');
		expect(platformLabel('windows')).toBe('Windows');
		expect(platformLabel('unknown')).toBe('this computer');
	});
});

describe('ROON_DOWNLOADS_URL', () => {
	it('points at the official downloads page, not an installer binary', () => {
		expect(ROON_DOWNLOADS_URL).toBe('https://roon.app/downloads');
		expect(ROON_DOWNLOADS_URL).not.toMatch(/\.(exe|dmg|deb|rpm|tar\.gz|zip)$/);
	});
});
