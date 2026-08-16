import { expect, test } from '@playwright/test';

const presentations = [
	{ theme: 'dark', density: 'compact' },
	{ theme: 'dark', density: 'normal' },
	{ theme: 'dark', density: 'pi' },
	{ theme: 'light', density: 'compact' },
	{ theme: 'light', density: 'normal' },
	{ theme: 'light', density: 'pi' }
] as const;

test('the composition page opens from the composer drill and renders in every presentation', async ({
	page
}) => {
	await page.goto('/fixtures/editorial-composition.html');
	await expect(page.locator('html')).toHaveAttribute('data-fixture-ready', 'true');

	// Reach the composer drill through the real palette path.
	await page.getByTestId('unified-find').click();
	await page.getByTestId('unified-palette-input').fill('fixture composer');
	await page.getByText('Composer: Fixture Composer').click();
	await expect(page.getByTestId('unified-drill-label')).toHaveText('Fixture Composer');

	// The Compositions toggle rides its own retained session; the album
	// drill stays the distinct collection destination.
	await page.getByTestId('unified-drill-compositions-toggle').click();
	await expect(page.getByTestId('unified-composition-row-0')).toContainText(
		'Evening Study No. 1'
	);
	await expect(page.getByTestId('unified-composition-row-1')).toContainText(
		'Evening Study No. 2'
	);

	// Open the composition: its own node renders only supplied rows —
	// action-hint rows plus the recording list.
	await page.getByTestId('unified-composition-row-0').click();
	await expect(page.getByTestId('unified-composition-title')).toHaveText('Evening Study No. 1');
	await expect(page.getByTestId('unified-composition-action-0')).toHaveText('Play Work');
	await expect(page.getByTestId('unified-composition-recordings')).toContainText(
		'Evening Study — Hall Recording'
	);

	// One zone executes the supplied action directly with that zone.
	await page.getByTestId('unified-composition-action-0').click();
	await expect
		.poll(async () => page.evaluate(() => window.editorialCompositionFixture.actionLog()))
		.toContain('Play Work@zone-fixture');

	// A selected recording pushes its own supplied node; Back pops one
	// level, mirroring the session stack.
	await page.getByTestId('unified-composition-recording-0').click();
	await expect(page.getByTestId('unified-composition-title')).toHaveText(
		'Evening Study — Hall Recording'
	);
	await page.getByTestId('unified-composition-back').click();
	await expect(page.getByTestId('unified-composition-title')).toHaveText('Evening Study No. 1');

	// The open composition page renders in both themes and every density.
	const titleColors = new Map<string, string>();
	for (const presentation of presentations) {
		await page.evaluate(({ theme, density }) => {
			window.editorialCompositionFixture.setPresentation(theme, density);
		}, presentation);
		await expect(page.getByTestId('unified-pane')).toBeVisible();
		await expect(
			page.locator('.unified-library-mode[data-d="' + presentation.density + '"]')
		).toBeVisible();
		await expect(page.getByTestId('unified-composition-title')).toBeVisible();
		titleColors.set(
			presentation.theme,
			await page
				.getByTestId('unified-composition-title')
				.evaluate((element) => getComputedStyle(element).color)
		);
	}
	expect(titleColors.get('dark')).not.toBe(titleColors.get('light'));
});
