import { describe, expect, it } from 'vitest';

import {
	LibraryAlbumController,
	type LibraryAlbumSocket,
	type LibraryAlbumState
} from '../LibraryAlbumController';

const ALBUM_ID = '20000000-0000-4000-8000-000000000001';
const REQUEST_A = '30000000-0000-4000-8000-000000000001';
const REQUEST_B = '30000000-0000-4000-8000-000000000002';
const OPERATION_A = '40000000-0000-4000-8000-000000000001';
const OPERATION_B = '40000000-0000-4000-8000-000000000002';
const NOW = 1_700_000_000_000;
const DEADLINE = NOW + 30_000;

interface Emission {
	readonly event: string;
	readonly value: unknown;
	readonly timeoutMs: number;
	readonly ack: (value: unknown) => void;
	readonly expire: () => void;
	readonly isPending: () => boolean;
}

interface RawEmit {
	readonly event: string;
	readonly payload: unknown;
}

class FakeSocket implements LibraryAlbumSocket {
	connected = true;
	readonly emissions: Emission[] = [];
	readonly rawEmits: RawEmit[] = [];
	handlerCountAtLastEmit = -1;
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

	emit(event: string, payload: unknown): this {
		this.rawEmits.push({ event, payload });
		return this;
	}

	timeout(milliseconds: number): {
		emit(
			event: string,
			payload: unknown,
			ack: (error: unknown, response?: unknown) => void
		): unknown;
	} {
		return {
			emit: (event, payload, ack) => {
				let pending = true;
				this.handlerCountAtLastEmit = this.handlerCount('library-album:resolved');
				this.emissions.push({
					event,
					value: payload,
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
				});
				return this;
			}
		};
	}

	serverEmit(event: string, value: unknown): void {
		for (const handler of [...(this.#handlers.get(event) ?? [])]) handler(value);
	}

	handlerCount(event: string): number {
		return this.#handlers.get(event)?.size ?? 0;
	}

	emission(event: string, index = 0): Emission {
		const emission = this.emissions.filter((candidate) => candidate.event === event)[index];
		if (!emission) throw new Error(`Missing ${event} emission ${index}`);
		return emission;
	}
}

interface FakeTimer {
	readonly callback: () => void;
	readonly ms: number;
	cleared: boolean;
	fired: boolean;
}

function makeHarness(requestIds: readonly string[] = [REQUEST_A, REQUEST_B]) {
	const socket = new FakeSocket();
	const timers: FakeTimer[] = [];
	const queue = [...requestIds];
	let clock = NOW;
	const states: LibraryAlbumState[] = [];
	const controller = new LibraryAlbumController({
		getSocket: () => socket,
		createRequestId: () => {
			const next = queue.shift();
			if (!next) throw new Error('request id queue exhausted');
			return next;
		},
		now: () => ++clock,
		setTimer: (callback, ms) => {
			const timer: FakeTimer = { callback, ms, cleared: false, fired: false };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (handle) => {
			(handle as unknown as FakeTimer).cleared = true;
		},
		ackTimeoutMs: 5_000,
		resolvingTimeoutMs: 30_000
	});
	controller.subscribe((state) => states.push(state));
	const firePending = (ms: number): void => {
		const timer = timers.find(
			(candidate) => candidate.ms === ms && !candidate.cleared && !candidate.fired
		);
		if (!timer) throw new Error(`No pending ${ms}ms timer`);
		timer.fired = true;
		timer.callback();
	};
	return { socket, controller, timers, states, firePending };
}

function openInput(candidate?: { title: string; artist: string; editionText: string }) {
	return {
		albumLocalId: ALBUM_ID,
		tabId: 'tab-1',
		generation: 4,
		...(candidate ? { candidate } : {})
	};
}

function successAck(requestId: string, operationId: string) {
	return {
		success: true,
		data: { requestId, operationId, resolvingDeadlineAt: DEADLINE }
	};
}

function resolvedEvent(overrides: Record<string, unknown> = {}) {
	return {
		requestId: REQUEST_A,
		operationId: OPERATION_A,
		generation: 4,
		artist: 'Björk',
		title: 'Debut',
		actionsAvailable: true,
		orderedTracks: [
			{ index: 0, title: 'Human Behaviour' },
			{ index: 1, title: 'Crying' }
		],
		...overrides
	};
}

function failedEvent(overrides: Record<string, unknown> = {}) {
	return {
		requestId: REQUEST_A,
		operationId: OPERATION_A,
		generation: 4,
		resolvingDeadlineAt: DEADLINE,
		error: 'The album identity is ambiguous',
		code: 'ALBUM_AMBIGUOUS',
		...overrides
	};
}

describe('LibraryAlbumController', () => {
	it('attaches listeners before the emit and walks the full resolve lifecycle', () => {
		const { socket, controller } = makeHarness();

		const result = controller.open(openInput());
		expect(result).toEqual({ started: true, requestId: REQUEST_A });
		// Listener registration precedes the open emit; a fast server cannot
		// publish into a listener gap.
		expect(socket.handlerCountAtLastEmit).toBe(1);

		const emission = socket.emission('library-album:open');
		expect(emission.value).toMatchObject({
			requestId: REQUEST_A,
			albumLocalId: ALBUM_ID,
			tabId: 'tab-1',
			generation: 4
		});
		expect(controller.snapshot()).toMatchObject({
			phase: 'resolving',
			albumLocalId: ALBUM_ID,
			generation: 4,
			requestId: REQUEST_A,
			operationId: null
		});

		emission.ack(successAck(REQUEST_A, OPERATION_A));
		expect(controller.snapshot()).toMatchObject({
			phase: 'resolving',
			operationId: OPERATION_A,
			resolvingDeadlineAt: DEADLINE
		});

		socket.serverEmit('library-album:resolved', resolvedEvent());
		const resolved = controller.snapshot();
		expect(resolved).toMatchObject({
			phase: 'resolved',
			artist: 'Björk',
			title: 'Debut',
			actionsAvailable: true,
			code: null,
			error: null
		});
		expect(resolved.orderedTracks.map((track) => track.title)).toEqual([
			'Human Behaviour',
			'Crying'
		]);
		expect(Object.isFrozen(resolved.orderedTracks)).toBe(true);
		expect(Object.isFrozen(resolved.orderedTracks[0])).toBe(true);
		expect(socket.handlerCount('library-album:resolved')).toBe(0);
		expect(socket.handlerCount('library-album:failed')).toBe(0);

		// Terminal states ignore stray repeats.
		socket.serverEmit('library-album:resolved', resolvedEvent({ title: 'Post' }));
		expect(controller.snapshot().title).toBe('Debut');
	});

	it('surfaces ALBUM_AMBIGUOUS candidates and reopens with the chosen candidate', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));

		const candidates = [
			{ title: 'Debut', artist: 'Björk', editionText: '' },
			{ title: 'Debut', artist: 'Björk', editionText: '2011 Remaster' }
		];
		socket.serverEmit('library-album:failed', failedEvent({ candidates }));

		const failed = controller.snapshot();
		expect(failed).toMatchObject({ phase: 'failed', code: 'ALBUM_AMBIGUOUS' });
		expect(failed.candidates).toEqual(candidates);
		expect(Object.isFrozen(failed.candidates)).toBe(true);
		expect(Object.isFrozen(failed.candidates[0])).toBe(true);

		const retry = controller.open(openInput(candidates[1]));
		expect(retry).toEqual({ started: true, requestId: REQUEST_B });
		expect(socket.emission('library-album:open', 1).value).toMatchObject({
			requestId: REQUEST_B,
			candidate: { title: 'Debut', artist: 'Björk', editionText: '2011 Remaster' }
		});
	});

	it('fails closed when the open is never acknowledged', () => {
		const { socket, controller, firePending } = makeHarness();
		controller.open(openInput());

		firePending(5_000);
		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'OPEN_FAILED'
		});
		expect(socket.handlerCount('library-album:resolved')).toBe(0);

		// A late ack for the dead attempt must release its server lease.
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});
	});

	it('cancels an acknowledged read that never resolves', () => {
		const { socket, controller, firePending } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));

		firePending(30_000);
		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'RESOLUTION_TIMEOUT'
		});
		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});
	});

	it('supersedes the previous attempt and cancels its late acceptance', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		controller.open(openInput());

		// The un-acked first attempt is retired by requestId at supersede time.
		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { requestId: REQUEST_A }
		});

		// Its late server acceptance must still be released by operationId.
		socket.emission('library-album:open', 0).ack(successAck(REQUEST_A, OPERATION_A));
		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});

		// The live second attempt is unaffected.
		expect(controller.snapshot()).toMatchObject({
			phase: 'resolving',
			requestId: REQUEST_B
		});
		socket.emission('library-album:open', 1).ack(successAck(REQUEST_B, OPERATION_B));
		socket.serverEmit(
			'library-album:resolved',
			resolvedEvent({ requestId: REQUEST_B, operationId: OPERATION_B })
		);
		expect(controller.snapshot()).toMatchObject({ phase: 'resolved', title: 'Debut' });
	});

	it('ignores events that fail correlation and maps CANCELED to the canceled phase', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));

		socket.serverEmit('library-album:resolved', resolvedEvent({ operationId: OPERATION_B }));
		socket.serverEmit('library-album:resolved', resolvedEvent({ requestId: REQUEST_B }));
		socket.serverEmit('library-album:failed', failedEvent({ generation: 5 }));
		expect(controller.snapshot()).toMatchObject({ phase: 'resolving' });

		socket.serverEmit(
			'library-album:failed',
			failedEvent({ code: 'CANCELED', error: 'The album read was canceled' })
		);
		expect(controller.snapshot()).toMatchObject({ phase: 'canceled', code: 'CANCELED' });
	});

	it('guards open, supports local cancel, and resets terminal states to idle', () => {
		// Guarded opens still consume a request id each before rejecting.
		const REQUEST_C = '30000000-0000-4000-8000-000000000003';
		const { socket, controller } = makeHarness([REQUEST_A, REQUEST_B, REQUEST_C]);

		expect(controller.open({ ...openInput(), albumLocalId: '' })).toEqual({
			started: false,
			reason: 'invalid'
		});
		socket.connected = false;
		expect(controller.open(openInput())).toEqual({
			started: false,
			reason: 'not-connected'
		});
		socket.connected = true;

		expect(controller.open(openInput())).toEqual({ started: true, requestId: REQUEST_C });
		socket.emission('library-album:open').ack(successAck(REQUEST_C, OPERATION_A));
		controller.cancel();
		expect(controller.snapshot()).toMatchObject({ phase: 'canceled', code: 'CANCELED' });
		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});

		controller.reset();
		expect(controller.snapshot()).toMatchObject({ phase: 'idle', requestId: null });

		controller.dispose();
		expect(controller.open(openInput())).toEqual({ started: false, reason: 'disposed' });
	});
});
