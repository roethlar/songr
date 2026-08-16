import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeSocket } from '../../../test/fixtures/socket';
const fakeSocket = createFakeSocket();

vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket,
	disconnectSocket: vi.fn()
}));

vi.mock('$lib/socket/emit', () => ({
	emitWithAck: vi.fn().mockResolvedValue({ success: true }),
	emitIfConnected: vi.fn().mockReturnValue(true)
}));

import { emitWithAck } from '$lib/socket/emit';
import { resetQueue, setQueueSnapshot } from '$lib/stores/queueStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import type { Zone, ZoneQueue } from '@shared/types';
import UnifiedQueuePanel from '../UnifiedQueuePanel.svelte';

function zone(): Zone {
	return {
		zone_id: 'zone-a',
		display_name: 'Studio',
		state: 'playing',
		is_play_allowed: true,
		is_pause_allowed: true,
		is_previous_allowed: true,
		is_next_allowed: true,
		is_seek_allowed: true,
		settings: { shuffle: false, auto_radio: true, loop: 'disabled' },
		outputs: []
	};
}

function queue(): ZoneQueue {
	return {
		zone_id: 'zone-a',
		items: [
			{
				queue_item_id: 41,
				length: 245,
				image_key: 'art-41',
				three_line: {
					line1: 'A Sort of Homecoming',
					line2: 'U2 / Brian Eno',
					line3: 'The Unforgettable Fire'
				}
			},
			{
				queue_item_id: 42,
				length: 100,
				two_line: { line1: 'Bad', line2: 'U2' }
			}
		],
		max_item_count: 100,
		updated_at: new Date().toISOString()
	};
}

function callsFor(event: string) {
	return vi.mocked(emitWithAck).mock.calls.filter(([, name]) => name === event);
}

beforeEach(() => {
	vi.mocked(emitWithAck).mockReset();
	vi.mocked(emitWithAck).mockResolvedValue({ success: true });
	fakeSocket.emit.mockReset();
	fakeSocket.connected = true;
	setSocketStatus('connected');
	setSelectedZone('zone-a');
	setZonesSnapshot([zone()]);
	resetQueue();
	setQueueSnapshot(queue());
});

describe('UnifiedQueuePanel', () => {
	it('renders the selected-zone queue in the Unified right-sheet proposal', async () => {
		render(UnifiedQueuePanel, { props: { onclose: vi.fn(), onlibraryintent: vi.fn() } });
		await tick();
		await tick();

		const dialog = screen.getByRole('dialog', { name: 'Queue' });
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveTextContent('Studio');
		expect(dialog).toHaveTextContent('5m total');
		expect(dialog).toHaveTextContent('A Sort of Homecoming');
		expect(dialog).toHaveTextContent('The Unforgettable Fire');
		expect(dialog).toHaveTextContent('NOW');
		expect(screen.getByRole('button', { name: 'Close Queue' })).toHaveFocus();
		expect(callsFor('queue:subscribe')).toHaveLength(1);
		expect(callsFor('queue:subscribe')[0][2]).toEqual({ zone_id: 'zone-a' });
	});

	it('plays from the selected queue row through the existing socket command', async () => {
		render(UnifiedQueuePanel, { props: { onclose: vi.fn(), onlibraryintent: vi.fn() } });
		await fireEvent.click(await screen.findByRole('button', { name: 'Play from Bad' }));

		await waitFor(() => expect(callsFor('queue:play-from-here')).toHaveLength(1));
		expect(callsFor('queue:play-from-here')[0][2]).toEqual({
			zone_id: 'zone-a',
			queue_item_id: 42
		});
	});

	it('ports shuffle, auto-radio, and loop settings without changing their wire shape', async () => {
		render(UnifiedQueuePanel, { props: { onclose: vi.fn(), onlibraryintent: vi.fn() } });
		await tick();
		const controls = screen.getByRole('group', { name: 'Queue playback settings' });

		expect(within(controls).getByRole('button', { name: 'Auto Radio' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await fireEvent.click(within(controls).getByRole('button', { name: 'Shuffle' }));
		await waitFor(() => expect(callsFor('transport:settings')).toHaveLength(1));
		expect(callsFor('transport:settings')[0][2]).toEqual({
			zone_id: 'zone-a',
			shuffle: true
		});

		await fireEvent.click(within(controls).getByRole('button', { name: 'Loop: disabled' }));
		await waitFor(() => expect(callsFor('transport:settings')).toHaveLength(2));
		expect(callsFor('transport:settings')[1][2]).toEqual({
			zone_id: 'zone-a',
			loop: 'loop'
		});
	});

	it('hands queued titles and split artist credits to Unified Library search', async () => {
		const onlibraryintent = vi.fn();
		render(UnifiedQueuePanel, { props: { onclose: vi.fn(), onlibraryintent } });

		await fireEvent.click(
			await screen.findByRole('button', { name: 'Search Library for A Sort of Homecoming' })
		);
		expect(onlibraryintent).toHaveBeenLastCalledWith({
			kind: 'track',
			destination: 'search',
			query: 'A Sort of Homecoming',
			display: {
				title: 'A Sort of Homecoming',
				artist: 'U2 / Brian Eno',
				album: 'The Unforgettable Fire'
			}
		});

		await fireEvent.click(await screen.findByRole('button', { name: 'Search Library for Brian Eno' }));
		expect(onlibraryintent).toHaveBeenLastCalledWith({
			kind: 'artist',
			destination: 'search',
			query: 'Brian Eno',
			display: { title: 'Brian Eno' }
		});
	});

	it('requests close from Escape and the backdrop but not from the panel', async () => {
		const onclose = vi.fn();
		const { container } = render(UnifiedQueuePanel, {
			props: { onclose, onlibraryintent: vi.fn() }
		});
		await tick();

		await fireEvent.click(screen.getByRole('dialog', { name: 'Queue' }));
		expect(onclose).not.toHaveBeenCalled();
		await fireEvent.click(container.querySelector('.queue-backdrop')!);
		expect(onclose).toHaveBeenCalledTimes(1);
		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(onclose).toHaveBeenCalledTimes(2);
	});
});

describe('UnifiedQueuePanel — songr theme', () => {
	async function componentSource(): Promise<string> {
		const fs = await import('node:fs');
		const path = await import('node:path');
		return fs.readFileSync(
			path.resolve(process.cwd(), 'src/routes/library/UnifiedQueuePanel.svelte'),
			'utf8'
		);
	}

	function ruleBody(source: string, selector: string): string {
		const selectorStart = source.indexOf(selector);
		expect(selectorStart).toBeGreaterThan(-1);
		const bodyStart = source.indexOf('{', selectorStart);
		const bodyEnd = source.indexOf('}', bodyStart);
		expect(bodyStart).toBeGreaterThan(selectorStart);
		expect(bodyEnd).toBeGreaterThan(bodyStart);
		return source.slice(bodyStart + 1, bodyEnd);
	}

	function styleBlock(source: string): string {
		const match = source.match(/<style\b[^>]*>[\s\S]*?<\/style>/);
		if (!match) throw new Error('UnifiedQueuePanel must contain a style block');
		return match[0];
	}

	function referencesSongrThemeToken(source: string): boolean {
		return styleBlock(source).includes('var(--songr-');
	}

	it('keeps a distinct outline on focused active playback settings', async () => {
		const source = await componentSource();

		expect(ruleBody(source, '.queue-controls button:focus-visible,')).toContain(
			'outline: 1px solid var(--songr-accent)'
		);
		expect(ruleBody(source, '.queue-controls button.active:focus-visible')).toContain(
			'outline-color: var(--songr-queue-text)'
		);
	});

	it('references the shared songr theme tokens', async () => {
		const source = await componentSource();
		expect(referencesSongrThemeToken(source)).toBe(true);
	});

	it('detects songr theme tokens behind an attributed style tag', () => {
		expect(
			referencesSongrThemeToken(
				'<style lang="postcss">.panel { color: var(--songr-text); }</style>'
			)
		).toBe(true);
	});
});
