import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumActionController, type AlbumActionSocket } from '../AlbumActionController';
import { prepareAlbumBatchAction, dispatchAlbumBatchAction } from '../albumBatchAction';
import { runTrackActionBatch, type TrackActionBatchGuard } from '../trackActionBatch';
import type { AlbumActionChoice } from '@shared/albumActionContracts';

type Emission = { event: string; value: unknown; ack: (value: unknown) => void; expire: () => void };
class Socket implements AlbumActionSocket {
	connected = true;
	readonly emissions: Emission[] = [];
	readonly handlers = new Map<string, Set<(value: unknown) => void>>();
	onEmission?: (emission: Emission) => void;
	on(event: string, handler: (value: unknown) => void) {
		const handlers = this.handlers.get(event) ?? new Set();
		handlers.add(handler); this.handlers.set(event, handlers); return this;
	}
	off(event: string, handler: (value: unknown) => void) { this.handlers.get(event)?.delete(handler); return this; }
	timeout(_milliseconds: number) {
		return { emit: (event: string, value: unknown, ack: (error: unknown, response?: unknown) => void) => {
			const emission = { event, value, ack: (result: unknown) => ack(null, result), expire: () => ack(new Error('timeout')) };
			this.emissions.push(emission); this.onEmission?.(emission); return this;
		} };
	}
	last(event: string) { return this.emissions.filter(e => e.event === event).at(-1)!; }
	count(event: string) { return this.emissions.filter(e => e.event === event).length; }
	resolve(actions: readonly AlbumActionChoice[] = [{ actionId: 'exact-queue', label: 'Queue', semantic: 'queue' }]) {
		const { requestId } = this.last('album-action:begin').value as { requestId: string };
		this.last('album-action:begin').ack({ success: true, data: { requestId, operationId: 'operation-1', resolvingDeadlineAt: 50_000 } });
		const event = { requestId, operationId: 'operation-1', generation: 7, choosingDeadlineAt: 80_000, actions };
		for (const handler of this.handlers.get('album-action:resolved') ?? []) handler(event);
	}
}
const input = { pageId: 'page-1', versionId: 'version-1', zoneId: 'zone-1', tabId: 'tab-1', generation: 7, track: { index: 2, title: 'Selected exact track' } };
const controllers: AlbumActionController[] = [];
function setup() {
	const socket = new Socket();
	let id = 0;
	const controller = new AlbumActionController({ getSocket: () => socket, createRequestId: () => `request-${++id}` });
	controllers.push(controller);
	return { socket, controller, signal: new AbortController(), guard: { assertCurrent: vi.fn(), markIssued: vi.fn() } satisfies TrackActionBatchGuard };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); });

describe('album actions in a track selection batch', () => {
	it('strips auto-execute intent, retains exact track input, and prepares only one matching capability', async () => {
		const { socket, controller, signal, guard } = setup();
		const run = prepareAlbumBatchAction(controller, { ...input, desiredSemantic: 'queue' }, 'queue', guard, signal.signal);
		expect(socket.last('album-action:begin').value).toMatchObject({ track: input.track });
		socket.resolve();
		expect(await run).toEqual({ requestId: 'request-1', actionId: 'exact-queue' });
		expect(socket.count('album-action:execute')).toBe(0);
		expect(guard.markIssued).not.toHaveBeenCalled();
	});

	it.each<{ actions: AlbumActionChoice[] }>([{ actions: [{ actionId: 'exact-play', label: 'Play Now', semantic: 'play-now' }] }, { actions: [
		{ actionId: 'queue-one', label: 'Queue', semantic: 'queue' },
		{ actionId: 'queue-two', label: 'Other Queue', semantic: 'queue' }
	] }])('refuses missing or ambiguous advertised actions without playback ($actions)', async ({ actions }) => {
		const { socket, controller, signal, guard } = setup();
		const run = prepareAlbumBatchAction(controller, input, 'queue', guard, signal.signal);
		const rejected = expect(run).rejects.toThrow();
		socket.resolve(actions);
		await rejected;
		expect(socket.count('album-action:execute')).toBe(0);
	});

	it('reports cancellation during preparation as unattempted rather than failed', async () => {
		const { socket, controller, signal } = setup();
		const run = runTrackActionBatch({
			steps: [{ item: input, semantic: 'queue' as const }], signal: signal.signal, isCurrent: () => true,
			prepare: (item, semantic, guard) => prepareAlbumBatchAction(controller, item, semantic, guard, signal.signal),
			dispatch: (prepared, _item, _semantic, guard) => dispatchAlbumBatchAction(controller, prepared, guard, signal.signal)
		});
		signal.abort();
		expect(await run).toMatchObject({ completed: 0, failed: 0, unattempted: 1, stoppedReason: 'cancelled' });
		expect(socket.count('album-action:execute')).toBe(0);
	});

	it('refuses a prepared choice after a new action request replaces its owner', async () => {
		const { socket, controller, signal, guard } = setup();
		const preparation = prepareAlbumBatchAction(controller, input, 'queue', guard, signal.signal);
		socket.resolve();
		const prepared = await preparation;
		controller.begin(input);
		expect(await dispatchAlbumBatchAction(controller, prepared, guard, signal.signal)).toMatchObject({ status: 'failed' });
		expect(socket.count('album-action:execute')).toBe(0);
		expect(guard.markIssued).not.toHaveBeenCalled();
	});

	it('waits for execution and uses only the exact prepared action ID', async () => {
		const { socket, controller, signal, guard } = setup();
		const preparation = prepareAlbumBatchAction(controller, input, 'queue', guard, signal.signal);
		socket.resolve();
		const prepared = await preparation;
		const run = dispatchAlbumBatchAction(controller, prepared, guard, signal.signal);
		expect(socket.last('album-action:execute').value).toEqual({ actionId: 'exact-queue' });
		expect(guard.markIssued).toHaveBeenCalledTimes(1);
		socket.last('album-action:execute').ack({ success: true, data: { claimed: true, outcome: 'executed' } });
		expect(await run).toEqual({ status: 'completed' });
	});

	it('retains known success when cancellation arrives immediately after a synchronous acknowledgement', async () => {
		const { socket, controller, signal, guard } = setup();
		const preparation = prepareAlbumBatchAction(controller, input, 'queue', guard, signal.signal);
		socket.resolve();
		const prepared = await preparation;
		socket.onEmission = emission => {
			if (emission.event !== 'album-action:execute') return;
			emission.ack({ success: true, data: { claimed: true, outcome: 'executed' } });
			signal.abort();
		};
		expect(await dispatchAlbumBatchAction(controller, prepared, guard, signal.signal)).toEqual({ status: 'completed' });
	});

	it('reports an execute timeout as uncertain without replaying', async () => {
		const { socket, controller, signal, guard } = setup();
		const preparation = prepareAlbumBatchAction(controller, input, 'queue', guard, signal.signal);
		socket.resolve();
		const prepared = await preparation;
		const run = dispatchAlbumBatchAction(controller, prepared, guard, signal.signal);
		socket.last('album-action:execute').expire();
		expect(await run).toMatchObject({ status: 'uncertain' });
		expect(socket.count('album-action:execute')).toBe(1);
	});

	it('reports a definitive execute rejection as failed', async () => {
		const { socket, controller, signal, guard } = setup();
		const preparation = prepareAlbumBatchAction(controller, input, 'queue', guard, signal.signal);
		socket.resolve();
		const prepared = await preparation;
		const run = dispatchAlbumBatchAction(controller, prepared, guard, signal.signal);
		socket.last('album-action:execute').ack({ success: true, data: { claimed: true, outcome: 'rejected', code: 'ZONE_CHANGED', error: 'Zone regrouped' } });
		expect(await run).toEqual({ status: 'failed', message: 'Zone regrouped' });
	});
});
