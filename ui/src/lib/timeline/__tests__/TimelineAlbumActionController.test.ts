import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	TimelineAlbumActionController,
	type TimelineAlbumActionSocket
} from '../TimelineAlbumActionController';
import type { AlbumActionChoice, AlbumActionSemantic } from '@shared/albumActionContracts';

const ALBUM_ID = '018f0f64-3f31-7a9b-8c2d-8f572cb18a12';

interface Emission {
	readonly event: string;
	readonly value: unknown;
	readonly timeoutMs: number;
	readonly ack: (value: unknown) => void;
	readonly expire: () => void;
	readonly isPending: () => boolean;
}

class FakeSocket implements TimelineAlbumActionSocket {
	connected = true;
	readonly emissions: Emission[] = [];
	readonly ackTimeouts: number[] = [];
	onEmission: ((emission: Emission) => void) | null = null;
	readonly #handlers = new Map<string, Set<(value: unknown) => void>>();

	on(event: string, handler: (value: unknown) => void): this {
		const handlers = this.#handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.#handlers.set(event, handlers);
		return this;
	}

	off(event: string, handler: (value: unknown) => void): this {
		this.#handlers.get(event)?.delete(handler);
		return this;
	}

	timeout(milliseconds: number): {
			emit: (
				event: string,
				value: unknown,
				ack: (error: unknown, response?: unknown) => void
		) => FakeSocket;
	} {
		this.ackTimeouts.push(milliseconds);
		return {
			emit: (event, value, ack) => {
				let pending = true;
				const emission: Emission = {
					event,
					value,
					timeoutMs: milliseconds,
					ack: (response) => {
						if (!pending) return;
						pending = false;
						ack(null, response);
					},
					expire: () => {
						if (!pending) return;
						pending = false;
						ack(new Error('operation has timed out'));
					},
					isPending: () => pending
				};
				this.emissions.push(emission);
				this.onEmission?.(emission);
				return this;
			}
		};
	}

	pendingAckCount(): number {
		return this.emissions.filter((emission) => emission.isPending()).length;
	}

	expirePendingAcks(): void {
		for (const emission of this.emissions) emission.expire();
	}

	serverEmit(event: string, value: unknown): void {
		for (const handler of [...(this.#handlers.get(event) ?? [])]) handler(value);
	}

	emission(event: string, index = 0): Emission {
		const emission = this.emissions.filter((candidate) => candidate.event === event)[index];
		if (!emission) throw new Error(`Missing ${event} emission ${index}`);
		return emission;
	}

	count(event: string): number {
		return this.emissions.filter((candidate) => candidate.event === event).length;
	}

	listenerCount(event: string): number {
		return this.#handlers.get(event)?.size ?? 0;
	}
}

function beginInput(generation = 7) {
	return {
		albumLocalId: ALBUM_ID,
		zoneId: 'zone-test',
		tabId: 'tab-test',
		generation
	};
}

function accepted(requestId = 'request-1', operationId = 'operation-1') {
	return {
		success: true,
		data: { requestId, operationId, resolvingDeadlineAt: 50_000 }
	};
}

function resolved(
	requestId = 'request-1',
	operationId = 'operation-1',
	generation = 7,
	actions: readonly AlbumActionChoice[] = [
		{ actionId: 'action-play', label: 'Play Now', semantic: 'play-now' },
		{ actionId: 'action-queue', label: 'Queue', semantic: 'queue' }
	]
) {
	return {
		requestId,
		operationId,
		generation,
		choosingDeadlineAt: 80_000,
		actions
	};
}

function makeController(socket: FakeSocket, requestIds = ['request-1']) {
	let index = 0;
	return new TimelineAlbumActionController({
		getSocket: () => socket,
		createRequestId: () => requestIds[index++] ?? `request-${index}`,
		now: () => Date.now(),
		ackTimeoutMs: 10,
		resolvingTimeoutMs: 30,
		choosingTimeoutMs: 40,
		executeAckTimeoutMs: 50
	});
}

function reachChoosing(controller: TimelineAlbumActionController, socket: FakeSocket): void {
	expect(controller.begin(beginInput())).toEqual({ started: true, requestId: 'request-1' });
	socket.emission('album-action:begin').ack(accepted());
	socket.serverEmit('album-action:resolved', resolved());
	expect(controller.snapshot().phase).toBe('choosing');
}

describe('TimelineAlbumActionController', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sends one exact keyless begin and accepts only exact correlated choices', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);

		expect(controller.begin(beginInput())).toEqual({ started: true, requestId: 'request-1' });
		expect(socket.emission('album-action:begin').value).toEqual({
			requestId: 'request-1',
			albumLocalId: ALBUM_ID,
			zoneId: 'zone-test',
			tabId: 'tab-test',
			generation: 7
		});
		expect(JSON.stringify(socket.emission('album-action:begin').value)).not.toMatch(
			/itemKey|multiSessionKey|handleId/
		);
		socket.emission('album-action:begin').ack(accepted());
		expect(controller.snapshot()).toMatchObject({
			phase: 'resolving',
			operationId: 'operation-1',
			resolvingDeadlineAt: 50_000
		});

		for (const stale of [
			resolved('other-request'),
			resolved('request-1', 'other-operation'),
			resolved('request-1', 'operation-1', 8),
			{ ...resolved(), choosingDeadlineAt: 49_999 }
		]) socket.serverEmit('album-action:resolved', stale);
		socket.serverEmit('album-action:failed', {
			requestId: 'request-1',
			operationId: 'operation-1',
			generation: 7,
			resolvingDeadlineAt: 50_001,
			code: 'CANCELED',
			error: 'Mismatched deadline'
		});
		expect(controller.snapshot().phase).toBe('resolving');

		socket.serverEmit('album-action:resolved', resolved());
		expect(controller.snapshot()).toMatchObject({
			phase: 'choosing',
			zoneId: 'zone-test',
			generation: 7,
			choosingDeadlineAt: 80_000,
			actions: [
				{ actionId: 'action-play', label: 'Play Now', semantic: 'play-now' },
				{ actionId: 'action-queue', label: 'Queue', semantic: 'queue' }
			]
		});
	});

	it('auto-executes one desired semantic without sending that intent as server authority', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);

		expect(
			controller.begin({ ...beginInput(), desiredSemantic: 'queue' })
		).toEqual({ started: true, requestId: 'request-1' });
		expect(socket.emission('album-action:begin').value).toEqual({
			requestId: 'request-1',
			albumLocalId: ALBUM_ID,
			zoneId: 'zone-test',
			tabId: 'tab-test',
			generation: 7
		});
		expect(socket.emission('album-action:begin').value).not.toHaveProperty(
			'desiredSemantic'
		);

		socket.emission('album-action:begin').ack(accepted());
		socket.serverEmit('album-action:resolved', resolved());

		expect(controller.snapshot()).toMatchObject({
			phase: 'executing',
			selectedActionId: 'action-queue',
			actions: []
		});
		expect(socket.count('album-action:execute')).toBe(1);
		expect(socket.emission('album-action:execute').value).toEqual({
			actionId: 'action-queue'
		});
		expect(socket.count('album-action:cancel')).toBe(0);
	});

	it.each<{
		desiredSemantic: AlbumActionSemantic;
		actions: readonly AlbumActionChoice[];
		code: string;
	}>([
		{
			desiredSemantic: 'add-next',
			actions: [
				{ actionId: 'action-play', label: 'Play Now', semantic: 'play-now' }
			],
			code: 'DESIRED_SEMANTIC_MISSING'
		},
		{
			desiredSemantic: 'queue',
			actions: [
				{ actionId: 'action-queue-1', label: 'Queue', semantic: 'queue' },
				{ actionId: 'action-queue-2', label: 'Queue Later', semantic: 'queue' }
			],
			code: 'DESIRED_SEMANTIC_AMBIGUOUS'
		}
	])(
		'fails without dispatch when $desiredSemantic is missing or duplicated',
		({ desiredSemantic, actions, code }) => {
			const socket = new FakeSocket();
			const controller = makeController(socket);

			controller.begin({ ...beginInput(), desiredSemantic });
			socket.emission('album-action:begin').ack(accepted());
			socket.serverEmit(
				'album-action:resolved',
				resolved('request-1', 'operation-1', 7, actions)
			);

			expect(controller.snapshot()).toMatchObject({
				phase: 'failed',
				code,
				actions: []
			});
			expect(socket.count('album-action:execute')).toBe(0);
			expect(socket.emission('album-action:cancel').value).toEqual({
				operationId: 'operation-1'
			});
		}
	);

	it('invokes browser-branded timer dependencies without a controller receiver', () => {
		const socket = new FakeSocket();
		const timer = 1 as unknown as ReturnType<typeof setTimeout>;
		const setTimer = vi.fn(function (
			this: unknown,
			_callback: () => void,
			_milliseconds: number
		) {
			if (this !== undefined) throw new TypeError('Illegal invocation');
			return timer;
		});
		const clearTimer = vi.fn(function (
			this: unknown,
			_timer: ReturnType<typeof setTimeout>
		) {
			if (this !== undefined) throw new TypeError('Illegal invocation');
		});
		const controller = new TimelineAlbumActionController({
			getSocket: () => socket,
			createRequestId: () => 'request-1',
			setTimer,
			clearTimer
		});

		expect(controller.begin(beginInput())).toEqual({
			started: true,
			requestId: 'request-1'
		});
		expect(socket.count('album-action:begin')).toBe(1);

		expect(controller.cancel()).toBe(true);
		expect(clearTimer).toHaveBeenCalledWith(timer);
	});

	it('drains bounded begin, cancel, and execute acknowledgments across repeated lifecycles', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);

		for (let cycle = 0; cycle < 20; cycle += 1) {
			expect(controller.begin(beginInput())).toMatchObject({ started: true });
			const begin = socket.emission('album-action:begin', cycle);
			expect(begin.timeoutMs).toBe(10);

			controller.quiesce();
			const cancel = socket.emission('album-action:cancel', cycle);
			expect(cancel.timeoutMs).toBe(10);
			expect(socket.pendingAckCount()).toBe(2);

			socket.expirePendingAcks();
			expect(socket.pendingAckCount()).toBe(0);
			expect(controller.snapshot()).toMatchObject({ phase: 'canceled', code: 'QUIESCED' });
		}

		const started = controller.begin(beginInput());
		if (!started.started) throw new Error('expected bounded execute setup to start');
		const operationId = 'operation-execute';
		socket.emission('album-action:begin', 20).ack(accepted(started.requestId, operationId));
		socket.serverEmit(
			'album-action:resolved',
			resolved(started.requestId, operationId)
		);
		expect(controller.execute('action-play')).toBe(true);
		const execute = socket.emission('album-action:execute');
		expect(execute.timeoutMs).toBe(50);
		expect(socket.pendingAckCount()).toBe(1);

		execute.expire();
		expect(socket.pendingAckCount()).toBe(0);
		expect(controller.snapshot()).toMatchObject({
			phase: 'outcome-unknown',
			code: 'EXECUTE_TIMEOUT'
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it('fails closed on a malformed begin acknowledgment and cancels pre-ack authority', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);

		controller.begin(beginInput());
		socket.emission('album-action:begin').ack({
			success: true,
			data: { requestId: 'request-1', operationId: 'operation-1' }
		});

		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'MALFORMED_BEGIN_ACK',
			operationId: null
		});
		expect(socket.emission('album-action:cancel').value).toEqual({ requestId: 'request-1' });
		expect(socket.listenerCount('album-action:resolved')).toBe(0);
	});

	it('cancels by request ID after a lost acknowledgment and ignores every late publication', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);

		controller.begin(beginInput());
		vi.advanceTimersByTime(10);

		expect(socket.emission('album-action:cancel').value).toEqual({ requestId: 'request-1' });
		expect(controller.snapshot()).toMatchObject({ phase: 'failed', code: 'BEGIN_TIMEOUT' });
		expect(socket.listenerCount('album-action:resolved')).toBe(0);
		expect(socket.listenerCount('album-action:failed')).toBe(0);

		socket.emission('album-action:begin').ack(accepted());
		socket.serverEmit('album-action:resolved', resolved());
		expect(controller.snapshot()).toMatchObject({ phase: 'failed', code: 'BEGIN_TIMEOUT' });
		expect(socket.count('album-action:cancel')).toBe(1);
	});

	it('cancels superseded pre-ack authority and rejects the old attempt correlation', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket, ['request-1', 'request-2']);

		controller.begin(beginInput(7));
		controller.begin(beginInput(8));
		expect(socket.emission('album-action:cancel').value).toEqual({ requestId: 'request-1' });
		expect(controller.snapshot()).toMatchObject({ requestId: 'request-2', generation: 8 });

		socket.emission('album-action:begin', 0).ack(accepted('request-1', 'operation-old'));
		socket.emission('album-action:begin', 1).ack(accepted('request-2', 'operation-new'));
		socket.serverEmit('album-action:resolved', resolved('request-1', 'operation-old', 7));
		expect(controller.snapshot().phase).toBe('resolving');
		socket.serverEmit('album-action:resolved', resolved('request-2', 'operation-new', 8));
		expect(controller.snapshot()).toMatchObject({
			phase: 'choosing',
			requestId: 'request-2',
			operationId: 'operation-new',
			generation: 8
		});
	});

	it('invalidates local listeners before a synchronous cancel publication can race back', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);
		controller.begin(beginInput());
		socket.emission('album-action:begin').ack(accepted());
		socket.onEmission = ({ event }) => {
			if (event !== 'album-action:cancel') return;
			socket.serverEmit('album-action:failed', {
				requestId: 'request-1',
				operationId: 'operation-1',
				generation: 7,
				resolvingDeadlineAt: 50_000,
				code: 'CANCELED',
				error: 'Server cancellation publication'
			});
		};

		expect(controller.cancel()).toBe(true);
		expect(controller.snapshot()).toMatchObject({
			phase: 'canceled',
			code: 'CANCELED',
			error: 'Album action canceled'
		});
		expect(socket.listenerCount('album-action:failed')).toBe(0);
	});

	it('uses bounded local phase timers without comparing server and browser clocks', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);

		controller.begin(beginInput());
		socket.emission('album-action:begin').ack({
			...accepted(),
			data: { ...accepted().data, resolvingDeadlineAt: 2 }
		});
		expect(controller.snapshot().phase).toBe('resolving');
		vi.advanceTimersByTime(29);
		expect(controller.snapshot().phase).toBe('resolving');
		vi.advanceTimersByTime(1);
		expect(controller.snapshot()).toMatchObject({ phase: 'failed', code: 'RESOLUTION_TIMEOUT' });
		expect(socket.emission('album-action:cancel').value).toEqual({ operationId: 'operation-1' });

		controller.begin(beginInput());
		const secondBegin = socket.emission('album-action:begin', 1);
		secondBegin.ack(accepted('request-2', 'operation-2'));
		socket.serverEmit('album-action:resolved', resolved('request-2', 'operation-2'));
		expect(controller.snapshot().phase).toBe('choosing');
		vi.advanceTimersByTime(39);
		expect(controller.snapshot().phase).toBe('choosing');
		vi.advanceTimersByTime(1);
		expect(controller.snapshot()).toMatchObject({ phase: 'failed', code: 'CHOOSER_EXPIRED' });
		expect(socket.emission('album-action:cancel', 1).value).toEqual({ operationId: 'operation-2' });
	});

	it('claims one exact action synchronously and makes double and sibling clicks inert', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);
		reachChoosing(controller, socket);

		expect(controller.execute('action-play')).toBe(true);
		expect(controller.snapshot()).toMatchObject({
			phase: 'executing',
			selectedActionId: 'action-play',
			actions: []
		});
		expect(controller.execute('action-play')).toBe(false);
		expect(controller.execute('action-queue')).toBe(false);
		expect(socket.count('album-action:execute')).toBe(1);
		expect(socket.emission('album-action:execute').value).toEqual({ actionId: 'action-play' });

		socket.emission('album-action:execute').ack({
			success: true,
			data: { claimed: true, outcome: 'executed' }
		});
		expect(controller.snapshot()).toMatchObject({ phase: 'executed', actions: [] });
		expect(socket.listenerCount('album-action:resolved')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('makes malformed and timed-out post-emit acknowledgments outcome unknown with no retry', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket, ['request-1', 'request-2']);
		reachChoosing(controller, socket);

		controller.execute('action-play');
		socket.emission('album-action:execute').ack({ success: true, data: { claimed: true } });
		expect(controller.snapshot()).toMatchObject({
			phase: 'outcome-unknown',
			code: 'MALFORMED_EXECUTE_ACK',
			actions: []
		});
		expect(controller.execute('action-play')).toBe(false);

		controller.begin(beginInput());
		socket.emission('album-action:begin', 1).ack(accepted('request-2', 'operation-2'));
		socket.serverEmit('album-action:resolved', resolved('request-2', 'operation-2'));
		controller.execute('action-queue');
		vi.advanceTimersByTime(50);
		expect(controller.snapshot()).toMatchObject({
			phase: 'outcome-unknown',
			code: 'EXECUTE_TIMEOUT',
			actions: []
		});
		expect(controller.execute('action-queue')).toBe(false);
		expect(socket.count('album-action:execute')).toBe(2);
	});

	it('maps strict deterministic execute outcomes without retaining one-use choices', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket);
		reachChoosing(controller, socket);

		controller.execute('action-play');
		socket.emission('album-action:execute').ack({
			success: true,
			data: {
				claimed: true,
				outcome: 'rejected',
				code: 'ZONE_CHANGED',
				error: 'The original target regrouped'
			}
		});
		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'ZONE_CHANGED',
			error: 'The original target regrouped',
			actions: []
		});
	});

	it('quiesce cancels resolving and choosing authority but never a claimed execute', () => {
		const socket = new FakeSocket();
		const controller = makeController(socket, ['request-1', 'request-2', 'request-3']);

		controller.begin(beginInput());
		controller.quiesce();
		expect(socket.emission('album-action:cancel').value).toEqual({ requestId: 'request-1' });
		expect(controller.snapshot()).toMatchObject({ phase: 'canceled', code: 'QUIESCED' });

		controller.begin(beginInput());
		socket.emission('album-action:begin', 1).ack(accepted('request-2', 'operation-2'));
		socket.serverEmit('album-action:resolved', resolved('request-2', 'operation-2'));
		controller.quiesce();
		expect(socket.emission('album-action:cancel', 1).value).toEqual({ operationId: 'operation-2' });

		controller.begin(beginInput());
		socket.emission('album-action:begin', 2).ack(accepted('request-3', 'operation-3'));
		socket.serverEmit('album-action:resolved', resolved('request-3', 'operation-3'));
		controller.execute('action-play');
		const cancelCount = socket.count('album-action:cancel');
		controller.quiesce();

		expect(socket.count('album-action:cancel')).toBe(cancelCount);
		expect(controller.snapshot()).toMatchObject({
			phase: 'outcome-unknown',
			code: 'EXECUTION_UNOBSERVED',
			actions: []
		});
		expect(socket.listenerCount('album-action:resolved')).toBe(0);
		expect(socket.listenerCount('album-action:failed')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		socket.emission('album-action:execute').ack({
			success: true,
			data: { claimed: true, outcome: 'executed' }
		});
		expect(controller.snapshot().code).toBe('EXECUTION_UNOBSERVED');
	});
});
