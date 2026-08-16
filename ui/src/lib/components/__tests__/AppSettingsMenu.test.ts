import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openSettingsMenu, settingsMenuOpen } from '$lib/stores/settingsMenuStore';
import { setCoreStatus } from '$lib/stores/coreStore';
import {
	loadOnboardingStatus,
	resetOnboardingStatus
} from '$lib/stores/onboardingStore';
import { unifiedLibraryPrefsStore } from '$lib/stores/unifiedLibraryPrefsStore';
import { setTheme } from '$lib/stores/themeStore';
import AppSettingsMenu from '../AppSettingsMenu.svelte';
import AppSettingsMenuHarness from './AppSettingsMenuHarness.svelte';

const CORE_A = {
	id: 'core-a',
	displayName: 'Core Q',
	displayVersion: '2.0'
};

function successfulSwitch() {
	return { accepted: true as const, status: 'discovering' as const };
}

async function seedHostname(hostname: string): Promise<void> {
	const fetchFn = vi.fn(async () =>
		new Response(JSON.stringify({ everPaired: true, hostname }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		})
	) as unknown as typeof fetch;
	await loadOnboardingStatus(fetchFn);
}

async function openSettings(): Promise<HTMLElement> {
	await userEvent.click(screen.getByRole('button', { name: 'Open Controller settings' }));
	return screen.getByRole('dialog', { name: 'Controller settings' });
}

describe('AppSettingsMenu', () => {
	beforeEach(() => {
		settingsMenuOpen.set(false);
		unifiedLibraryPrefsStore.setDensity('normal');
		resetOnboardingStatus();
		setCoreStatus({ status: 'paired', core: CORE_A });
		setTheme('dark');
	});

	it('renders no trigger of its own and opens from the shared store', async () => {
		render(AppSettingsMenu);
		expect(screen.queryByRole('button', { name: 'Open Controller settings' })).toBeNull();
		expect(screen.queryByRole('dialog', { name: 'Controller settings' })).toBeNull();

		openSettingsMenu();
		expect(
			await screen.findByRole('dialog', { name: 'Controller settings' })
		).toHaveAttribute('aria-modal', 'true');
	});

	it('keeps the Controller settings frame and moves density into it', async () => {
		render(AppSettingsMenuHarness);
		await openSettings();

		expect(screen.queryByText('Library view')).toBeNull();
		expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
		expect(screen.queryByText('System')).toBeNull();
		expect(screen.getByRole('heading', { name: 'Density' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
	});

	it('switches the Unified color theme', async () => {
		render(AppSettingsMenuHarness);
		await openSettings();

		const dark = screen.getByRole('button', { name: 'Dark' });
		const light = screen.getByRole('button', { name: 'Light' });
		expect(dark).toHaveAttribute('aria-pressed', 'true');
		expect(light).toHaveAttribute('aria-pressed', 'false');

		await userEvent.click(light);
		expect(document.documentElement).toHaveAttribute('data-theme', 'light');
		expect(light).toHaveAttribute('aria-pressed', 'true');
	});

	it('uses the ruled labels and persists Touch under the stable pi id', async () => {
		const requestDensity = vi.fn(() => true);
		render(AppSettingsMenu, { props: { requestDensity } });
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });

		const compact = screen.getByRole('button', { name: 'Compact' });
		const normal = screen.getByRole('button', { name: 'Normal' });
		const touch = screen.getByRole('button', { name: 'Touch' });
		expect(compact).toHaveAttribute('aria-pressed', 'false');
		expect(normal).toHaveAttribute('aria-pressed', 'true');
		expect(touch).toHaveAttribute('aria-pressed', 'false');
		expect(screen.queryByRole('button', { name: 'Pi' })).toBeNull();

		await userEvent.click(touch);
		expect(requestDensity).toHaveBeenCalledWith('pi');
	});

	it('gives every density button one equal fixed width and height', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(process.cwd(), 'src/lib/components/AppSettingsMenu.svelte'),
			'utf8'
		);
		const rule = source.match(/\.density-button\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? '';
		expect(rule).toContain('flex: 0 0 7rem');
		expect(rule).toContain('width: 7rem');
		expect(rule).toContain('height: 2.75rem');
	});

	it('shows the current Core and requires a focused inline confirmation before requesting', async () => {
		const switchCoreClient = vi.fn(async (_fetchFn: typeof fetch) => successfulSwitch());
		render(AppSettingsMenu, { props: { switchCoreClient } });
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });

		expect(screen.getByTestId('settings-current-core')).toHaveTextContent('Core Q');
		await userEvent.click(screen.getByRole('button', { name: 'Connect to a different Core' }));

		expect(switchCoreClient).not.toHaveBeenCalled();
		const cancel = screen.getByRole('button', { name: 'Cancel' });
		await waitFor(() => expect(cancel).toHaveFocus());
		await userEvent.click(cancel);
		expect(switchCoreClient).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Connect to a different Core' })).toHaveFocus()
		);
	});

	it('requests only on destructive confirmation and gives hostname-specific authorization guidance', async () => {
		await seedHostname('test-songr-host');
		const fetchFn = vi.fn() as unknown as typeof fetch;
		const switchCoreClient = vi.fn(async (_fetchFn: typeof fetch) => successfulSwitch());
		render(AppSettingsMenu, { props: { switchCoreClient, fetchFn } });
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });

		await userEvent.click(screen.getByRole('button', { name: 'Connect to a different Core' }));
		await userEvent.click(
			screen.getByRole('button', { name: 'Disconnect and find another Core' })
		);

		await waitFor(() => expect(switchCoreClient).toHaveBeenCalledWith(fetchFn));
		expect(screen.getByText('Settings → Extensions')).toBeInTheDocument();
		expect(screen.getByText('Songr (test-songr-host)')).toBeInTheDocument();
	});

	it('surfaces a failed request and retries it without bypassing confirmation', async () => {
		const switchCoreClient = vi
			.fn(async (_fetchFn: typeof fetch) => successfulSwitch())
			.mockRejectedValueOnce(new Error('Core reset failed'));
		render(AppSettingsMenu, { props: { switchCoreClient } });
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });

		await userEvent.click(screen.getByRole('button', { name: 'Connect to a different Core' }));
		await userEvent.click(
			screen.getByRole('button', { name: 'Disconnect and find another Core' })
		);
		expect(await screen.findByRole('alert')).toHaveTextContent('Core reset failed');

		await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(switchCoreClient).toHaveBeenCalledTimes(2));
		expect(screen.getByText(/Settings → Extensions/)).toBeInTheDocument();
	});

	it('advances from waiting to the newly paired Core through live store updates', async () => {
		const switchCoreClient = vi.fn(async (_fetchFn: typeof fetch) => successfulSwitch());
		render(AppSettingsMenu, { props: { switchCoreClient } });
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });
		await userEvent.click(screen.getByRole('button', { name: 'Connect to a different Core' }));
		await userEvent.click(
			screen.getByRole('button', { name: 'Disconnect and find another Core' })
		);
		await screen.findByText(/Settings → Extensions/);

		setCoreStatus({ status: 'discovering' });
		await waitFor(() =>
			expect(screen.getByTestId('settings-current-core')).toHaveTextContent('Searching for Core')
		);
		setCoreStatus({
			status: 'paired',
			core: { id: 'core-b', displayName: 'New Core', displayVersion: '2.1' }
		});

		await waitFor(() =>
			expect(screen.getByRole('status')).toHaveTextContent('Connected to New Core.')
		);
		expect(screen.getByTestId('settings-current-core')).toHaveTextContent('New Core');
	});

	it('opens an accessible modal from a store-wired trigger', async () => {
		render(AppSettingsMenuHarness);
		const trigger = screen.getByRole('button', { name: 'Open Controller settings' });
		expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
		expect(trigger).toHaveAttribute('aria-expanded', 'false');

		const dialog = await openSettings();
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(trigger).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByRole('button', { name: 'Close Controller settings' })).toHaveFocus();
	});

	it('closes with Escape and restores focus to the trigger', async () => {
		render(AppSettingsMenuHarness);
		const trigger = screen.getByRole('button', { name: 'Open Controller settings' });
		await openSettings();

		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Controller settings' })).toBeNull()
		);
		expect(trigger).toHaveFocus();
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
	});

	it('closes only on a direct backdrop click and restores trigger focus', async () => {
		render(AppSettingsMenuHarness);
		const trigger = screen.getByRole('button', { name: 'Open Controller settings' });
		const dialog = await openSettings();

		await fireEvent.click(screen.getByRole('heading', { name: 'Controller settings' }));
		expect(screen.getByRole('dialog', { name: 'Controller settings' })).toBeInTheDocument();

		await fireEvent.click(dialog.parentElement!);
		expect(screen.queryByRole('dialog', { name: 'Controller settings' })).toBeNull();
		expect(trigger).toHaveFocus();
	});

	it('restores focus to a replacement settings trigger', async () => {
		render(AppSettingsMenuHarness);
		const opener = screen.getByRole('button', { name: 'Open Controller settings' });
		await openSettings();

		opener.remove();
		const replacement = document.createElement('button');
		replacement.setAttribute('aria-label', 'Open Controller settings');
		document.body.appendChild(replacement);

		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Controller settings' })).toBeNull()
		);
		expect(replacement).toHaveFocus();
		replacement.remove();
	});

	it('traps forward and reverse Tab navigation inside the modal', async () => {
		render(AppSettingsMenuHarness);
		await openSettings();
		const first = screen.getByRole('button', { name: 'Close Controller settings' });
		const last = screen.getByRole('button', { name: 'Done' });

		last.focus();
		await fireEvent.keyDown(window, { key: 'Tab' });
		expect(first).toHaveFocus();

		await fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
		expect(last).toHaveFocus();
	});
});

describe('songr theme contract', () => {
	it('keeps every layout-level overlay on the shared songr theme tokens', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const components = [
			'AppSettingsMenu.svelte',
			'ErrorToast.svelte',
			'NowPlayingOverlay.svelte',
			'ZoneGroupingModal.svelte',
			'TrackActionsMenu.svelte'
		];

		for (const component of components) {
			const source = fs.readFileSync(
				path.resolve(process.cwd(), 'src/lib/components', component),
				'utf8'
			);
			const styleBlock = source.slice(source.indexOf('<style>'));
			expect(styleBlock, component).toContain('var(--songr-');
		}

		const appCss = fs.readFileSync(path.resolve(process.cwd(), 'src/app.css'), 'utf8');
		expect(appCss).toContain("html[data-theme='light']");
		expect(appCss).toContain('--songr-bg: #f3eee5');
		expect(appCss).toContain('--songr-header: #faf6ef');
		expect(appCss).toContain('--songr-accent: #b48732');
	});
});
