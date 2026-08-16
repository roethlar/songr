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
const VERSION_A = 'version-a';
const VERSION_B = 'version-b';
const NOW = 1_700_000_000_000;
const DEADLINE = NOW + 30_000;
const SELECT_DEADLINE = NOW + 60_000;

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

function openInput() {
	return {
		albumLocalId: ALBUM_ID,
		tabId: 'tab-1',
		generation: 4
	};
}

function successAck(requestId: string, operationId: string) {
	return {
		success: true,
		data: { requestId, operationId, resolvingDeadlineAt: DEADLINE }
	};
}

function versionsEvent(overrides: Record<string, unknown> = {}) {
	return {
		requestId: REQUEST_A,
		operationId: OPERATION_A,
		generation: 4,
		artist: 'Björk',
		title: 'Debut',
		versions: [
			{ versionId: VERSION_A, editionText: '', imageKeyHint: 'same-artwork' },
			{ versionId: VERSION_B, editionText: '', imageKeyHint: 'same-artwork' }
		],
		...overrides
	};
}

function selectAck(versionId: string, deadline = SELECT_DEADLINE) {
	return {
		success: true,
		data: { operationId: OPERATION_A, versionId, resolvingDeadlineAt: deadline }
	};
}

function resolvedEvent(versionId: string, overrides: Record<string, unknown> = {}) {
	return {
		requestId: REQUEST_A,
		operationId: OPERATION_A,
		generation: 4,
		versionId,
		artist: 'Björk',
		title: 'Debut',
		actionsAvailable: true,
		versionSummary: { versionId, editionText: '', imageKeyHint: 'same-artwork' },
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
		error: 'The album page was lost',
		code: 'SESSION_LOST',
		...overrides
	};
}

function versionFailedEvent(versionId: string, overrides: Record<string, unknown> = {}) {
	return {
		requestId: REQUEST_A,
		operationId: OPERATION_A,
		generation: 4,
		resolvingDeadlineAt: SELECT_DEADLINE,
		versionId,
		error: 'That version could not be read',
		code: 'DETAIL_INCOMPLETE',
		...overrides
	};
}

describe('LibraryAlbumController', () => {
	it('attaches listeners before open and retains indistinguishable versions as separate rows', () => {
		const { socket, controller } = makeHarness();
		const result = controller.open(openInput());
		expect(result).toEqual({ started: true, requestId: REQUEST_A });
		expect(socket.handlerCountAtLastEmit).toBe(1);
		const emission = socket.emission('library-album:open');
		expect(emission.value).toMatchObject({
			requestId: REQUEST_A,
			albumLocalId: ALBUM_ID,
			tabId: 'tab-1',
			generation: 4
		});
		expect(controller.snapshot()).toMatchObject({
			phase: 'opening',
			albumLocalId: ALBUM_ID,
			generation: 4,
			requestId: REQUEST_A,
			operationId: null
		});

		emission.ack(successAck(REQUEST_A, OPERATION_A));
		socket.serverEmit('library-album:versions', versionsEvent());
		const page = controller.snapshot();
		expect(page).toMatchObject({
			phase: 'versions',
			activeTab: 'versions',
			artist: 'Björk',
			title: 'Debut',
			selectedVersionId: null
		});
		expect(page.versions.map((version) => version.versionId)).toEqual([VERSION_A, VERSION_B]);
		expect(page.versions[0]).toMatchObject({ editionText: '', imageKeyHint: 'same-artwork' });
		expect(page.versions[1]).toMatchObject({ editionText: '', imageKeyHint: 'same-artwork' });
		expect(Object.isFrozen(page.versions)).toBe(true);
		expect(Object.isFrozen(page.versions[0])).toBe(true);
		expect(socket.handlerCount('library-album:resolved')).toBe(1);
	});

	it('auto-selects a sole version and opens its details', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		socket.serverEmit(
			'library-album:versions',
			versionsEvent({ versions: [{ versionId: VERSION_A, editionText: '' }] })
		);

		expect(controller.snapshot()).toMatchObject({
			phase: 'loading-detail',
			activeTab: 'details',
			selectedVersionId: VERSION_A
		});
		const select = socket.emission('library-album:select');
		expect(select.value).toEqual({ operationId: OPERATION_A, versionId: VERSION_A });
		select.ack(selectAck(VERSION_A));
		socket.serverEmit('library-album:resolved', resolvedEvent(VERSION_A));

		const details = controller.snapshot();
		expect(details).toMatchObject({
			phase: 'details',
			activeTab: 'details',
			selectedVersionId: VERSION_A,
			actionsAvailable: true
		});
		expect(details.orderedTracks.map((track) => track.title)).toEqual([
			'Human Behaviour',
			'Crying'
		]);
		expect(details.versions[0]).toMatchObject({ phase: 'loaded', trackCount: 2 });
		expect(Object.isFrozen(details.orderedTracks[0])).toBe(true);
	});

	it('adopts richer selected-version metadata without exposing server-side identity', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		socket.serverEmit('library-album:versions', versionsEvent());
		controller.select(VERSION_A);
		socket.emission('library-album:select').ack(selectAck(VERSION_A));
		socket.serverEmit(
			'library-album:resolved',
			resolvedEvent(VERSION_A, {
				versionSummary: {
					versionId: VERSION_A,
					editionText: 'Deluxe',
					sourceLabel: 'Local',
					releaseDate: '1993-07-05',
					trackCount: 2,
					durationSeconds: 401,
					available: true,
					playCount: 4,
					isFavorite: true
				},
				orderedTracks: [
					{
						index: 0,
						title: 'Human Behaviour',
						trackNumber: 1,
						mediaNumber: 1,
						lengthSeconds: 210,
						available: true
					},
					{ index: 1, title: 'Crying', lengthSeconds: 191, available: true }
				]
			})
		);

		expect(controller.snapshot().versions[0]).toMatchObject({
			editionText: 'Deluxe',
			sourceLabel: 'Local',
			releaseDate: '1993-07-05',
			trackCount: 2,
			durationSeconds: 401,
			playCount: 4,
			isFavorite: true
		});
		expect(controller.snapshot().orderedTracks[0]).toMatchObject({
			trackNumber: 1,
			lengthSeconds: 210,
			available: true
		});
	});

	it('reselects a cached version through the server to restore action authority', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		socket.serverEmit('library-album:versions', versionsEvent());

		expect(controller.select(VERSION_A)).toEqual({ started: true, versionId: VERSION_A });
		socket.emission('library-album:select').ack(selectAck(VERSION_A));
		socket.serverEmit('library-album:resolved', resolvedEvent(VERSION_A));

		controller.showVersions();
		expect(controller.select(VERSION_B)).toEqual({ started: true, versionId: VERSION_B });
		expect(socket.emission('library-album:select', 1).value).toEqual({
			operationId: OPERATION_A,
			versionId: VERSION_B
		});
		socket.emission('library-album:select', 1).ack(selectAck(VERSION_B));
		socket.serverEmit(
			'library-album:resolved',
			resolvedEvent(VERSION_B, { orderedTracks: [{ index: 0, title: 'Atlantic' }] })
		);

		controller.showVersions();
		expect(controller.snapshot().activeTab).toBe('versions');
		expect(controller.select(VERSION_A)).toEqual({ started: true, versionId: VERSION_A });
		expect(controller.snapshot()).toMatchObject({
			phase: 'loading-detail',
			activeTab: 'details',
			selectedVersionId: VERSION_A,
			actionsAvailable: false,
			orderedTracks: []
		});
		expect(socket.emission('library-album:select', 2).value).toEqual({
			operationId: OPERATION_A,
			versionId: VERSION_A
		});
		socket.emission('library-album:select', 2).ack(selectAck(VERSION_A));
		socket.serverEmit('library-album:resolved', resolvedEvent(VERSION_A));
		expect(controller.snapshot()).toMatchObject({
			phase: 'details',
			selectedVersionId: VERSION_A,
			actionsAvailable: true
		});
		expect(controller.snapshot().orderedTracks.map((track) => track.title)).toEqual([
			'Human Behaviour',
			'Crying'
		]);
	});

	it('keeps a version failure local and retries the same row', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		socket.serverEmit('library-album:versions', versionsEvent());
		controller.select(VERSION_A);
		socket.emission('library-album:select').ack(selectAck(VERSION_A));
		socket.serverEmit('library-album:version-failed', versionFailedEvent(VERSION_A));

		expect(controller.snapshot()).toMatchObject({
			phase: 'versions',
			activeTab: 'versions',
			code: 'DETAIL_INCOMPLETE'
		});
		expect(controller.snapshot().versions[0]).toMatchObject({
			phase: 'failed',
			error: 'That version could not be read'
		});
		expect(controller.snapshot().versions[1].phase).toBe('idle');

		controller.select(VERSION_A);
		expect(socket.emission('library-album:select', 1).value).toEqual({
			operationId: OPERATION_A,
			versionId: VERSION_A
		});
		expect(controller.snapshot().versions[0].phase).toBe('loading');
	});

	it('ignores foreign versions and stale selection events', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		socket.serverEmit('library-album:versions', versionsEvent({ operationId: OPERATION_B }));
		expect(controller.snapshot().phase).toBe('opening');
		socket.serverEmit('library-album:versions', versionsEvent());
		controller.select(VERSION_A);
		socket.emission('library-album:select').ack(selectAck(VERSION_A));

		socket.serverEmit('library-album:resolved', resolvedEvent(VERSION_B));
		socket.serverEmit('library-album:resolved', resolvedEvent(VERSION_A, { operationId: OPERATION_B }));
		expect(controller.snapshot()).toMatchObject({
			phase: 'loading-detail',
			selectedVersionId: VERSION_A,
			orderedTracks: []
		});
		socket.serverEmit('library-album:resolved', resolvedEvent(VERSION_A));
		expect(controller.snapshot().phase).toBe('details');
	});

	it('fails closed when open or selected detail is not acknowledged in time', () => {
		const first = makeHarness();
		first.controller.open(openInput());
		first.firePending(5_000);
		expect(first.controller.snapshot()).toMatchObject({ phase: 'failed', code: 'OPEN_FAILED' });
		expect(first.socket.handlerCount('library-album:resolved')).toBe(0);

		first.socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		expect(first.socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});

		const second = makeHarness();
		second.controller.open(openInput());
		second.socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		second.socket.serverEmit('library-album:versions', versionsEvent());
		second.controller.select(VERSION_A);
		second.firePending(5_000);
		expect(second.controller.snapshot()).toMatchObject({
			phase: 'versions',
			activeTab: 'versions',
			code: 'SELECT_FAILED'
		});
		expect(second.controller.snapshot().versions[0].phase).toBe('failed');
	});

	it('times out opening and selected-detail resolution at their separate boundaries', () => {
		const first = makeHarness();
		first.controller.open(openInput());
		first.socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		first.firePending(30_000);
		expect(first.controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'RESOLUTION_TIMEOUT'
		});

		const second = makeHarness();
		second.controller.open(openInput());
		second.socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		second.socket.serverEmit('library-album:versions', versionsEvent());
		second.controller.select(VERSION_A);
		second.socket.emission('library-album:select').ack(selectAck(VERSION_A));
		second.firePending(30_000);
		expect(second.controller.snapshot()).toMatchObject({
			phase: 'versions',
			code: 'RESOLUTION_TIMEOUT'
		});
		expect(second.controller.snapshot().versions[0].phase).toBe('failed');
	});

	it('supersedes the previous page and cancels its late acceptance', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		controller.open(openInput());

		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { requestId: REQUEST_A }
		});
		socket.emission('library-album:open', 0).ack(successAck(REQUEST_A, OPERATION_A));
		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});

		expect(controller.snapshot()).toMatchObject({ phase: 'opening', requestId: REQUEST_B });
		socket.emission('library-album:open', 1).ack(successAck(REQUEST_B, OPERATION_B));
		socket.serverEmit(
			'library-album:versions',
			versionsEvent({ requestId: REQUEST_B, operationId: OPERATION_B })
		);
		expect(controller.snapshot()).toMatchObject({ phase: 'versions', title: 'Debut' });
	});

	it('retires listeners on disconnect, cancel, and dispose', () => {
		const disconnected = makeHarness();
		disconnected.controller.open(openInput());
		disconnected.socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		disconnected.socket.serverEmit('library-album:versions', versionsEvent());
		disconnected.socket.serverEmit('disconnect', undefined);
		expect(disconnected.controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'SESSION_LOST'
		});
		expect(disconnected.socket.handlerCount('library-album:versions')).toBe(0);

		const canceled = makeHarness();
		canceled.controller.open(openInput());
		canceled.socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		canceled.controller.cancel();
		expect(canceled.controller.snapshot()).toMatchObject({ phase: 'canceled', code: 'CANCELED' });
		expect(canceled.socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});
		expect(canceled.socket.handlerCount('disconnect')).toBe(0);

		const disposed = makeHarness();
		disposed.controller.open(openInput());
		disposed.controller.dispose();
		expect(disposed.socket.handlerCount('library-album:versions')).toBe(0);
		expect(disposed.controller.open(openInput())).toEqual({
			started: false,
			reason: 'disposed'
		});
	});

	it('guards open and resets a terminal state to idle', () => {
		const REQUEST_C = '30000000-0000-4000-8000-000000000003';
		const { socket, controller } = makeHarness([REQUEST_A, REQUEST_B, REQUEST_C]);

		expect(controller.open({ ...openInput(), albumLocalId: '' })).toEqual({
			started: false,
			reason: 'invalid'
		});
		socket.connected = false;
		expect(controller.open(openInput())).toEqual({ started: false, reason: 'not-connected' });
		socket.connected = true;
		expect(controller.open(openInput())).toEqual({ started: true, requestId: REQUEST_C });
		socket.emission('library-album:open').ack(successAck(REQUEST_C, OPERATION_A));
		socket.serverEmit(
			'library-album:failed',
			failedEvent({ requestId: REQUEST_C, code: 'CANCELED', error: 'Canceled' })
		);
		expect(controller.snapshot()).toMatchObject({ phase: 'canceled', code: 'CANCELED' });
		controller.reset();
		expect(controller.snapshot()).toMatchObject({ phase: 'idle', requestId: null });
	});
});
