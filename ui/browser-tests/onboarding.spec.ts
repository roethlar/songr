import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.route('**/api/onboarding', (route) => route.fulfill({
		json: { everPaired: false, hostname: 'studio-desk' }
	}));
	await page.route('**/api/core/discovery', (route) => route.fulfill({ json: { cores: [] } }));
	await page.clock.install();
});

test('discovery explains silence, names a Core, and completes without waiting for a Bridge', async ({ page }, info) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/fixtures/onboarding.html');
	await expect(page.getByText('Searching your local network for a Roon Core…')).toBeVisible();
	await expect(page.getByTestId('onboarding-approval-instructions')).toHaveCount(0);
	await page.clock.fastForward(15_000);
	await expect(page.getByText(/No Roon Core found yet/)).toBeVisible();
	await expect(page.getByText(/A firewall such as UFW/)).toBeVisible();
	await page.screenshot({ path: info.outputPath('discovery-timeout.png') });
	await page.evaluate(() => window.onboardingFixture.setCoreDiscovery({ cores: [{
		id: 'core-a', displayName: 'Studio Core', host: '203.0.113.10', phase: 'connecting'
	}] }));
	await expect(page.getByText('Studio Core', { exact: true })).toBeVisible();
	await expect(page.getByTestId('onboarding-approval-instructions')).toHaveCount(0);
	await page.evaluate(() => window.onboardingFixture.setCoreDiscovery({ cores: [{
		id: 'core-a', displayName: 'Studio Core', host: '203.0.113.10', phase: 'awaiting-approval'
	}] }));
	await expect(page.getByTestId('onboarding-approval-instructions')).toContainText('Songr (studio-desk)');
	await page.evaluate(() => window.onboardingFixture.setCoreStatus({
		status: 'paired', core: { id: 'core-a', displayName: 'Studio Core', displayVersion: '2' }
	}));
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByTestId('onboarding-bridge-note')).toBeVisible();
	await page.getByRole('button', { name: 'Browse library' }).click();
	await expect(page.getByText('Library opened', { exact: true })).toBeVisible();
	await page.screenshot({ path: info.outputPath('optional-bridge.png') });
	await page.getByRole('button', { name: 'Dismiss' }).click();
	await expect(page.getByTestId('onboarding-bridge-note')).toHaveCount(0);
});

test('connection failures remain readable and scrollable on a small screen', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 600 });
	await page.goto('/fixtures/onboarding.html');
	await expect(page.getByText('Searching your local network for a Roon Core…')).toBeVisible();
	await page.evaluate(() => window.onboardingFixture.setCoreDiscovery({ cores: [
		{ id: 'a', displayName: 'Studio Core', host: '203.0.113.10', phase: 'failed', detail: 'Connecting to the Core failed (ECONNREFUSED).' },
		{ id: 'b', displayName: 'Second Core', host: '203.0.113.11', phase: 'failed', detail: 'Reading the Core identity timed out.' }
	] }));
	const panel = page.locator('.onboarding-panel');
	const box = await panel.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	expect(box!.y + box!.height).toBeLessThanOrEqual(600);
	await page.getByText(/Songr cannot determine whether a firewall/).scrollIntoViewIfNeeded();
	await expect(page.getByText(/Songr cannot determine whether a firewall/)).toBeInViewport();
	await expect(page.getByTestId('onboarding-approval-instructions')).toHaveCount(0);
});
