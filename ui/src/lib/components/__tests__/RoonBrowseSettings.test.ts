import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { BrowseItem, BrowseResult } from '@shared/types';
import type { ClassicBrowseSessionClaim } from '$lib/stores/classicBrowseSessionStore';
import type { ClassicBrowseCommandOptions } from '@shared/classicBrowseContracts';
import { createRoonSettingsController, type SettingsSessionClient } from '$lib/library/RoonSettingsController';
import RoonBrowseSettings from '../RoonBrowseSettings.svelte';

const item = (over: Partial<BrowseItem> = {}): BrowseItem => ({
	title: 'Returned option', itemKey: 'option', hint: 'list', isLoadable: true, isPlayable: false, ...over
});
const page = (items: BrowseItem[], over: Partial<BrowseResult> = {}): BrowseResult => ({
	action: 'list', title: 'Roon options', level: 0, offset: 0, count: items.length, items, ...over
});
function fixture(handler: (options: ClassicBrowseCommandOptions) => Promise<BrowseResult>) {
	const request = vi.fn(async (_claim, _operation, _role, options) => handler(options));
	const release = vi.fn();
	const claim = vi.fn(() => ({ owner: 'normal-shell', claimId: 1,
		ready: Promise.resolve({ handleId: 'fixture-settings', generation: 1 }) } as ClassicBrowseSessionClaim));
	const controller = createRoonSettingsController({ request, claim, release } as unknown as SettingsSessionClient);
	return { controller, request, release, claim };
}

describe('RoonBrowseSettings', () => {
	it('makes no request while closed/disconnected and releases its lease on close', async () => {
		const f = fixture(async () => page([item()]));
		const rendered = render(RoonBrowseSettings, { open: false, connected: true, controller: f.controller });
		expect(f.request).not.toHaveBeenCalled();
		await rendered.rerender({ open: true, connected: false });
		expect(screen.getByText('Connect to a Roon Core to see its settings.')).toBeInTheDocument();
		expect(f.request).not.toHaveBeenCalled();
		await rendered.rerender({ connected: true });
		await screen.findByRole('button', { name: 'Returned option' });
		expect(f.request).toHaveBeenCalledTimes(1);
		await rendered.rerender({ open: false });
		expect(f.release).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('roon-browse-settings')).not.toBeInTheDocument();
	});

	it('renders only returned settings, keeps headers inert, and opens lists on explicit clicks', async () => {
		const f = fixture(async options => 'itemKey' in options
			? page([item({ title: 'Returned action', hint: undefined })], { title: 'Choice menu', level: 1, listHint: 'action_list' })
			: page([item({ title: 'Profile options', hint: 'action_list' }), item({ title: 'Information', hint: 'header' })]));
		render(RoonBrowseSettings, { open: true, connected: true, controller: f.controller });
		await screen.findByRole('button', { name: 'Profile options' });
		expect(screen.queryByRole('button', { name: 'Information' })).not.toBeInTheDocument();
		expect(f.request).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByRole('button', { name: 'Profile options' }));
		await screen.findByRole('button', { name: 'Returned action' });
		expect(f.request).toHaveBeenCalledTimes(2);
		expect(f.request.mock.calls[1][3]).toMatchObject({ itemKey: 'option' });
	});

	it('honors prompt label/action/value/password metadata and submits only on explicit Apply', async () => {
		const option = item({ title: 'Edit secret', inputPrompt: 'Server password', inputPromptAction: 'Store value',
			inputPromptValue: 'initial-secret', inputPromptIsPassword: true });
		const f = fixture(async options => 'itemKey' in options
			? page([], { action: 'message', message: 'Value stored', isError: false }) : page([option]));
		const rendered = render(RoonBrowseSettings, { open: true, connected: true, controller: f.controller });
		await fireEvent.click(await screen.findByRole('button', { name: 'Edit secret' }));
		const input = screen.getByLabelText('Server password');
		expect(input).toHaveAttribute('type', 'password');
		expect(input).toHaveFocus();
		expect(input).toHaveValue('initial-secret');
		expect(f.request).toHaveBeenCalledTimes(1);
		await fireEvent.input(input, { target: { value: '' } });
		await fireEvent.submit(input.closest('form')!);
		await screen.findByText('Value stored');
		expect(f.request.mock.calls[1][3]).toMatchObject({ input: '', itemKey: 'option' });
		expect(f.request.mock.calls[2][3]).not.toHaveProperty('input');
		expect(screen.queryByLabelText('Server password')).not.toBeInTheDocument();
		await rendered.rerender({ open: false });
		expect(f.release).toHaveBeenCalledTimes(1);
	});

	it('cancels an input without transmitting it and clears unsent input on close', async () => {
		const f = fixture(async () => page([item({ inputPrompt: 'Value', inputPromptAction: 'Save' })]));
		const rendered = render(RoonBrowseSettings, { open: true, connected: true, controller: f.controller });
		await fireEvent.click(await screen.findByRole('button', { name: 'Returned option' }));
		await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'unsent' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.getByRole('button', { name: 'Returned option' })).toHaveFocus();
		expect(f.request).toHaveBeenCalledTimes(1);
		expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Returned option' }));
		expect(screen.getByLabelText('Value')).toHaveValue('');
		await rendered.rerender({ open: false });
		expect(f.request).toHaveBeenCalledTimes(1);
	});

	it('shows public errors without claiming the returned collection is empty', async () => {
		const f = fixture(async () => page([], { action: 'message', isError: true, message: 'Settings unavailable' }));
		render(RoonBrowseSettings, { open: true, connected: true, controller: f.controller });
		await screen.findByRole('alert');
		expect(screen.getByRole('alert')).toHaveTextContent('Settings unavailable');
		expect(screen.queryByText('Roon returned no settings here.')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reload Roon Settings' })).toBeInTheDocument();
	});

	it('shows honest empty lists and disposes its controller on unmount', async () => {
		const f = fixture(async () => page([]));
		const rendered = render(RoonBrowseSettings, { open: true, connected: true, controller: f.controller });
		await screen.findByText('Roon returned no settings here.');
		rendered.unmount();
		await waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
	});
});
