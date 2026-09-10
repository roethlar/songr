import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import type { BrowseItem, BrowseResult } from '@shared/types';
import type { ClassicBrowseSessionClaim } from '$lib/stores/classicBrowseSessionStore';
import type { ClassicBrowseCommandOptions, ClassicBrowseOperation } from '@shared/classicBrowseContracts';
import { createRoonSettingsController, type SettingsSessionClient } from '../RoonSettingsController';

function page(items: BrowseItem[] = [], over: Partial<BrowseResult> = {}): BrowseResult {
	return { action: 'list', title: 'Settings', level: 0, offset: 0, count: items.length, items, ...over };
}
const row = (over: Partial<BrowseItem> = {}): BrowseItem => ({
	title: 'Roon option', itemKey: 'item-1', hint: 'list', isLoadable: true, isPlayable: false, ...over
});
function setup(handler: (operation: ClassicBrowseOperation, options: ClassicBrowseCommandOptions) => Promise<BrowseResult>) {
	let identity = 0;
	const request = vi.fn(async (_claim, operation, role, options) => {
		expect(role).toBe('classic-explore');
		expect(options.hierarchy).toBe('settings');
		return handler(operation, options);
	});
	const release = vi.fn();
	const claim = vi.fn(() => ({ owner: 'normal-shell', claimId: ++identity,
		ready: Promise.resolve({ handleId: `settings-${identity}`, generation: identity }) } as ClassicBrowseSessionClaim));
	const controller = createRoonSettingsController({ request, claim, release } as unknown as SettingsSessionClient);
	return { controller, request, claim, release };
}

describe('RoonSettingsController', () => {
	it('requests only while active, reuses an open scope, and releases on close/Core change', async () => {
		const { controller, request, claim, release } = setup(async () => page([row()]));
		await controller.setActive(false);
		expect(claim).not.toHaveBeenCalled();
		await controller.setActive(true, 'zone', 'core-a');
		await controller.setActive(true, 'zone', 'core-a');
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][3]).toEqual({ hierarchy: 'settings', zoneId: 'zone', popAll: true, pageSize: 100 });
		await controller.setActive(true, 'zone', 'core-b');
		expect(release).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledTimes(2);
		controller.close();
		expect(release).toHaveBeenCalledTimes(2);
		expect(get(controller).phase).toBe('idle');
	});

	it('does not fetch a prompt before explicit submission and preserves an empty submitted value', async () => {
		const option = row({ inputPrompt: 'Name', inputPromptValue: 'Current' });
		const { controller, request } = setup(async () => page([option]));
		await controller.setActive(true);
		await controller.activate(option);
		expect(request).toHaveBeenCalledTimes(1);
		await controller.activate(option, '');
		expect(request.mock.calls[1][3]).toMatchObject({ itemKey: option.itemKey, input: '' });
	});

	it('refreshes an action result without repeating its item key or input', async () => {
		const option = row({ hint: 'action', isPlayable: true });
		const { controller, request } = setup(async (_op, options) =>
			'itemKey' in options ? page([], { action: 'message', message: 'Saved', isError: false }) : page([option]));
		await controller.setActive(true);
		await controller.activate(option, 'new value');
		expect(request).toHaveBeenCalledTimes(3);
		expect(request.mock.calls[2][3]).toEqual({ hierarchy: 'settings', refresh: true, pageSize: 100 });
		expect(get(controller)).toMatchObject({ phase: 'ready', message: 'Saved', error: null });
	});

	it('shows public message errors distinctly from an empty settings list', async () => {
		const { controller } = setup(async () => page([], { action: 'message', message: 'Not available', isError: true }));
		await controller.setActive(true);
		expect(get(controller)).toMatchObject({ phase: 'error', result: null, error: 'Not available' });
	});

	it('keeps callback failures visible and retries by reading the root, never replaying an action', async () => {
		let fail = false;
		const { controller, request } = setup(async () => {
			if (fail) throw new Error('Session unavailable');
			return page([row()]);
		});
		await controller.setActive(true);
		fail = true;
		await controller.activate(row());
		expect(get(controller).error).toBe('Session unavailable');
		fail = false;
		await controller.retry();
		expect(request.mock.calls.at(-1)?.[3]).toMatchObject({ popAll: true });
		expect(request.mock.calls.at(-1)?.[3]).not.toHaveProperty('itemKey');
	});

	it('ignores a late response after close and does not issue an action refresh afterward', async () => {
		let finish!: (value: BrowseResult) => void;
		const { controller, request } = setup(async (_op, options) =>
			'itemKey' in options ? new Promise(resolve => { finish = resolve; }) : page([row()]));
		await controller.setActive(true);
		const action = controller.activate(row());
		controller.close();
		finish(page([], { action: 'none' }));
		await action;
		expect(request).toHaveBeenCalledTimes(2);
		expect(get(controller)).toMatchObject({ phase: 'idle', result: null, message: null });
	});

	it('pops the actual current level and appends explicitly requested pages', async () => {
		const { controller, request } = setup(async (operation) => operation === 'load'
			? page([row({ itemKey: 'second' })], { offset: 1, count: 2, totalCount: 2, level: 1 })
			: page([row()], { count: 2, totalCount: 2, level: 1 }));
		await controller.setActive(true);
		await controller.loadMore();
		expect(get(controller).result?.items).toHaveLength(2);
		expect(request.mock.calls[1][3]).toEqual({ hierarchy: 'settings', offset: 1, count: 100 });
		await controller.back();
		expect(request.mock.calls[2][1]).toBe('pop');
		expect(request.mock.calls[2][3]).toMatchObject({ levels: 1 });
	});

	it('does not invoke display-only rows or a second command while one is pending', async () => {
		let finish!: (value: BrowseResult) => void;
		const { controller, request } = setup(async () => new Promise(resolve => { finish = resolve; }));
		const opening = controller.setActive(true);
		await controller.activate(row());
		expect(request).toHaveBeenCalledTimes(1);
		finish(page([row()]));
		await opening;
		await controller.activate(row({ hint: 'header' }));
		await controller.activate(row({ itemKey: undefined }));
		expect(request).toHaveBeenCalledTimes(1);
	});
});
