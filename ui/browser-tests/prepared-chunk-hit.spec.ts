import { expect, test, type Page } from '@playwright/test';

// Prepared Library grids put rows into paint-contained shadow chunks. Any
// paint room given to a chunk must not take input from the previous chunk's
// items or enlarge the scrollable area (rel145-2, rel145-3).

interface ChunkEdge { chunk: number; inside: boolean; clicked: boolean; target: string }

async function chunkEdges(page: Page, selector: string, chunks: number): Promise<ChunkEdge[]> {
	await page.evaluate(() => {
		const record = window as Window & { chunkClicks?: EventTarget[] };
		record.chunkClicks = [];
		document.addEventListener('click', event => {
			record.chunkClicks!.push(event.target!);
			event.preventDefault(); event.stopPropagation();
		}, { capture: true });
	});
	const edges: ChunkEdge[] = [];
	for (let chunk = 0; chunk < chunks; chunk++) {
		const point = await page.evaluate(async ({ index, selector }) => {
			const frame = () => new Promise(requestAnimationFrame);
			const host = document.querySelector<HTMLElement>(selector)!;
			const box = host.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')[index];
			const last = box.querySelector('slot')!.assignedElements().at(-1) as HTMLElement;
			let scroller: HTMLElement | null = host.parentElement;
			while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
			for (let pass = 0; pass < 4; pass++) {
				const rect = last.getBoundingClientRect();
				const view = scroller!.getBoundingClientRect();
				scroller!.scrollTop += rect.top - view.top - scroller!.clientHeight / 2;
				await frame(); await frame();
			}
			const rect = last.getBoundingClientRect();
			const x = rect.left + Math.min(rect.width / 2, 120), y = rect.bottom - 4;
			const hit = document.elementFromPoint(x, y);
			(window as Window & { chunkEdge?: HTMLElement }).chunkEdge = last;
			return { x, y, inside: Boolean(hit && last.contains(hit)), target: hit ? `${hit.tagName}.${hit.className}` : 'none' };
		}, { index: chunk, selector });
		await page.mouse.click(point.x, point.y);
		const clicked = await page.evaluate(() => {
			const record = window as Window & { chunkClicks?: EventTarget[]; chunkEdge?: HTMLElement };
			const target = record.chunkClicks!.at(-1);
			return Boolean(target instanceof Node && record.chunkEdge!.contains(target));
		});
		edges.push({ chunk, inside: point.inside, clicked, target: point.target });
	}
	return edges;
}

/** Scroll extent with the chunks' paint room in place, then with it removed. */
async function scrollExtent(page: Page, selector: string) {
	return page.evaluate(async selector => {
		const frame = () => new Promise(requestAnimationFrame);
		const host = document.querySelector<HTMLElement>(selector)!;
		let scroller: HTMLElement | null = host.parentElement;
		while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
		const measure = () => ({ width: scroller!.scrollWidth, clientWidth: scroller!.clientWidth, height: scroller!.scrollHeight });
		const withRoom = measure();
		const boxes = [...host.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')];
		const saved = boxes.map(box => [box.style.padding, box.style.margin] as const);
		for (const box of boxes) { box.style.padding = '0'; box.style.margin = '0'; }
		await frame();
		const withoutRoom = measure();
		boxes.forEach((box, index) => { box.style.padding = saved[index][0]; box.style.margin = saved[index][1]; });
		return { withRoom, withoutRoom };
	}, selector);
}

test('album tiles at chunk edges take their own clicks', async ({ page }) => {
	await page.addInitScript(() => { window.libraryScrollFixtureSize = { artists: 400, albums: 1000 }; });
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.getByTestId('unified-row').first()).toBeVisible();
	await page.getByTestId('unified-scope-albums').click();
	await expect(page.locator('[data-scope-panel="albums"] .tile').first()).toBeVisible();
	const tiles = '[data-scope-panel="albums"] .tiles';
	const extent = await scrollExtent(page, tiles);
	expect(extent.withRoom).toEqual(extent.withoutRoom);
	for (const edge of await chunkEdges(page, tiles, 3)) {
		expect(edge.inside, `chunk ${edge.chunk} bottom edge hits ${edge.target}`).toBe(true);
		expect(edge.clicked, `chunk ${edge.chunk} bottom edge click target`).toBe(true);
	}
});

test('album track rows at chunk edges take their own clicks and add no scroll area', async ({ page }) => {
	await page.addInitScript(() => { window.libraryScrollFixtureSize = { artists: 40, albums: 400, albumTracks: 100 }; });
	await page.goto('/fixtures/library-scroll.html');
	await expect(page.getByTestId('unified-row').first()).toBeVisible();
	await page.getByTestId('unified-scope-albums').click();
	await page.locator('[data-scope-panel="albums"] .tile').first().click();
	const tracks = '[data-testid="unified-album-tracks"]';
	await expect(page.locator(tracks)).toBeVisible();
	await expect.poll(() => page.locator(tracks).evaluate(node => node.shadowRoot?.querySelectorAll('[data-prepared-library-chunk]').length ?? 0)).toBeGreaterThan(1);
	const extent = await scrollExtent(page, tracks);
	expect(extent.withRoom.width).toBeLessThanOrEqual(extent.withRoom.clientWidth);
	expect(extent.withRoom).toEqual(extent.withoutRoom);
	for (const edge of await chunkEdges(page, tracks, 2)) {
		expect(edge.inside, `chunk ${edge.chunk} bottom edge hits ${edge.target}`).toBe(true);
		expect(edge.clicked, `chunk ${edge.chunk} bottom edge click target`).toBe(true);
	}
});
