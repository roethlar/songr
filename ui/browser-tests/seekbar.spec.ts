import { expect, test, type Page } from '@playwright/test';

// songr #13, reported as "the seekbar is impossible to grab" and "cannot be
// dragged at all". Two distinct facts, both only a real engine can settle:
// the strip painted 3px tall must be hit-testable well above that line, and a
// press-and-drag must scrub rather than wait for release and jump.

const TRANSPORT = '[data-seek-variant="transport"]';
const OVERLAY = '[data-seek-variant="overlay"]';

async function open(page: Page): Promise<void> {
	await page.goto('/fixtures/seek-bar.html');
	await page.waitForSelector('html[data-fixture-ready="true"]');
	await page.evaluate(() => window.seekBarFixture.reset());
}

async function boxOf(page: Page, selector: string): Promise<DOMRect> {
	return page.evaluate(
		(sel) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().toJSON(),
		selector
	);
}

async function paintedHeight(page: Page, selector: string): Promise<number> {
	return page.evaluate((sel) => {
		const track = document.querySelector(`${sel} > div`) as HTMLElement;
		return track.getBoundingClientRect().height;
	}, selector);
}

test('the play-bar strip is hit-testable well above the line it paints', async ({ page }) => {
	await open(page);

	const seek = await boxOf(page, TRANSPORT);
	const painted = await paintedHeight(page, TRANSPORT);

	// The painted line stays thin — the point of the padded box is that it is
	// invisible. A "fix" that simply grew the element into a 10px slab would
	// pass a hit test and fail here.
	expect(painted).toBe(3);
	// ...while the interactive box is the full published hit height.
	expect(seek.height).toBe(10);

	// A press 6px above the painted line — inside the box, well clear of the
	// track — still lands on the seek. Before the hit area existed, this
	// point belonged to whatever sat behind it.
	const hit = await page.evaluate(
		([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return (el as HTMLElement | null)?.getAttribute('data-seek-variant') ?? null;
		},
		[seek.left + seek.width / 2, seek.bottom - 6]
	);
	expect(hit).toBe('transport');
});

test('a taller hit height at Pi touch density grows the target, not the paint', async ({
	page
}) => {
	await open(page);
	// What `.play-bar.unified.pi-density` publishes alongside its 14px padding.
	await page.evaluate(() => window.seekBarFixture.setHitHeight(14));

	const seek = await boxOf(page, TRANSPORT);
	expect(seek.height).toBe(14);
	expect(await paintedHeight(page, TRANSPORT)).toBe(3);

	const hit = await page.evaluate(
		([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return (el as HTMLElement | null)?.getAttribute('data-seek-variant') ?? null;
		},
		[seek.left + seek.width / 2, seek.bottom - 11]
	);
	expect(hit).toBe('transport');
});

test('hovering thickens the painted line without moving the target', async ({ page }) => {
	await open(page);

	const before = await boxOf(page, TRANSPORT);
	await page.mouse.move(before.left + before.width / 2, before.bottom - 1);
	await expect
		.poll(async () => paintedHeight(page, TRANSPORT), { timeout: 2000 })
		.toBe(5);

	const after = await boxOf(page, TRANSPORT);
	expect(after.height).toBe(before.height);
	expect(after.bottom).toBe(before.bottom);
});

test('a drag scrubs and lands exactly one seek at the release position', async ({ page }) => {
	await open(page);

	const seek = await boxOf(page, TRANSPORT);
	const y = seek.bottom - 2;

	await page.mouse.move(seek.left + seek.width * 0.1, y);
	await page.mouse.down();
	await page.mouse.move(seek.left + seek.width * 0.4, y, { steps: 5 });

	// Mid-drag the thumb follows the pointer, and nothing has been sent.
	await expect
		.poll(async () =>
			page.evaluate(
				(sel) => (document.querySelector(sel) as HTMLElement).getAttribute('aria-valuenow'),
				TRANSPORT
			)
		)
		.toBe('96');
	expect(await page.evaluate(() => window.seekBarFixture.seeks)).toEqual([]);

	// Off the strip entirely — 80px above a 10px-tall control — which is what
	// a real drag on a footer-edge slider does. Pointer capture keeps it ours.
	await page.mouse.move(seek.left + seek.width * 0.75, y - 80, { steps: 5 });
	await page.mouse.up();

	expect(await page.evaluate(() => window.seekBarFixture.seeks)).toEqual([180]);
});

test('a plain click seeks once, with no second emit from a click handler', async ({ page }) => {
	await open(page);

	const seek = await boxOf(page, TRANSPORT);
	await page.mouse.click(seek.left + seek.width * 0.5, seek.bottom - 2);

	expect(await page.evaluate(() => window.seekBarFixture.seeks)).toEqual([120]);
});

test('the overlay bar is draggable too, and keeps its rounded 6px track', async ({ page }) => {
	await open(page);

	const seek = await boxOf(page, OVERLAY);
	expect(await paintedHeight(page, OVERLAY)).toBe(6);
	expect(
		await page.evaluate(
			(sel) => getComputedStyle(document.querySelector(`${sel} > div`) as HTMLElement).borderRadius,
			OVERLAY
		)
	).toBe('3px');
	// The target is taller than the 6px it paints.
	expect(seek.height).toBe(18);

	await page.mouse.move(seek.left + seek.width * 0.2, seek.top + seek.height / 2);
	await page.mouse.down();
	await page.mouse.move(seek.left + seek.width * 0.5, seek.top + seek.height / 2, { steps: 4 });
	await page.mouse.up();

	expect(await page.evaluate(() => window.seekBarFixture.seeks)).toEqual([120]);
});
