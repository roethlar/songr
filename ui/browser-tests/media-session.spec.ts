import { expect, test } from '@playwright/test';

/**
 * What this proves, and what it does not.
 *
 * PROVES, in the repository-pinned Chromium: the generated silent clip is
 * decodable audio of a usable length, the keepalive plays it unmuted after a
 * user gesture, `MediaMetadata` accepts the artwork array the derivation
 * builds, `setPositionState` accepts the numbers it produces, every action the
 * controller registers is one this engine knows, and teardown leaves the
 * session empty.
 *
 * DOES NOT PROVE that the operating system delivers hardware media keys to the
 * page. That path runs in the browser process from a real key press; no
 * automated harness can synthesise it, and it cannot be checked at all on a
 * host whose OS media panel is not observable. See the media-keys note in
 * README.md.
 */
test('the media session integration works against a real engine', async ({ page }) => {
	await page.goto('/fixtures/media-session.html');

	// A click, so the keepalive starts under a genuine user gesture rather than
	// against the autoplay policy.
	await page.getByTestId('media-session-play').click();

	const state = await page.evaluate(() => window.mediaSessionFixture.sessionState());
	expect(state.title).toBe('Placeholder Track One');
	expect(state.album).toBe('Synthetic Sessions');
	expect(state.artworkCount).toBe(3);
	expect(state.playbackState).toBe('playing');

	// Every action registered without the engine rejecting one.
	expect(await page.evaluate(() => window.mediaSessionFixture.engineErrors)).toEqual([]);

	// The clip really is media this engine can decode, and long enough that
	// Chromium treats it as media rather than a transient sound effect.
	await expect
		.poll(async () => (await page.evaluate(() => window.mediaSessionFixture.keepaliveState())).duration)
		.toBeGreaterThan(5);

	const keepalive = await page.evaluate(() => window.mediaSessionFixture.keepaliveState());
	expect(keepalive.error).toBeNull();
	expect(keepalive.loop).toBe(true);
	// Muting would take the player out of Chromium's media session, which is the
	// one thing this element exists to hold open.
	expect(keepalive.muted).toBe(false);
	expect(keepalive.volume).toBeGreaterThan(0);
	expect(keepalive.paused).toBe(false);

	await expect
		.poll(async () => (await page.evaluate(() => window.mediaSessionFixture.keepaliveState())).currentTime)
		.toBeGreaterThan(0);

	await page.getByTestId('media-session-pause').click();
	expect(await page.evaluate(() => window.mediaSessionFixture.sessionState())).toMatchObject({
		playbackState: 'paused'
	});
	// The paused snapshot carries playbackRate 0 (dt4-1); this engine must
	// accept it, or the position freeze would silently degrade to a no-op —
	// the fixture rethrows setPositionState failures into engineErrors.
	expect(await page.evaluate(() => window.mediaSessionFixture.engineErrors)).toEqual([]);
	// Still holding the session open while paused, so a resume has somewhere to
	// land.
	expect(await page.evaluate(() => window.mediaSessionFixture.keepaliveState())).toMatchObject({
		paused: false
	});

	await page.getByTestId('media-session-stop').click();
	expect(await page.evaluate(() => window.mediaSessionFixture.sessionState())).toMatchObject({
		title: null,
		playbackState: 'none'
	});
	expect(await page.evaluate(() => window.mediaSessionFixture.keepaliveState())).toMatchObject({
		paused: true
	});

	await page.getByTestId('media-session-teardown').click();
	expect(await page.evaluate(() => window.mediaSessionFixture.sessionState())).toMatchObject({
		title: null,
		playbackState: 'none'
	});
});
