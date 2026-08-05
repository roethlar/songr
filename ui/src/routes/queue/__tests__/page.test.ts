import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

// ---------------- Mocks ----------------

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

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

// Import after mocks so the page picks them up.
import QueuePage from '../+page.svelte';
import { goto } from '$app/navigation';
import { emitWithAck } from '$lib/socket/emit';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setSocketStatus } from '$lib/stores/socketStatusStore';
import { queueStore, setQueueSnapshot } from '$lib/stores/queueStore';
import {
	pendingLibraryIntentStore,
	publishLibraryIntent,
	resetLibraryIntentStore
} from '$lib/stores/libraryIntentStore';
import {
	clearCommandFeedback,
	commandFeedbackStore
} from '$lib/stores/commandFeedbackStore';
import type { ZoneQueue } from '@shared/types';

function makeQueue(zoneId: string, ids: number[]): ZoneQueue {
	return {
		zone_id: zoneId,
		items: ids.map((id) => ({
			queue_item_id: id,
			length: 100,
			one_line: { line1: `Track ${id}` }
		})),
		max_item_count: 100,
		updated_at: new Date().toISOString()
	};
}

function subscribeCalls() {
	return vi
		.mocked(emitWithAck)
		.mock.calls.filter(([, event]) => event === 'queue:subscribe');
}

function metadataQueue(): ZoneQueue {
	return {
		zone_id: 'zone-a',
		items: [
			{
				queue_item_id: 73,
				length: 245,
				image_key: 'queue-image-key',
				three_line: {
					line1: 'A Sort of Homecoming',
					line2: 'U2 / Brian Eno',
					line3: 'The Unforgettable Fire'
				}
			}
		],
		max_item_count: 100,
		updated_at: new Date().toISOString()
	};
}

function renderMetadataQueue(): void {
	// Intent publication is local and must not depend on a realtime
	// subscription. Keeping the socket non-connected also prevents the
	// queue subscribe effect from temporarily replacing the rows with a
	// loading state while these producer tests click them.
	setSocketStatus('connecting');
	setSelectedZone('zone-a');
	setQueueSnapshot(metadataQueue());
	render(QueuePage);
}

beforeEach(() => {
	vi.mocked(emitWithAck).mockReset();
	vi.mocked(emitWithAck).mockResolvedValue({ success: true });
	vi.mocked(goto).mockReset();
	vi.mocked(goto).mockResolvedValue(undefined);
	fakeSocket.emit.mockReset();
	fakeSocket.connected = true;
	setSelectedZone('');
	setSocketStatus('connected');
	setQueueSnapshot(makeQueue('zone-a', []));
	resetLibraryIntentStore();
	clearCommandFeedback();
});

describe('Queue page — Library intents', () => {
	it('publishes the exact inert track search before routing to Library', async () => {
		let pendingWhenGotoRan: ReturnType<typeof publishLibraryIntent> = null;
		vi.mocked(goto).mockImplementation(() => {
			pendingWhenGotoRan = get(pendingLibraryIntentStore);
			return Promise.resolve();
		});
		renderMetadataQueue();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'A Sort of Homecoming' }));

		expect(pendingWhenGotoRan!.intent).toEqual({
			kind: 'track',
			destination: 'search',
			query: 'A Sort of Homecoming',
			display: {
				title: 'A Sort of Homecoming',
				artist: 'U2 / Brian Eno',
				album: 'The Unforgettable Fire'
			}
		});
		expect(Object.keys(pendingWhenGotoRan!.intent).sort()).toEqual([
			'destination',
			'display',
			'kind',
			'query'
		]);
		expect(JSON.stringify(pendingWhenGotoRan!.intent)).not.toMatch(
			/queue_item_id|image_key|zone-a|session|itemKey/i
		);
		expect(goto).toHaveBeenCalledWith('/library');
	});

	it('publishes a split artist as an artist search with only an inert display title', async () => {
		renderMetadataQueue();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'Brian Eno' }));

		expect(get(pendingLibraryIntentStore)?.intent).toEqual({
			kind: 'artist',
			destination: 'search',
			query: 'Brian Eno',
			display: { title: 'Brian Eno' }
		});
		expect(goto).toHaveBeenCalledWith('/library');
	});

	it('keeps a metadata-sparse queue identifier out of the Library boundary', async () => {
		setSocketStatus('connecting');
		setSelectedZone('zone-a');
		setQueueSnapshot({
			zone_id: 'zone-a',
			items: [{ queue_item_id: 42, length: 100 }],
			max_item_count: 100,
			updated_at: new Date().toISOString()
		});
		render(QueuePage);
		await tick();

		expect(screen.getByText('Queue item 42')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Queue item 42' })).toBeNull();
		expect(get(pendingLibraryIntentStore)).toBeNull();
		expect(goto).not.toHaveBeenCalled();
	});

	it('cancels a failed navigation request so it cannot replay and reports feedback', async () => {
		vi.mocked(goto).mockRejectedValueOnce(new Error('route unavailable'));
		renderMetadataQueue();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'A Sort of Homecoming' }));

		await waitFor(() => expect(get(pendingLibraryIntentStore)).toBeNull());
		expect(get(commandFeedbackStore)?.message).toMatch(
			/Couldn't open Library: route unavailable/
		);
	});

	it("an older route failure cannot cancel a newer Queue handoff", async () => {
		let rejectFirst!: (reason: Error) => void;
		vi.mocked(goto).mockImplementationOnce(
			() => new Promise<void>((_resolve, reject) => (rejectFirst = reject))
		);
		renderMetadataQueue();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'A Sort of Homecoming' }));
		const first = get(pendingLibraryIntentStore);
		expect(first).not.toBeNull();
		const newer = publishLibraryIntent({
			kind: 'artist',
			destination: 'search',
			query: 'Newer Artist',
			display: { title: 'Newer Artist' }
		});
		expect(newer).not.toBeNull();

		rejectFirst(new Error('first route failed'));
		await waitFor(() => {
			expect(get(pendingLibraryIntentStore)?.requestId).toBe(newer!.requestId);
			expect(get(commandFeedbackStore)?.message).toMatch(/first route failed/);
		});
	});
});

// ---------------- Tests ----------------

describe('Queue page — subscription lifecycle', () => {
	it('subscribes for the selected zone on mount', async () => {
		setSelectedZone('zone-a');
		render(QueuePage);
		await tick();

		expect(subscribeCalls()).toHaveLength(1);
		expect(subscribeCalls()[0][2]).toEqual({ zone_id: 'zone-a' });
	});

	it('re-subscribes when the socket reconnects (stale-queue fix)', async () => {
		// queue-updated events missed while the socket was down are not
		// replayed by the server — without a reconnect re-subscribe the
		// rendered queue stays stale until the next Roon-side change.
		setSelectedZone('zone-a');
		render(QueuePage);
		await tick();
		expect(subscribeCalls()).toHaveLength(1);

		// Drop and recover the connection.
		setSocketStatus('connecting');
		await tick();
		setSocketStatus('connected');
		await tick();

		// The reconnect triggered a second subscribe, whose ack refreshes
		// the snapshot.
		expect(subscribeCalls()).toHaveLength(2);
		expect(subscribeCalls()[1][2]).toEqual({ zone_id: 'zone-a' });
	});

	it('does not emit a doomed subscribe while disconnected; subscribes on recovery', async () => {
		setSocketStatus('connecting');
		setSelectedZone('zone-a');
		render(QueuePage);
		await tick();

		expect(subscribeCalls()).toHaveLength(0);

		setSocketStatus('connected');
		await tick();
		expect(subscribeCalls()).toHaveLength(1);
	});

	it('applies the snapshot returned by the subscribe ack', async () => {
		vi.mocked(emitWithAck).mockResolvedValue({
			success: true,
			data: { queue: makeQueue('zone-a', [1, 2, 3]) }
		});
		setSelectedZone('zone-a');
		render(QueuePage);
		await tick();
		await tick();

		expect(get(queueStore)['zone-a']?.items.map((i) => i.queue_item_id)).toEqual([1, 2, 3]);
	});
});
