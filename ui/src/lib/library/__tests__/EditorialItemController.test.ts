/**
 * Client editorial session controller (rich-item plan §5.3): honest
 * unavailability, exact correlation, foreign-event rejection, cancel and
 * disconnect retirement. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';

import {
	EditorialItemController,
	type EditorialItemSocket
} from '$lib/library/EditorialItemController';

interface PendingAck {
	readonly event: string;
	readonly payload: unknown;
	respond(value: unknown): void;
	fail(): void;
}

function fakeSocket(): {
	socket: EditorialItemSocket;
	acks: PendingAck[];
	sent: Array<{ event: string; payload: unknown }>;
	fire(event: string, value: unknown): void;
	listenerCount(event: string): number;
} {
	const acks: PendingAck[] = [];
	const sent: Array<{ event: string; payload: unknown }> = [];
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const socket = {
		connected: true,
		timeout: () => ({
			emit: (
				event: string,
				payload: unknown,
				callback: (error: Error | null, value?: unknown) => void
			) => {
				acks.push({
					event,
					payload,
					respond: (value: unknown) => callback(null, value),
					fail: () => callback(new Error('timeout'))
				});
			}
		}),
		on: (event: string, handler: (value: unknown) => void) => {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
		},
		off: (event: string, handler: (value: unknown) => void) => {
			listeners.get(event)?.delete(handler);
		},
		emit: (event: string, payload: unknown) => {
			sent.push({ event, payload });
		}
	} as unknown as EditorialItemSocket;
	return {
		socket,
		acks,
		sent,
		fire: (event, value) => {
			for (const handler of [...(listeners.get(event) ?? [])]) handler(value);
		},
		listenerCount: (event) => listeners.get(event)?.size ?? 0
	};
}

function makeController(socket: EditorialItemSocket) {
	let n = 0;
	return new EditorialItemController({
		getSocket: () => socket,
		createRequestId: () => `req-${++n}`
	});
}

function readyView() {
	return {
		kind: 'album',
		title: 'Album Title',
		sections: {
			review: { text: 'Prose.', source: 'Provider', language: 'en' }
		}
	};
}

const OPEN_INPUT = {
	anchor: { kind: 'album', albumLocalId: 'alb-1' } as const,
	tabId: 'tab-1',
	generation: 3
};

describe('EditorialItemController', () => {
	it('reports unavailable (not failed) when the build has no editorial family', async () => {
		const harness = fakeSocket();
		const controller = makeController(harness.socket);
		const opened = controller.open(OPEN_INPUT);
		harness.acks[0].respond({
			ok: false,
			code: 'FEATURE_UNAVAILABLE',
			error: 'Not in this build.'
		});
		await opened;
		let observed: unknown;
		controller.subscribe((value) => (observed = value))();
		expect(observed).toMatchObject({ phase: 'unavailable', code: 'FEATURE_UNAVAILABLE' });
	});

	it('accepts only exactly correlated ready events', async () => {
		const harness = fakeSocket();
		const controller = makeController(harness.socket);
		const opened = controller.open(OPEN_INPUT);
		harness.acks[0].respond({
			ok: true,
			data: { requestId: 'req-1', sessionId: 'ses-1', deadlineAt: 99 }
		});
		await opened;

		harness.fire('item-editorial:ready', {
			requestId: 'req-1',
			sessionId: 'foreign',
			view: readyView()
		});
		harness.fire('item-editorial:ready', {
			requestId: 'foreign',
			sessionId: 'ses-1',
			view: readyView()
		});
		let observed: { phase: string } | undefined;
		controller.subscribe((value) => (observed = value as never))();
		expect(observed?.phase).toBe('opening');

		harness.fire('item-editorial:ready', {
			requestId: 'req-1',
			sessionId: 'ses-1',
			view: readyView()
		});
		controller.subscribe((value) => (observed = value as never))();
		expect(observed).toMatchObject({
			phase: 'ready',
			sessionId: 'ses-1'
		});
	});

	it('carries section-scoped failures with retryability', async () => {
		const harness = fakeSocket();
		const controller = makeController(harness.socket);
		const opened = controller.open(OPEN_INPUT);
		harness.acks[0].respond({
			ok: true,
			data: { requestId: 'req-1', sessionId: 'ses-1', deadlineAt: 99 }
		});
		await opened;
		harness.fire('item-editorial:failed', {
			requestId: 'req-1',
			sessionId: 'ses-1',
			code: 'READ_TIMEOUT',
			section: 'review',
			retryable: true,
			error: 'The read timed out.'
		});
		let observed: unknown;
		controller.subscribe((value) => (observed = value))();
		expect(observed).toMatchObject({
			phase: 'failed',
			code: 'READ_TIMEOUT',
			section: 'review',
			retryable: true
		});
	});

	it('cancel notifies the server, detaches listeners, and retires state', async () => {
		const harness = fakeSocket();
		const controller = makeController(harness.socket);
		const opened = controller.open(OPEN_INPUT);
		harness.acks[0].respond({
			ok: true,
			data: { requestId: 'req-1', sessionId: 'ses-1', deadlineAt: 99 }
		});
		await opened;
		expect(harness.listenerCount('item-editorial:ready')).toBe(1);

		controller.cancel();
		expect(harness.sent[0]).toMatchObject({
			event: 'item-editorial:cancel',
			payload: { sessionId: 'ses-1', tabId: 'tab-1' }
		});
		expect(harness.listenerCount('item-editorial:ready')).toBe(0);
		let observed: { phase: string } | undefined;
		controller.subscribe((value) => (observed = value as never))();
		expect(observed?.phase).toBe('canceled');

		// A late event for the retired session changes nothing.
		harness.fire('item-editorial:ready', {
			requestId: 'req-1',
			sessionId: 'ses-1',
			view: readyView()
		});
		controller.subscribe((value) => (observed = value as never))();
		expect(observed?.phase).toBe('canceled');
	});

	it('cancels the server session a superseded ack delivered (ri2-3)', async () => {
		const harness = fakeSocket();
		const controller = makeController(harness.socket);
		const first = controller.open(OPEN_INPUT);
		// A second open supersedes the first before its ack arrives.
		const second = controller.open(OPEN_INPUT);
		expect(harness.acks).toHaveLength(2);
		harness.acks[0].respond({
			ok: true,
			data: { requestId: 'req-1', sessionId: 'ses-orphan', deadlineAt: 99 }
		});
		await first;
		// The unowned session was cancelled, not left to idle expiry.
		expect(harness.sent[0]).toMatchObject({
			event: 'item-editorial:cancel',
			payload: { sessionId: 'ses-orphan', tabId: 'tab-1' }
		});
		harness.acks[1].respond({
			ok: true,
			data: { requestId: 'req-2', sessionId: 'ses-live', deadlineAt: 99 }
		});
		await second;
		let observed: unknown;
		controller.subscribe((value) => (observed = value))();
		expect(observed).toMatchObject({ phase: 'opening', sessionId: 'ses-live' });
	});

	it('a lost terminal event becomes a retryable READ_TIMEOUT (ri2-2)', async () => {
		const harness = fakeSocket();
		const timers: Array<{ cb: () => void }> = [];
		let n = 0;
		const controller = new EditorialItemController({
			getSocket: () => harness.socket,
			createRequestId: () => `req-${++n}`,
			setTimer: (cb) => {
				timers.push({ cb });
				return timers.length as never;
			},
			clearTimer: () => undefined
		});
		const opened = controller.open(OPEN_INPUT);
		harness.acks[0].respond({
			ok: true,
			data: { requestId: 'req-1', sessionId: 'ses-1', deadlineAt: 99 }
		});
		await opened;
		expect(timers).toHaveLength(1);
		timers[0].cb();
		let observed: unknown;
		controller.subscribe((value) => (observed = value))();
		expect(observed).toMatchObject({
			phase: 'failed',
			code: 'READ_TIMEOUT',
			retryable: true
		});
	});

	it('a transport disconnect retires the session as SESSION_LOST', async () => {
		const harness = fakeSocket();
		const controller = makeController(harness.socket);
		const opened = controller.open(OPEN_INPUT);
		harness.acks[0].respond({
			ok: true,
			data: { requestId: 'req-1', sessionId: 'ses-1', deadlineAt: 99 }
		});
		await opened;
		harness.fire('disconnect', undefined);
		let observed: unknown;
		controller.subscribe((value) => (observed = value))();
		expect(observed).toMatchObject({
			phase: 'failed',
			code: 'SESSION_LOST',
			retryable: true
		});
	});
});
