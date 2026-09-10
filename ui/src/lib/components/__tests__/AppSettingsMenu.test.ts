import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { openSettingsMenu, settingsMenuOpen } from '$lib/stores/settingsMenuStore';
import { setCoreStatus } from '$lib/stores/coreStore';
import {
	loadOnboardingStatus,
	resetOnboardingStatus
} from '$lib/stores/onboardingStore';
import { unifiedLibraryPrefsStore } from '$lib/stores/unifiedLibraryPrefsStore';
import { setTheme } from '$lib/stores/themeStore';
import AppSettingsMenu from '../AppSettingsMenu.svelte';
import * as roonSettingsModule from '$lib/library/RoonSettingsController';
import type { ClassicBrowseSessionClaim } from '$lib/stores/classicBrowseSessionStore';
import AppSettingsMenuHarness from './AppSettingsMenuHarness.svelte';
import { get } from 'svelte/store';
import { createNavigationSettingsStore, navigationSettingsStore } from '$lib/stores/navigationSettingsStore';
import { DEFAULT_NAVIGATION_SETTINGS, type NavigationSettingsSnapshot, type NavigationDestinationId } from '@shared/navigationSettings';

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
	afterEach(() => { vi.restoreAllMocks(); });
	beforeEach(() => {
		settingsMenuOpen.set(false);
		setSocketStatus('disconnected');
		navigationSettingsStore.reset();
		navigationSettingsStore.applySnapshot(DEFAULT_NAVIGATION_SETTINGS);
		unifiedLibraryPrefsStore.setDensity('normal');
		resetOnboardingStatus();
		setCoreStatus({ status: 'paired', core: CORE_A });
		setTheme('dark');
	});

	it('opens Roon options only on demand and closes them with the main dialog', async () => {
		render(AppSettingsMenu);
		expect(screen.queryByTestId('roon-browse-settings')).toBeNull();
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });
		expect(screen.queryByTestId('roon-browse-settings')).toBeNull();
		const options = screen.getByRole('button', { name: 'Roon options' });
		expect(options).toHaveAttribute('aria-expanded', 'false');
		await userEvent.click(options);
		expect(options).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByTestId('roon-browse-settings')).toHaveTextContent('Connect to a Roon Core to see its settings.');
		await fireEvent.click(screen.getByRole('button', { name: 'Close Controller settings' }));
		expect(screen.queryByTestId('roon-browse-settings')).toBeNull();
	});

	it('loads Roon options only when expanded and retires its request session when collapsed', async () => {
		const request = vi.fn(async () => ({
			action: 'list' as const, title: 'Settings', level: 0, offset: 0, count: 1,
			items: [{ title: 'Edit value', itemKey: 'value', inputPrompt: 'Value',
				isLoadable: false, isPlayable: false }]
		}));
		const release = vi.fn();
		const controller = roonSettingsModule.createRoonSettingsController({
			claim: () => ({ owner: 'normal-shell', claimId: 1,
				ready: Promise.resolve({ handleId: 'dialog-settings', generation: 1 }) } as ClassicBrowseSessionClaim),
			request: request as roonSettingsModule.SettingsSessionClient['request'], release
		});
		vi.spyOn(roonSettingsModule, 'createRoonSettingsController').mockReturnValue(controller);
		setSocketStatus('connected');
		render(AppSettingsMenu);
		openSettingsMenu();
		const options = await screen.findByRole('button', { name: 'Roon options' });
		expect(request).not.toHaveBeenCalled();
		await userEvent.click(options);
		await userEvent.click(await screen.findByRole('button', { name: 'Edit value' }));
		await userEvent.type(screen.getByRole('textbox', { name: 'Value' }), 'unsent');
		expect(request).toHaveBeenCalledTimes(1);
		await userEvent.click(options);
		expect(screen.queryByRole('textbox', { name: 'Value' })).toBeNull();
		expect(release).toHaveBeenCalledTimes(1);
		expect(options).toHaveFocus();
		await userEvent.click(options);
		await screen.findByRole('button', { name: 'Edit value' });
		expect(request).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole('textbox', { name: 'Value' })).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Done' }));
		expect(release).toHaveBeenCalledTimes(2);
		openSettingsMenu();
		expect(await screen.findByRole('button', { name: 'Roon options' })).toHaveAttribute('aria-expanded', 'false');
		expect(request).toHaveBeenCalledTimes(2);
	});

	// The desktop shell binds its engine to loopback on a random port unless
	// `serveOnNetwork` is set, and that setting lives in the shell's advanced
	// settings window. Until this entry existed the tray was its only route, so
	// on any desktop without a StatusNotifier host — the Flatpak by ruling,
	// GNOME without an extension — a user could not expose the server at all.
	it('offers advanced settings when running inside the desktop shell', async () => {
		const openAdvanced = vi.fn();
		render(AppSettingsMenu, {
			props: { resolveAdvancedSettings: () => openAdvanced }
		});
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });

		const trigger = screen.getByTestId('settings-open-advanced');
		await fireEvent.click(trigger);
		expect(openAdvanced).toHaveBeenCalledTimes(1);
	});

	it('hides advanced settings in a plain browser tab', async () => {
		// The bridge resolves to null outside the shell; the control must not
		// appear at all rather than appear and fail.
		render(AppSettingsMenu, { props: { resolveAdvancedSettings: () => null } });
		openSettingsMenu();
		await screen.findByRole('dialog', { name: 'Controller settings' });

		expect(screen.queryByTestId('settings-open-advanced')).toBeNull();
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

	it('groups theme and row size together above collapsed navigation and Roon options', async () => {
		render(AppSettingsMenuHarness);
		await openSettings();

		expect(screen.queryByText('Library view')).toBeNull();
		expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
		expect(screen.queryByText('System')).toBeNull();
		const appearance = screen.getByRole('region', { name: 'Appearance' });
		expect(within(appearance).getByRole('group', { name: 'Color theme' })).toBeInTheDocument();
		expect(within(appearance).getByRole('group', { name: 'Library density' })).toBeInTheDocument();
		expect(within(appearance).getByText('This device')).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Density' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Library navigation' })).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(screen.getByTestId('settings-navigation-summary')).toHaveTextContent('Artists · Albums · Genres');
		expect(screen.getByRole('button', { name: 'Roon options' })).toHaveAttribute('aria-expanded', 'false');
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


describe('main Settings — shared Library navigation', () => {
	const snapshot = (revision: number, pinned: readonly NavigationDestinationId[] = ['artists', 'albums', 'genres']): NavigationSettingsSnapshot => ({ ...DEFAULT_NAVIGATION_SETTINGS, revision, pinned });
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
	beforeEach(() => { settingsMenuOpen.set(false); });

	it('shows eligible choices only and reflects another client without rewriting unavailable preferences', async () => {
		const navigationStore = createNavigationSettingsStore();
		navigationStore.applySnapshot(snapshot(4, ['artists', 'tags']));
		navigationStore.setAvailableDestinations(['artists', 'albums']);
		render(AppSettingsMenu, { props: { navigationStore } }); openSettingsMenu();
		await userEvent.click(await screen.findByRole('button', { name: 'Library navigation' }));
		expect(screen.getByText(/all clients connected to this server/)).toBeInTheDocument();
		expect(screen.getAllByRole('checkbox').map(input => input.textContent)).toHaveLength(2);
		expect(screen.queryByRole('checkbox', { name: 'Tags' })).toBeNull();
		expect(screen.getByRole('checkbox', { name: 'Artists' })).toBeChecked();
		navigationStore.applySnapshot(snapshot(5, ['albums', 'tags']));
		await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Albums' })).toBeChecked());
		expect(screen.getByRole('checkbox', { name: 'Artists' })).not.toBeChecked();
		expect(get(navigationStore).snapshot?.pinned).toContain('tags');
	});

	it('keeps a failed checkbox save visibly unsaved, then accepts a successful retry', async () => {
		const navigationStore = createNavigationSettingsStore(); navigationStore.applySnapshot(snapshot(2));
		let finish!: (response: Response) => void;
		const pending = new Promise<Response>(resolve => { finish = resolve; });
		const fetchFn = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(json(snapshot(3, ['artists', 'albums', 'genres', 'favorites']))) as unknown as typeof fetch;
		render(AppSettingsMenu, { props: { navigationStore, fetchFn } }); openSettingsMenu();
		await userEvent.click(await screen.findByRole('button', { name: 'Library navigation' }));
		const favorite = await screen.findByRole('checkbox', { name: 'Favorites' });
		await userEvent.click(favorite);
		expect(favorite).not.toBeChecked(); expect(favorite).toBeDisabled();
		expect(screen.getByText('Saving navigation settings…')).toBeInTheDocument();
		finish(json({ error: 'Disk write failed' }, 503));
		await screen.findByRole('alert'); expect(favorite).not.toBeChecked(); expect(favorite).toBeEnabled();
		expect(screen.getByRole('alert')).toHaveTextContent('not saved');
		await userEvent.click(favorite);
		await waitFor(() => expect(favorite).toBeChecked()); expect(screen.queryByRole('alert')).toBeNull();
	});

	it('keeps save failure and confirmed server choices visible while the editor is collapsed', async () => {
		const navigationStore = createNavigationSettingsStore();
		navigationStore.applySnapshot(snapshot(2, ['artists']));
		let finish!: (response: Response) => void;
		const fetchFn = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
		render(AppSettingsMenu, { props: { navigationStore, fetchFn } });
		openSettingsMenu();
		const toggle = await screen.findByRole('button', { name: 'Library navigation' });
		await userEvent.click(toggle);
		await userEvent.click(screen.getByRole('checkbox', { name: 'Favorites' }));
		await userEvent.click(toggle);
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(screen.getByRole('status')).toHaveTextContent('Saving navigation settings…');
		expect(screen.getByTestId('settings-navigation-summary')).toHaveTextContent('Artists');
		finish(json({ error: 'Disk write failed' }, 503));
		expect(await screen.findByRole('alert')).toHaveTextContent('not saved');
		navigationStore.applySnapshot(snapshot(3, ['albums']));
		await waitFor(() => expect(screen.getByTestId('settings-navigation-summary')).toHaveTextContent('Albums'));
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
	});

	it('uses accessible ordering between eligible neighbors and saves Reset through the server', async () => {
		const navigationStore = createNavigationSettingsStore(); navigationStore.applySnapshot(snapshot(3));
		navigationStore.setAvailableDestinations(['artists', 'albums']);
		const fetchFn = vi.fn(async (_url, init) => {
			const update = JSON.parse(init?.body as string);
			return json({ version: 1, revision: update.expectedRevision + 1, order: update.order, pinned: update.pinned });
		}) as typeof fetch;
		render(AppSettingsMenu, { props: { navigationStore, fetchFn } }); openSettingsMenu();
		await userEvent.click(await screen.findByRole('button', { name: 'Library navigation' }));
		const up = await screen.findByRole('button', { name: 'Move Albums earlier' });
		expect(screen.getByRole('button', { name: 'Move Artists earlier' })).toBeDisabled();
		await userEvent.click(up);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Move Albums earlier' })).toBeDisabled());
		expect(get(navigationStore).snapshot?.order.slice(0, 2)).toEqual(['albums', 'artists']);
		await userEvent.click(screen.getByRole('button', { name: 'Reset navigation defaults' }));
		await waitFor(() => expect(get(navigationStore).snapshot?.revision).toBe(5));
		expect(get(navigationStore).snapshot?.order).toEqual(DEFAULT_NAVIGATION_SETTINGS.order);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('shows current server choices and a conflict message without claiming the edit saved', async () => {
		const navigationStore = createNavigationSettingsStore(); navigationStore.applySnapshot(snapshot(3));
		const fetchFn = vi.fn(async () => json({ error: 'Conflict', current: snapshot(4, ['surprise']) }, 409)) as unknown as typeof fetch;
		render(AppSettingsMenu, { props: { navigationStore, fetchFn } }); openSettingsMenu();
		await userEvent.click(await screen.findByRole('button', { name: 'Library navigation' }));
		await userEvent.click(await screen.findByRole('checkbox', { name: 'Favorites' }));
		await screen.findByText(/another client.*not saved/);
		expect(screen.getByRole('checkbox', { name: 'Surprise me' })).toBeChecked();
		expect(screen.getByRole('checkbox', { name: 'Favorites' })).not.toBeChecked();
	});

	it('loads Settings on opening, exposes read failure, and offers a real retry', async () => {
		const navigationStore = createNavigationSettingsStore();
		const fetchFn = vi.fn().mockResolvedValueOnce(json({ error: 'Unavailable' }, 503)).mockResolvedValueOnce(json(snapshot(0))) as unknown as typeof fetch;
		render(AppSettingsMenu, { props: { navigationStore, fetchFn } }); openSettingsMenu();
		await screen.findByRole('alert'); expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
		await userEvent.click(screen.getByRole('button', { name: 'Retry navigation settings' }));
		await userEvent.click(screen.getByRole('button', { name: 'Library navigation' }));
		await screen.findByRole('checkbox', { name: 'Artists' });
		expect(fetchFn).toHaveBeenCalledTimes(2); expect(screen.queryByRole('alert')).toBeNull();
	});
});
