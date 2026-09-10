import { expect, test, type Locator, type Page } from '@playwright/test';

const ALBUMS = 3914;
const PANE = '[data-testid="unified-pane"]';
const ALBUM_TILES = '[data-scope-panel="albums"] .tile';
interface ArtworkState {
	requests: Array<{ key: string; startedAt: number; finishedAt: number | null; status: number | 'aborted' | null }>;
	active: number;
	peak: number;
}
async function artworkState(page: Page): Promise<ArtworkState> {
	const response = await page.request.get('/__fixture-artwork/state');
	expect(response.ok()).toBe(true);
	return response.json();
}
async function openAlbums(page: Page, delayMs = 400, failOnce: string[] = []) {
	const configured = await page.request.post('/__fixture-artwork/configure', { data: { delayMs, failOnce } });
	expect(configured.ok()).toBe(true);
	await page.addInitScript(albums => {
		window.libraryScrollFixtureSize = { artists: 1679, albums };
		window.libraryScrollFixturePresentation = { artwork: true, longTitles: true };
	}, ALBUMS);
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.getByTestId('unified-row').first()).toBeVisible();
	await page.getByTestId('unified-scope-albums').click();
	await expect(page.locator(ALBUM_TILES)).toHaveCount(ALBUMS);
	await expect.poll(async () => (await artworkState(page)).active).toBeGreaterThan(0);
}
async function tileKey(tile: Locator): Promise<string> {
	const title = (await tile.locator('.tt').textContent())!;
	const index = title.match(/\d+/)?.[0];
	expect(index, `fixture title has an album index: ${title}`).toBeDefined();
	return `art-${Number(index)}`;
}
async function expectDecoded(tile: Locator) {
	await expect.poll(() => tile.locator('img').evaluate(image =>
		(image as HTMLImageElement).naturalWidth
	), { timeout: 4000 }).toBe(256);
}

test('a distant scroll gives visible covers network access before the old offscreen queue drains', async ({ page }, info) => {
	test.setTimeout(60_000);
	await openAlbums(page);
	const first = await page.locator(ALBUM_TILES).first().elementHandle();
	const last = page.locator(ALBUM_TILES).last();
	const target = await tileKey(last);
	const before = await artworkState(page);
	const height = await page.locator(PANE).evaluate(pane => pane.scrollHeight);
	const scrolledAt = Date.now();
	// Observe structural changes, not src writes: admitting artwork must keep
	// all original rows and their precomputed geometry in place.
	await page.locator(PANE).evaluate(pane => {
		const report = { added: 0, removed: 0 };
		const observer = new MutationObserver(records => records.forEach(record => {
			report.added += record.addedNodes.length; report.removed += record.removedNodes.length;
		}));
		observer.observe(pane, { childList: true, subtree: true });
		(pane as HTMLElement & { artworkMutations?: { report: typeof report; observer: MutationObserver } }).artworkMutations = { report, observer };
		pane.scrollTo({ top: pane.scrollHeight, behavior: 'instant' });
	});
	await expect(last).toBeInViewport();
	await expectDecoded(last);
	const after = await artworkState(page);
	const targetIndex = after.requests.findIndex(request => request.key === target);
	// With native lazy loading the target is request 109 and takes 7.6s under
	// this 400ms origin. A small visible destination must overtake that backlog.
	expect(targetIndex).toBeGreaterThanOrEqual(0);
	expect(targetIndex).toBeLessThan(before.requests.length + 30);
	expect(after.peak).toBeLessThanOrEqual(6);
	expect(await first!.evaluate(node => node.isConnected)).toBe(true);
	await expect(page.locator(ALBUM_TILES)).toHaveCount(ALBUMS);
	expect(await page.locator(PANE).evaluate(pane => pane.scrollHeight)).toBe(height);
	const mutations = await page.locator(PANE).evaluate(pane => {
		const captured = (pane as HTMLElement & { artworkMutations: { report: { added: number; removed: number }; observer: MutationObserver } }).artworkMutations;
		captured.observer.disconnect(); return captured.report;
	});
	expect(mutations).toEqual({ added: 0, removed: 0 });
	console.log(JSON.stringify({ artworkCase: 'distant-scroll', targetIndex,
		startedBefore: before.requests.length, totalStarted: after.requests.length, peak: after.peak,
		targetStartedAfterMs: after.requests[targetIndex].startedAt - scrolledAt,
		targetFinishedAfterMs: after.requests[targetIndex].finishedAt! - scrolledAt }));
	await info.attach('artwork-network-order', { body: JSON.stringify({ target, targetIndex, before, after }), contentType: 'application/json' });
});

test('switching scopes gives new visible covers priority while retaining the album rows', async ({ page }, info) => {
	test.setTimeout(60_000);
	await openAlbums(page);
	const original = await page.locator(ALBUM_TILES).first().elementHandle();
	const before = await artworkState(page);
	const oldKeys = new Set(before.requests.map(request => request.key));
	const switchedAt = Date.now();
	await page.getByTestId('unified-scope-surprise').click();
	const switched = await artworkState(page);
	const candidates = page.locator('[data-scope-panel="surprise"] .tile');
	const scopeKeys = new Set(await candidates.evaluateAll(tiles => tiles.map(tile =>
		`art-${Number(tile.querySelector('.tt')!.textContent!.match(/\d+/)![0])}`
	)));
	let targetTile = candidates.first();
	for (let index = 0; index < 6; index++) {
		const candidate = candidates.nth(index);
		if (!oldKeys.has(await tileKey(candidate))) { targetTile = candidate; break; }
	}
	const target = await tileKey(targetTile);
	expect(oldKeys.has(target)).toBe(false);
	await expect(targetTile).toBeInViewport();
	await expectDecoded(targetTile);
	const after = await artworkState(page);
	const targetIndex = after.requests.findIndex(request => request.key === target);
	expect(targetIndex).toBeGreaterThanOrEqual(0);
	expect(targetIndex).toBeLessThan(before.requests.length + 24);
	// Snapshot after the click commits: an active batch may have started
	// while Playwright waited to click. Once hidden, Albums must not refill
	// any further connection slots ahead of the new scope.
	expect(after.requests.slice(switched.requests.length).filter(request => !scopeKeys.has(request.key))).toEqual([]);
	expect(after.peak).toBeLessThanOrEqual(6);
	await page.getByTestId('unified-scope-albums').click();
	expect(await original!.evaluate(node => node.isConnected)).toBe(true);
	expect(await page.locator(ALBUM_TILES).first().evaluate((node, original) => node === original, original)).toBe(true);
	console.log(JSON.stringify({ artworkCase: 'scope-switch', targetIndex,
		startedBefore: before.requests.length, totalStarted: after.requests.length, peak: after.peak,
		targetStartedAfterMs: after.requests[targetIndex].startedAt - switchedAt,
		targetFinishedAfterMs: after.requests[targetIndex].finishedAt! - switchedAt }));
	await info.attach('scope-artwork-network-order', { body: JSON.stringify({ target, targetIndex, before, after }), contentType: 'application/json' });
});

test('a transient 503 recovers automatically and remains loaded after returning to the same rows', async ({ page }, info) => {
	test.setTimeout(60_000);
	await openAlbums(page, 100, ['art-0']);
	const tile = page.locator(ALBUM_TILES).first();
	expect(await tileKey(tile)).toBe('art-0');
	const originalTile = await tile.elementHandle();
	const originalImage = await tile.locator('img').elementHandle();
	await expectDecoded(tile);
	const recovered = await artworkState(page);
	const attempts = recovered.requests.filter(request => request.key === 'art-0');
	expect(attempts.map(request => request.status)).toEqual([503, 200]);
	await page.getByTestId('unified-scope-artists').click();
	await page.getByTestId('unified-scope-albums').click();
	await expectDecoded(tile);
	expect(await tile.evaluate((node, original) => node === original, originalTile)).toBe(true);
	expect(await tile.locator('img').evaluate((node, original) => node === original, originalImage)).toBe(true);
	expect((await artworkState(page)).requests.filter(request => request.key === 'art-0')).toHaveLength(2);
	console.log(JSON.stringify({ artworkCase: 'transient-recovery', statuses: attempts.map(request => request.status),
		recoveredAfterMs: attempts.at(-1)!.finishedAt! - attempts[0].startedAt }));
	await info.attach('artwork-recovery', { body: JSON.stringify(recovered), contentType: 'application/json' });
});
