import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { LibraryView } from '$lib/stores/libraryViewStore';
import type { ThemeMode } from '$lib/stores/themeStore';
import AppSettingsMenu from '../AppSettingsMenu.svelte';

interface SettingsProps {
	availableViews: readonly LibraryView[];
	currentView: LibraryView | null;
	onLibraryViewChange: (view: LibraryView) => void;
	theme: ThemeMode;
	onThemeChange: (theme: ThemeMode) => void;
	connectionLabel: string;
	connectionGood: boolean;
	coreName: string | null;
	coreVersion: string | null;
	buildRevision: string;
}

function props(overrides: Partial<SettingsProps> = {}): SettingsProps {
	return {
		availableViews: ['classic'],
		currentView: 'classic',
		onLibraryViewChange: vi.fn(),
		theme: 'dark',
		onThemeChange: vi.fn(),
		connectionLabel: 'Connected',
		connectionGood: true,
		coreName: 'Mock Core',
		coreVersion: '2.0 build 1500',
		buildRevision: 'abc1234',
		...overrides
	};
}

async function openSettings(): Promise<HTMLElement> {
	await userEvent.click(screen.getByRole('button', { name: 'Open Controller settings' }));
	return screen.getByRole('dialog', { name: 'Controller settings' });
}

describe('AppSettingsMenu', () => {
	it('always mounts exactly one dialog trigger and opens an accessible modal', async () => {
		render(AppSettingsMenu, { props: props() });
		const trigger = screen.getByRole('button', { name: 'Open Controller settings' });
		expect(screen.getAllByRole('button', { name: 'Open Controller settings' })).toHaveLength(1);
		expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('dialog', { name: 'Controller settings' })).toBeNull();

		const dialog = await openSettings();
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(trigger).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getAllByRole('button', { name: 'Open Controller settings' })).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Close Controller settings' })).toHaveFocus();
	});

	it('renders Library view radios only from availableViews and identifies the active view', async () => {
		render(AppSettingsMenu, { props: props({ availableViews: ['classic'] }) });
		await openSettings();

		const group = screen.getByRole('group', { name: 'Library view' });
		const radios = within(group).getAllByRole('radio');
		expect(radios).toHaveLength(1);
		expect(within(group).getByRole('radio', { name: /^Classic/ })).toBeChecked();
		expect(within(group).queryByRole('radio', { name: /^Timeline canvas/ })).toBeNull();
		expect(within(group).getByText(/Current view:/)).toHaveTextContent('Current view: Classic');
	});

	it('reports a neutral host state without claiming that a Library view is active', async () => {
		render(AppSettingsMenu, { props: props({ currentView: null }) });
		await openSettings();

		const group = screen.getByRole('group', { name: 'Library view' });
		expect(within(group).getByText(/Current view:/)).toHaveTextContent(
			'Current view: No active view'
		);
		expect(within(group).getByRole('radio', { name: /^Classic/ })).not.toBeChecked();
	});

	it('keeps the checked Library view controlled by currentView until activation is confirmed', async () => {
		const onLibraryViewChange = vi.fn();
		const initial = props({
			availableViews: ['classic', 'timeline'],
			onLibraryViewChange
		});
		const view = render(AppSettingsMenu, { props: initial });
		await openSettings();

		const group = screen.getByRole('group', { name: 'Library view' });
		const classic = within(group).getByRole('radio', { name: /^Classic/ });
		const timeline = within(group).getByRole('radio', { name: /^Timeline canvas/ });
		expect(classic).toBeChecked();
		expect(timeline).not.toBeChecked();

		await userEvent.click(timeline);
		expect(onLibraryViewChange).toHaveBeenCalledOnce();
		expect(onLibraryViewChange).toHaveBeenCalledWith('timeline');
		// The request alone is not activation authority.
		expect(classic).toBeChecked();
		expect(timeline).not.toBeChecked();
		expect(within(group).getByText(/Current view:/)).toHaveTextContent('Current view: Classic');

		await view.rerender({ ...initial, currentView: 'timeline' });
		expect(classic).not.toBeChecked();
		expect(timeline).toBeChecked();
		expect(within(group).getByText(/Current view:/)).toHaveTextContent(
			'Current view: Timeline canvas'
		);
	});

	it('handles native radio Arrow navigation without showing an uncommitted view', async () => {
		const onLibraryViewChange = vi.fn();
		render(AppSettingsMenu, {
			props: props({
				availableViews: ['classic', 'timeline'],
				onLibraryViewChange
			})
		});
		await openSettings();
		const group = screen.getByRole('group', { name: 'Library view' });
		const classic = within(group).getByRole('radio', { name: /^Classic/ });
		const timeline = within(group).getByRole('radio', { name: /^Timeline canvas/ });
		classic.focus();

		await userEvent.keyboard('{ArrowRight}');

		expect(onLibraryViewChange).toHaveBeenCalledOnce();
		expect(onLibraryViewChange).toHaveBeenCalledWith('timeline');
		expect(classic).toBeChecked();
		expect(timeline).not.toBeChecked();
	});

	it('does not request the already-active Library view', async () => {
		const onLibraryViewChange = vi.fn();
		render(AppSettingsMenu, { props: props({ onLibraryViewChange }) });
		await openSettings();

		await userEvent.click(screen.getByRole('radio', { name: /^Classic/ }));
		expect(onLibraryViewChange).not.toHaveBeenCalled();
	});

	it('delegates theme changes without owning the theme state', async () => {
		const onThemeChange = vi.fn();
		const initial = props({ onThemeChange });
		const view = render(AppSettingsMenu, { props: initial });
		await openSettings();

		const appearance = screen.getByRole('group', { name: 'Appearance' });
		expect(within(appearance).getByRole('radio', { name: 'Dark' })).toBeChecked();
		await userEvent.click(within(appearance).getByRole('radio', { name: 'Light' }));
		expect(onThemeChange).toHaveBeenCalledOnce();
		expect(onThemeChange).toHaveBeenCalledWith('light');

		await view.rerender({ ...initial, theme: 'light' });
		expect(within(appearance).getByRole('radio', { name: 'Light' })).toBeChecked();
	});

	it('shows shared connection, Core, version, and build information', async () => {
		render(AppSettingsMenu, { props: props() });
		await openSettings();

		const system = screen.getByRole('heading', { name: 'System' }).parentElement!;
		expect(within(system).getByText('Connected')).toBeInTheDocument();
		expect(within(system).getByText('Mock Core')).toBeInTheDocument();
		expect(within(system).getByText('2.0 build 1500')).toBeInTheDocument();
		expect(within(system).getByText('abc1234')).toBeInTheDocument();
	});

	it('closes with Escape and restores focus to the still-mounted trigger', async () => {
		render(AppSettingsMenu, { props: props() });
		const trigger = screen.getByRole('button', { name: 'Open Controller settings' });
		await openSettings();

		await fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Controller settings' })).toBeNull()
		);
		expect(screen.getByRole('button', { name: 'Open Controller settings' })).toBe(trigger);
		expect(trigger).toHaveFocus();
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
	});

	it('closes only on a direct backdrop click and restores trigger focus', async () => {
		render(AppSettingsMenu, { props: props() });
		const trigger = screen.getByRole('button', { name: 'Open Controller settings' });
		const dialog = await openSettings();

		await fireEvent.click(screen.getByRole('heading', { name: 'System' }));
		expect(screen.getByRole('dialog', { name: 'Controller settings' })).toBeInTheDocument();

		await fireEvent.click(dialog.parentElement!);
		expect(screen.queryByRole('dialog', { name: 'Controller settings' })).toBeNull();
		expect(trigger).toHaveFocus();
	});

	it('traps forward and reverse Tab navigation inside the modal', async () => {
		render(AppSettingsMenu, { props: props() });
		await openSettings();
		const first = screen.getByRole('button', { name: 'Close Controller settings' });
		const last = screen.getByRole('button', { name: 'Done' });

		last.focus();
		await fireEvent.keyDown(window, { key: 'Tab' });
		expect(first).toHaveFocus();

		await fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
		expect(last).toHaveFocus();
	});

	it('uses a floating trigger without changing dialog semantics', async () => {
		render(AppSettingsMenu, { props: props() });
		const trigger = screen.getByRole('button', { name: 'Open Controller settings' });
		expect(trigger.parentElement).toHaveClass('floating');
		await userEvent.click(trigger);
		expect(screen.getByRole('dialog', { name: 'Controller settings' })).toBeInTheDocument();
	});
});
