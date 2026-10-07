import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });

for (const theme of ['laser', 'miami', 'pop'] as const) {
	for (const grouped of [false, true]) {
		test(`${theme} ${grouped ? 'artist groups' : 'flat albums'} paints complete frames at chunk edges`, async ({ page }, info) => {
			await page.addInitScript(grouped => {
				window.libraryScrollFixtureSize = { artists: 2, albums: 1600 };
				window.libraryScrollFixturePresentation = {
					singleLetter: true, albumsSort: 'az', ...(grouped ? { albumGrouping: 'artist' as const } : {})
				};
			}, grouped);
			await page.goto('/fixtures/library-scroll.html');
			await page.evaluate(theme => window.libraryScrollFixture.setPresentation(theme, 'normal'), theme);
			await page.getByTestId('unified-scope-albums').click();
			const grid = page.locator('[data-scope-panel="albums"] .tiles').first();
			await expect.poll(() => grid.evaluate(node => node.shadowRoot?.querySelectorAll('[data-prepared-library-chunk]').length ?? 0)).toBeGreaterThan(1);
			for (const chunkIndex of [0, 1]) {
				await expect.poll(() => grid.evaluate((node, index) => (node.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')[index]).style.contentVisibility, chunkIndex)).toBe('auto');
				const clip = await grid.evaluate((node, index) => {
					const chunk = node.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')[index];
					const assigned = chunk.querySelector('slot')!.assignedElements();
					const columns = getComputedStyle(chunk).gridTemplateColumns.split(' ').length;
					const pane = document.querySelector<HTMLElement>('[data-testid="unified-pane"]')!;
					const first = assigned[0].querySelector('.art')!;
					pane.scrollTop += first.getBoundingClientRect().top - pane.getBoundingClientRect().top - 180;
					const a = first.getBoundingClientRect();
					const b = assigned[columns - 1].querySelector('.art')!.getBoundingClientRect();
					return { x: Math.floor(a.left - 10), y: Math.floor(a.top - 10), width: Math.ceil(b.right - a.left + 20), height: Math.ceil(a.height + 20) };
				}, chunkIndex);
				await page.waitForTimeout(150);
				const actual = await page.screenshot({ clip, path: info.outputPath(`chunk-${chunkIndex}.png`) });
				// Independent paint oracle: render the same production cards without
				// paint containment. Compare pixels where top/left/right frames belong,
				// rather than merely checking that an outline or shadow is declared.
				await grid.evaluate((node, index) => {
					node.shadowRoot!.querySelectorAll<HTMLElement>('[data-prepared-library-chunk]')[index].style.contentVisibility = 'visible';
				}, chunkIndex);
				await page.waitForTimeout(150);
				const reference = await page.screenshot({ clip, path: info.outputPath(`reference-${chunkIndex}.png`) });
				const differences = await page.evaluate(async ({ actual, reference }) => {
					async function pixels(encoded: string) {
						const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
						const canvas = document.createElement('canvas');
						canvas.width = bitmap.width; canvas.height = bitmap.height;
						const context = canvas.getContext('2d')!;
						context.drawImage(bitmap, 0, 0);
						return context.getImageData(0, 0, canvas.width, canvas.height);
					}
					const [a, b] = await Promise.all([pixels(actual), pixels(reference)]);
					return ['top', 'left', 'right'].map(edge => {
						let changed = 0, total = 0;
						for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
							// Exclude corner antialiasing, which can differ between the
							// compositor and ordinary paint by a few pixels in Chromium.
							if (!(edge === 'top' ? y < 11 : y > 20 && y < a.height - 20 && (edge === 'left' ? x < 11 : x >= a.width - 11))) continue;
							total++;
							const offset = (y * a.width + x) * 4;
							if ([0, 1, 2].some(channel => Math.abs(a.data[offset + channel] - b.data[offset + channel]) > 8)) changed++;
						}
						return { edge, fraction: changed / total };
					});
				}, { actual: actual.toString('base64'), reference: reference.toString('base64') });
				for (const difference of differences) expect(difference.fraction, `chunk ${chunkIndex} ${difference.edge} frame differs from unclipped rendering`).toBeLessThan(0.005);
			}
		});
	}
}
