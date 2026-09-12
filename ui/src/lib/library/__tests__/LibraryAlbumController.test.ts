import { describe, expect, it } from 'vitest';

import { COLLECTION_DRILL_SOURCE_CONTRACT } from '@shared/collectionDrillContracts';
import {
	RESOLVING_DELIVERY_SLACK_MS,
	LibraryAlbumController,
	RESOLVING_TIMEOUT_MS,
	type LibraryAlbumSocket,
	type LibraryAlbumState
} from '../LibraryAlbumController';

/** The client's open safety net, armed strictly beyond the server's cap. */
const OPEN_TIMEOUT_MS = 30_000 + RESOLVING_DELIVERY_SLACK_MS;

/**
 * Since Slice 4 an album page is opened by the drill locator that found the
 * row, and by nothing else: the `album`-by-local-id target died with the
 * catalog that minted those ids.
 */
const COLLECTION_LOCATOR = {
	sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
	hierarchy: 'genres' as const,
	collectionExactName: 'Bright Machinery',
	rendering: { exactTitle: 'Debut', exactCredit: 'Björk' }
};
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
		target: { kind: 'collection' as const, locator: COLLECTION_LOCATOR },
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
			target: { kind: 'collection', locator: COLLECTION_LOCATOR },
			tabId: 'tab-1',
			generation: 4
		});
		// The page no longer carries an album identity of its own: the locator
		// travels in the request, and the state names the request that opened it.
		expect(controller.snapshot()).toMatchObject({
			phase: 'opening',
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

	it('retains public version facts and raw ordered track titles', () => {
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
					imageKeyHint: 'public-artwork',
					trackCount: 2
				},
				orderedTracks: [
					{ index: 0, title: '1-1 Human Behaviour' },
					{ index: 1, title: '2. Crying' }
				]
			})
		);

		expect(controller.snapshot().versions[0]).toMatchObject({
			versionId: VERSION_A, editionText: 'Deluxe',
			imageKeyHint: 'public-artwork', trackCount: 2
		});
		expect(controller.snapshot().orderedTracks).toEqual([
			{ index: 0, title: '1-1 Human Behaviour' },
			{ index: 1, title: '2. Crying' }
		]);
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
		first.firePending(OPEN_TIMEOUT_MS);
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

	it('arms the open safety net strictly beyond the server resolving deadline', () => {
		const { socket, controller, timers } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));

		const armed = timers.filter((timer) => !timer.cleared && !timer.fired);
		expect(armed).toHaveLength(1);
		expect(armed[0].ms).toBe(RESOLVING_TIMEOUT_MS + RESOLVING_DELIVERY_SLACK_MS);
		// The client must still be listening while the terminal event is delivered.
		expect(armed[0].ms).toBeGreaterThan(RESOLVING_TIMEOUT_MS);
	});

	it('accepts a versions event arriving inside the delivery slack window', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));

		// Nothing has fired the safety net yet, so the listeners are attached.
		expect(socket.handlerCount('library-album:versions')).toBe(1);
		socket.serverEmit('library-album:versions', versionsEvent());

		const page = controller.snapshot();
		expect(page).toMatchObject({ phase: 'versions' });
		expect(page.versions.map((version) => version.versionId)).toEqual([VERSION_A, VERSION_B]);

		// A subsequent open starts a new resolving state.
		controller.open(openInput());
		expect(controller.snapshot()).toMatchObject({ phase: 'opening' });
	});

	it('surfaces a terminal failure inside the same window as RESOLUTION_TIMEOUT', () => {
		const { socket, controller } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));
		socket.serverEmit(
			'library-album:failed',
			failedEvent({ code: 'RESOLUTION_TIMEOUT', error: 'Album page opening timed out' })
		);

		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'RESOLUTION_TIMEOUT',
		});
	});

	it('cancels the acknowledged operation when its open safety net fires', () => {
		const { socket, controller, firePending } = makeHarness();
		controller.open(openInput());
		socket.emission('library-album:open').ack(successAck(REQUEST_A, OPERATION_A));

		firePending(OPEN_TIMEOUT_MS);

		expect(socket.rawEmits).toContainEqual({
			event: 'library-album:cancel',
			payload: { operationId: OPERATION_A }
		});
		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'RESOLUTION_TIMEOUT'
		});
		expect(socket.handlerCount('library-album:versions')).toBe(0);
	});

	it('guards open and resets a terminal state to idle', () => {
		const REQUEST_C = '30000000-0000-4000-8000-000000000003';
		const { socket, controller } = makeHarness([REQUEST_A, REQUEST_B, REQUEST_C]);

		expect(
			controller.open({
				...openInput(),
				// A locator naming no collection can never re-find its row.
				target: {
					kind: 'collection' as const,
					locator: { ...COLLECTION_LOCATOR, collectionExactName: '' }
				}
			})
		).toEqual({
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

describe('LibraryAlbumController — the live arm (library-live-view Slice 2)', () => {
	const GEN = 'gen-1';
	const ref = (token: string) => ({ generation: GEN, token });

	function open(rows: readonly { title: string; kind: string; token: string }[]) {
		const controller = new LibraryAlbumController({ getSocket: () => null });
		controller.beginLive();
		controller.adoptLiveLevel({
			albumRef: ref('album'),
			title: 'Voices Carry',
			artist: '’Til Tuesday',
			rows: rows.map((row) => ({ ref: ref(row.token), title: row.title, kind: row.kind }))
		});
		return controller;
	}

	it('publishes an opened level as the album page the catalog arm publishes', () => {
		const controller = open([
			{ title: 'Play Album', kind: 'action', token: 'verb' },
			{ title: 'Love in a Vacuum', kind: 'track', token: 't0' },
			{ title: 'Voices Carry', kind: 'track', token: 't1' }
		]);
		expect(controller.snapshot()).toMatchObject({
			phase: 'details',
			activeTab: 'details',
			title: 'Voices Carry',
			artist: '’Til Tuesday',
			// Roon's own order IS the play order, and the position in it is the
			// only index there is.
			orderedTracks: [
				{ index: 0, title: 'Love in a Vacuum' },
				{ index: 1, title: 'Voices Carry' }
			],
			actionsAvailable: true,
			albumActionsAvailable: true
		});
		// No version list: the reference names one album, and Roon's other
		// editions of it are other rows with their own references.
		expect(controller.snapshot().versions).toEqual([]);
		expect(controller.snapshot().selectedVersionId).toBeNull();
	});

	it('binds each track to its own reference, in the order Roon returned them', () => {
		const controller = open([
			{ title: 'Play Album', kind: 'action', token: 'verb' },
			{ title: 'One', kind: 'track', token: 't0' },
			{ title: 'Two', kind: 'track', token: 't1' }
		]);
		const live = controller.snapshot().live;
		expect(live).toEqual({
			albumRef: ref('album'),
			playRef: ref('verb'),
			trackRefs: [ref('t0'), ref('t1')]
		});
	});

	it('keeps the verb row out of the track list, which is what the reader is looking at', () => {
		const controller = open([
			{ title: 'Play Album', kind: 'action', token: 'verb' },
			{ title: 'Only track', kind: 'track', token: 't0' }
		]);
		expect(controller.snapshot().orderedTracks).toHaveLength(1);
		expect(controller.snapshot().orderedTracks[0].title).toBe('Only track');
	});

	it('disables the whole-album verbs, and only those, when there is no single verb row', () => {
		// Two verb rows make "Play album" a choice nobody can make. The honest
		// answer is a disabled header button — never an arbitrary one, and never
		// a disabled track list, because every track still carries its own row.
		const two = open([
			{ title: 'Play Album', kind: 'action', token: 'verb-a' },
			{ title: 'Shuffle', kind: 'action', token: 'verb-b' },
			{ title: 'One', kind: 'track', token: 't0' }
		]);
		expect(two.snapshot()).toMatchObject({
			actionsAvailable: true,
			albumActionsAvailable: false
		});
		expect(two.snapshot().live?.playRef).toBeNull();
		expect(two.snapshot().live?.trackRefs).toEqual([ref('t0')]);

		const none = open([{ title: 'One', kind: 'track', token: 't0' }]);
		expect(none.snapshot()).toMatchObject({
			actionsAvailable: true,
			albumActionsAvailable: false
		});
	});

	it('offers no action at all on a level with no track rows', () => {
		const controller = open([{ title: 'Play Album', kind: 'action', token: 'verb' }]);
		expect(controller.snapshot()).toMatchObject({
			actionsAvailable: false,
			albumActionsAvailable: true,
			orderedTracks: []
		});
	});

	it('says the live read failed in the reader’s words, carrying no live binding', () => {
		const controller = new LibraryAlbumController({ getSocket: () => null });
		controller.beginLive();
		expect(controller.snapshot().phase).toBe('opening');
		controller.failLive('LIVE_OPEN_FAILED', 'Roon no longer lists that album.');
		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			code: 'LIVE_OPEN_FAILED',
			error: 'Roon no longer lists that album.',
			live: null,
			actionsAvailable: false,
			albumActionsAvailable: false
		});
	});
});
