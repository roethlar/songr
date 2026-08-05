import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { socketStatusStore, setSocketStatus } from '../../stores/socketStatusStore';
import {
	commandFeedbackStore,
	clearCommandFeedback
} from '../../stores/commandFeedbackStore';
import { registerSocketHandlers } from '../register';

// A minimal fake socket that records on/off registrations and lets tests
// fire events synchronously. Mirrors only the surface `register.ts` uses.
function makeFakeSocket(initialConnected = false) {
	const handlers = new Map<string, Set<(...args: any[]) => void>>();
	const managerHandlers = new Map<string, Set<(...args: any[]) => void>>();
	return {
		connected: initialConnected,
		on(event: string, fn: (...args: any[]) => void) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)!.add(fn);
			return this;
		},
		off(event: string, fn: (...args: any[]) => void) {
			handlers.get(event)?.delete(fn);
			return this;
		},
		io: {
			on(event: string, fn: (...args: any[]) => void) {
				if (!managerHandlers.has(event)) managerHandlers.set(event, new Set());
				managerHandlers.get(event)!.add(fn);
			},
			off(event: string, fn: (...args: any[]) => void) {
				managerHandlers.get(event)?.delete(fn);
			}
		},
		emit: vi.fn(),
		fire(event: string, ...args: any[]) {
			handlers.get(event)?.forEach((fn) => fn(...args));
		},
		fireManager(event: string, ...args: any[]) {
			managerHandlers.get(event)?.forEach((fn) => fn(...args));
		},
		listenerCount(event: string) {
			return handlers.get(event)?.size ?? 0;
		},
		managerListenerCount(event: string) {
			return managerHandlers.get(event)?.size ?? 0;
		}
	};
}

// Late binding: the mock returns whatever `fakeSocket` points to at call
// time, so each beforeEach can swap in a fresh fake without resetting
// modules (which would split the `socketStatusStore` instance between
// the test and register.ts).
let fakeSocket: ReturnType<typeof makeFakeSocket>;

vi.mock('../client', () => ({
	getSocket: () => fakeSocket,
	disconnectSocket: vi.fn()
}));

let cleanup: (() => void) | null = null;

beforeEach(() => {
	fakeSocket = makeFakeSocket(false);
	(globalThis.fetch as any) = vi.fn(async () => ({
		ok: true,
		json: async () => ({ status: 'paired', zones: [] })
	}));
	setSocketStatus('connecting');
	clearCommandFeedback();
});

afterEach(() => {
	cleanup?.();
	cleanup = null;
});

describe('registerSocketHandlers — connectivity transitions', () => {
	it('reflects "connecting" while the socket is not yet connected', () => {
		cleanup = registerSocketHandlers();
		expect(get(socketStatusStore)).toBe('connecting');
	});

	it('reflects "connected" if the socket is already up at registration', () => {
		fakeSocket = makeFakeSocket(true);
		cleanup = registerSocketHandlers();
		expect(get(socketStatusStore)).toBe('connected');
	});

	it('flips to "connected" on the connect event', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect');
		expect(get(socketStatusStore)).toBe('connected');
	});

	it('flips to "disconnected" for "io server disconnect" reason', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect');
		fakeSocket.fire('disconnect', 'io server disconnect');
		expect(get(socketStatusStore)).toBe('disconnected');
	});

	it('flips to "disconnected" when client explicitly disconnects', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect');
		fakeSocket.fire('disconnect', 'io client disconnect');
		expect(get(socketStatusStore)).toBe('disconnected');
	});

	it('keeps "connecting" for auto-reconnecting disconnect reasons', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect');

		fakeSocket.fire('disconnect', 'transport close');
		expect(get(socketStatusStore)).toBe('connecting');

		fakeSocket.fire('disconnect', 'ping timeout');
		expect(get(socketStatusStore)).toBe('connecting');
	});

	it('flips to "disconnected" when the manager exhausts retries', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect');
		fakeSocket.fire('disconnect', 'transport close');

		fakeSocket.fireManager('reconnect_failed');
		expect(get(socketStatusStore)).toBe('disconnected');
	});

	it('keeps "connecting" through a connect_error', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect_error', new Error('boom'));
		expect(get(socketStatusStore)).toBe('connecting');
	});

	it('stays silent on the initial connect', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect');
		expect(get(commandFeedbackStore)).toBeNull();
	});

	it('pushes a success toast when connect follows a disconnect', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect');
		fakeSocket.fire('disconnect', 'transport close');

		fakeSocket.fire('connect');

		const toast = get(commandFeedbackStore);
		expect(toast?.kind).toBe('success');
		expect(toast?.message).toMatch(/reconnected/i);
	});

	it('pushes a success toast when connect follows a connect_error', () => {
		cleanup = registerSocketHandlers();
		fakeSocket.fire('connect_error', new Error('boom'));

		fakeSocket.fire('connect');

		const toast = get(commandFeedbackStore);
		expect(toast?.kind).toBe('success');
		expect(toast?.message).toMatch(/reconnected/i);
	});

	it('cleans up all listeners on cleanup', () => {
		cleanup = registerSocketHandlers();
		expect(fakeSocket.listenerCount('connect')).toBeGreaterThan(0);
		expect(fakeSocket.managerListenerCount('reconnect_failed')).toBeGreaterThan(0);

		cleanup!();
		cleanup = null;
		expect(fakeSocket.listenerCount('connect')).toBe(0);
		expect(fakeSocket.listenerCount('disconnect')).toBe(0);
		expect(fakeSocket.listenerCount('connect_error')).toBe(0);
		expect(fakeSocket.managerListenerCount('reconnect_failed')).toBe(0);
	});
});
