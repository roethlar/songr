import { expect, test, type Page } from '@playwright/test';

type FixtureActionStep =
	| 'choose'
	| 'begin-session-lost'
	| 'hold-resolution'
	| 'outcome-unknown';

async function openAlbum(page: Page): Promise<{ readonly title: string; readonly url: string }> {
	await page.getByTestId('unified-scope-albums').click();
	const album = page.getByTestId('unified-tile').filter({ visible: true }).first();
	const title = (await album.locator('.tt').innerText()).trim();
	await album.click();
	await expect(page.getByTestId('unified-album-title')).toHaveText(title);
	await expect
		.poll(() => page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount))
		.toBe(1);
	return { title, url: page.url() };
}

async function setActionScript(page: Page, steps: FixtureActionStep[]): Promise<void> {
	await page.evaluate((next) => window.libraryScrollFixture.setActionScript(next), steps);
}

async function expectNoPlayback(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => window.libraryScrollFixture.actionExecutions))
		.toBe(0);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expect(page.getByTestId('unified-row').filter({ visible: true }).first()).toBeVisible();
});

test.afterEach(async ({ page }) => {
	await expectNoPlayback(page);
});

test.describe('artwork failure recovery', () => {
	for (const input of ['mouse', 'touch'] as const) {
	 test.describe(input, () => {
		test.use({ hasTouch: input === 'touch' });
		test(`keeps the failed Play intent through More and explicit ${input} Retry`, async ({ page }) => {
			await openAlbum(page);
			await setActionScript(page, ['begin-session-lost', 'begin-session-lost', 'begin-session-lost', 'hold-resolution']);
			const play = page.getByRole('button', { name: /^Play album / });
			if (input === 'touch') {
				await page.locator('.artwork-play').tap();
				await play.tap();
			} else await play.click();
			const status = page.getByRole('alert', { name: 'Album status' });
			const retry = status.getByRole('button', { name: 'Retry action' });
			await expect(retry).toBeVisible();
			const before = await page.evaluate(() => window.libraryScrollFixture.actionBegins);
			expect(before.map(entry => entry.generation)).toEqual([1, 2]);
			expect(before.every(entry => entry.input.desiredSemantic === 'play-now')).toBe(true);
			await page.getByRole('button', { name: /^More actions for album / }).click();
			await expect(page.getByRole('menuitem', { name: 'Retry action' })).toBeVisible();
			expect(await page.evaluate(() => window.libraryScrollFixture.actionBegins)).toEqual(before);
			await page.keyboard.press('Escape');
			if (input === 'touch') await retry.tap(); else await retry.click();
			await expect.poll(() => page.evaluate(() => window.libraryScrollFixture.actionBegins.length)).toBe(4);
			const after = await page.evaluate(() => window.libraryScrollFixture.actionBegins);
			expect(after.map(entry => entry.generation)).toEqual([1, 2, 3, 4]);
			for (const entry of after) {
				expect(entry.input).toEqual({ ...before[0].input, generation: entry.generation });
			}
			await expect(retry).toHaveCount(0);
		});
	 });
	}
});

test('passive mode retirement stays lazy until the next action gesture', async ({ page }) => {
	await openAlbum(page);
	const retired = await page.evaluate(() => window.libraryScrollFixture.sendModeRetired());

	expect(retired).toEqual({ handleId: 'handle-1', generation: 1 });
	expect(await page.evaluate(() => window.libraryScrollFixture.socketConnected)).toBe(true);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(1);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicReleaseCount)).toBe(0);

	await setActionScript(page, ['choose']);
	await page.getByRole('button', { name: /^More actions for album / }).click();
	await expect(page.getByRole('menu', { name: /^More actions for album / })).toBeVisible();
	expect(
		await page.evaluate(() => window.libraryScrollFixture.actionBegins.map((entry) => entry.generation))
	).toEqual([2]);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(2);
	await page.keyboard.press('Escape');
});

test('a first begin refusal invalidates exactly once and reissues on generation 2', async ({
	page
}) => {
	await openAlbum(page);
	await setActionScript(page, ['begin-session-lost', 'choose']);

	await page.getByRole('button', { name: /^More actions for album / }).click();
	await expect(page.getByRole('menu', { name: /^More actions for album / })).toBeVisible();
	expect(
		await page.evaluate(() => window.libraryScrollFixture.actionBegins.map((entry) => entry.generation))
	).toEqual([1, 2]);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(2);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicReleaseCount)).toBe(0);
	await page.keyboard.press('Escape');
});

test('a first resolution refusal gets the same single correlated reissue', async ({ page }) => {
	await openAlbum(page);
	await setActionScript(page, ['hold-resolution', 'choose']);

	await page.getByRole('button', { name: /^More actions for album / }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Working' })).toBeVisible();
	expect(await page.evaluate(() => window.libraryScrollFixture.actionBegins.length)).toBe(1);
	await page.evaluate(() => window.libraryScrollFixture.failCurrentResolution());

	await expect(page.getByRole('menu', { name: /^More actions for album / })).toBeVisible();
	expect(
		await page.evaluate(() => window.libraryScrollFixture.actionBegins.map((entry) => entry.generation))
	).toEqual([1, 2]);
	await page.keyboard.press('Escape');
});

test('the second refusal waits for manual Retry and grants its new one-reissue budget', async ({
	page
}) => {
	await openAlbum(page);
	await setActionScript(page, [
		'begin-session-lost',
		'begin-session-lost',
		'begin-session-lost',
		'choose'
	]);

	await page.getByRole('button', { name: /^More actions for album / }).click();
	const retry = page.getByRole('menuitem', { name: 'Retry action' });
	await expect(retry).toBeVisible();
	expect(
		await page.evaluate(() => window.libraryScrollFixture.actionBegins.map((entry) => entry.generation))
	).toEqual([1, 2]);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(2);
	expect(await page.evaluate(() => window.libraryScrollFixture.currentClassicSession)).toBeNull();

	await retry.click();
	await expect(page.getByRole('menu', { name: /^More actions for album / })).toBeVisible();
	expect(
		await page.evaluate(() => window.libraryScrollFixture.actionBegins.map((entry) => entry.generation))
	).toEqual([1, 2, 3, 4]);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(4);
	await page.keyboard.press('Escape');
});

test('a late retirement for the old exact handle cannot retire its replacement', async ({ page }) => {
	await openAlbum(page);
	const oldSession = await page.evaluate(() => window.libraryScrollFixture.sendModeRetired());
	await setActionScript(page, ['choose']);
	await page.getByRole('button', { name: /^More actions for album / }).click();
	await expect(page.getByRole('menu', { name: /^More actions for album / })).toBeVisible();
	await page.keyboard.press('Escape');

	await page.evaluate(
		(session) => window.libraryScrollFixture.sendModeRetired(session),
		oldSession
	);
	expect(await page.evaluate(() => window.libraryScrollFixture.currentClassicSession)).toEqual({
		handleId: 'handle-2',
		generation: 2
	});
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(2);

	await setActionScript(page, ['choose']);
	await page.getByRole('button', { name: /^More actions for album / }).click();
	await expect(page.getByRole('menu', { name: /^More actions for album / })).toBeVisible();
	expect(
		await page.evaluate(() => window.libraryScrollFixture.actionBegins.map((entry) => entry.generation))
	).toEqual([2, 2]);
	await page.keyboard.press('Escape');
});

test('library-generation retirement re-resolves the open address on its replacement', async ({
	page
}) => {
	const opened = await openAlbum(page);
	const replacement = await page.evaluate(() =>
		window.libraryScrollFixture.replaceRetiredLibraryGeneration()
	);

	expect(replacement).toEqual({ retired: 'fixture-gen-1', replacement: 'fixture-gen-2' });
	await expect(page).toHaveURL(opened.url);
	await expect(page.getByTestId('unified-album-title')).toHaveText(opened.title);
	await expect
		.poll(() =>
			page.evaluate(
				() => window.libraryScrollFixture.liveOpenRefs.at(-1)?.generation ?? null
			)
		)
		.toBe('fixture-gen-2');
});

test('outcome unknown never reacquires or exposes Retry', async ({ page }) => {
	await openAlbum(page);
	await setActionScript(page, ['outcome-unknown']);

	await page.getByRole('button', { name: /^More actions for album / }).click();
	await expect(page.getByRole('alert', { name: 'Album status' })).toContainText(
		'The action may already have executed'
	);
	await expect(page.getByRole('menuitem', { name: 'Retry action' })).toHaveCount(0);
	await page.waitForTimeout(100);
	expect(await page.evaluate(() => window.libraryScrollFixture.actionBegins.length)).toBe(1);
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(1);
});

test('suspending the mode removes its connection listeners before disconnect', async ({ page }) => {
	await expect
		.poll(() => page.evaluate(() => window.libraryScrollFixture.connectionListenerCounts))
		.toEqual({ connect: 1, disconnect: 1 });
	await expect
		.poll(() => page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount))
		.toBe(1);

	await page.evaluate(() => window.libraryScrollFixture.suspendMode());
	expect(await page.evaluate(() => window.libraryScrollFixture.connectionListenerCounts)).toEqual({
		connect: 0,
		disconnect: 0
	});
	const acquisitions = await page.evaluate(
		() => window.libraryScrollFixture.classicAcquisitionCount
	);
	await page.evaluate(() => window.libraryScrollFixture.fireConnection('disconnect'));
	expect(await page.evaluate(() => window.libraryScrollFixture.classicAcquisitionCount)).toBe(
		acquisitions
	);
});
