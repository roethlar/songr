import { expect, test, type Page } from '@playwright/test';

// #23: the play bar's artist credit is one line with one ellipsis at rest, and
// hover or keyboard focus reveals the whole credit without changing the bar.

const credit = (page: Page) => page.locator('.unified-artists');

async function openShell(page: Page, playing: 'short' | 'long', width: number, path = '/library') {
	await page.setViewportSize({ width, height: 800 });
	await page.goto(`${path}?shell=1&playing=${playing}`);
	await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');
	await expect(credit(page)).toBeVisible();
}

async function barGeometry(page: Page) {
	return page.evaluate(() => {
		const footer = document.querySelector<HTMLElement>('[aria-label="Playback controls"]')!;
		const transport = footer.querySelector<HTMLElement>('.unified-transport-controls')!;
		return { height: footer.getBoundingClientRect().height, transportLeft: transport.getBoundingClientRect().left };
	});
}

async function lastArtistFullyShown(page: Page) {
	return credit(page).evaluate(line => {
		const box = line.getBoundingClientRect();
		const last = [...line.querySelectorAll('[data-marquee-track] button')].at(-1)!.getBoundingClientRect();
		return last.left >= box.left - 1 && last.right <= box.right + 1;
	});
}

for (const width of [1280, 800]) {
	test(`at rest the credit is one line of whole names and the bar is unchanged (${width}px)`, async ({ page }) => {
		await openShell(page, 'short', width);
		const short = await barGeometry(page);
		await openShell(page, 'long', width);
		const long = await barGeometry(page);
		expect(long).toEqual(short);

		const rest = await credit(page).evaluate(line => ({
			overflows: line.scrollWidth > line.clientWidth + 1,
			lineHeight: line.getBoundingClientRect().height,
			ellipsis: getComputedStyle(line).textOverflow,
			cutNames: [...line.querySelectorAll('[data-marquee-track] button')].filter(button => button.scrollWidth > button.clientWidth + 1).length
		}));
		expect(rest.overflows).toBe(true);
		expect(rest.lineHeight).toBeLessThan(20);
		expect(rest.ellipsis).toBe('ellipsis');
		expect(rest.cutNames).toBe(0);
		expect(await lastArtistFullyShown(page)).toBe(false);
	});

	test(`hover scrolls the whole credit into view and leaving resets it (${width}px)`, async ({ page }) => {
		await openShell(page, 'long', width);
		const before = await barGeometry(page);
		await credit(page).hover();
		await expect(credit(page)).toHaveAttribute('data-reading');
		await expect.poll(() => lastArtistFullyShown(page), { timeout: 20_000 }).toBe(true);
		expect(await barGeometry(page)).toEqual(before);

		await page.mouse.move(5, 5);
		await expect(credit(page)).not.toHaveAttribute('data-reading');
		expect(await lastArtistFullyShown(page)).toBe(false);
	});
}

test('keyboard focus reveals the credit, and clicking an artist still navigates', async ({ page }) => {
	// Away from the Library root an artist click routes there, so the address shows it.
	await openShell(page, 'long', 1280, '/library/albums');
	await credit(page).locator('button').first().focus();
	await expect(credit(page)).toHaveAttribute('data-reading');
	await expect.poll(() => lastArtistFullyShown(page), { timeout: 20_000 }).toBe(true);

	await credit(page).locator('button').first().click();
	await expect.poll(() => new URL(page.url()).pathname).toBe('/library');
});

test('with reduced motion the whole credit is shown still, above the line, and every artist stays clickable', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await openShell(page, 'long', 1280, '/library/albums');
	await credit(page).hover();
	const full = page.locator('.overflow-marquee-full-text');
	await expect(full).toBeVisible();
	const names = ['Fixture Ensemble Alpha', 'Second Invented Performer', 'Third Fixture Voice', 'Fourth Imaginary Guest'];
	await expect(full.locator('button')).toHaveText(names);
	const placement = await page.evaluate(() => {
		const popup = document.querySelector('.overflow-marquee-full-text')!.getBoundingClientRect();
		const line = document.querySelector('.unified-artists')!.getBoundingClientRect();
		const track = getComputedStyle(document.querySelector('.unified-artists [data-marquee-track]')!).transform;
		return { above: popup.bottom <= line.top + 1, track };
	});
	expect(placement.above).toBe(true);
	expect(placement.track === 'none' || placement.track === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
	// The last artist is cut off at rest; its copy in the reveal still opens it.
	expect(await lastArtistFullyShown(page)).toBe(false);
	await full.locator('button').last().click();
	await expect.poll(() => new URL(page.url()).pathname).toBe('/library');
	await expect(full).toHaveCount(0);
});
