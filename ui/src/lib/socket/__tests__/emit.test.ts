import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { Manager } from 'socket.io-client';
import { emitWithAck, emitIfConnected } from '../emit';
import { commandFeedbackStore, clearCommandFeedback } from '$lib/stores/commandFeedbackStore';

function makeSocket(connected: boolean) {
	const boundedEmit = vi.fn();
	const socket = {
		connected,
		emit: vi.fn(),
		boundedEmit,
		timeout: vi.fn(() => ({ emit: boundedEmit }))
	};
	return socket;
}

beforeEach(() => {
	clearCommandFeedback();
});

describe('emitWithAck — fail-fast when disconnected', () => {
	it('rejects synchronously without calling socket.emit when socket.connected is false', async () => {
		const socket = makeSocket(false);
		const result = await emitWithAck(
			socket as unknown as Parameters<typeof emitWithAck>[0],
			'transport:play-pause',
			{ zone_id: 'z' },
			{ feedback: { source: 'transport', command: 'transport:play-pause' } }
		);

		expect(result).toEqual({ success: false, error: 'Not connected to server' });
		// Critical: socket.io would buffer the emit and replay it on
		// reconnect. We must NOT call socket.emit at all.
		expect(socket.emit).not.toHaveBeenCalled();
	});

	it('pushes a feedback toast when disconnected and feedback is configured', async () => {
		const socket = makeSocket(false);
		await emitWithAck(
			socket as unknown as Parameters<typeof emitWithAck>[0],
			'transport:next',
			{ zone_id: 'z' },
			{ feedback: { source: 'transport', command: 'transport:next' } }
		);

		const toast = get(commandFeedbackStore);
		expect(toast?.message).toBe('Not connected to server');
		expect(toast?.source).toBe('transport');
	});

	it('still emits when the socket is connected', async () => {
		const socket = makeSocket(true);
		// Resolve the ack synchronously so the promise resolves.
		socket.boundedEmit.mockImplementation(
			(
				_event: string,
				_payload: unknown,
				ack: (error: unknown, raw?: unknown) => void
			) => {
				ack(null, { success: true });
			}
		);

		const result = await emitWithAck(
			socket as unknown as Parameters<typeof emitWithAck>[0],
			'transport:play-pause',
			{ zone_id: 'z' }
		);

		expect(result.success).toBe(true);
		expect(socket.timeout).toHaveBeenCalledWith(5000);
		expect(socket.boundedEmit).toHaveBeenCalledTimes(1);
		expect(socket.emit).not.toHaveBeenCalled();
	});

	it('retires Socket.IO acknowledgement ownership when the server withholds the ack', async () => {
		vi.useFakeTimers();
		const manager = new Manager('http://localhost', { autoConnect: false });
		const socket = manager.socket('/');
		const internals = socket as unknown as {
			connected: boolean;
			acks: Record<string, (...values: unknown[]) => void>;
			packet: (packet: unknown) => void;
		};
		internals.connected = true;
		internals.packet = vi.fn();

		try {
			const pending = emitWithAck(socket, 'classic-session:acquire', {}, { timeoutMs: 10 });
			expect(Object.keys(internals.acks)).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(10);
			expect(Object.keys(internals.acks)).toHaveLength(0);
			await expect(pending).resolves.toEqual({ success: false, error: 'Command timed out' });
		} finally {
			socket.disconnect();
			vi.useRealTimers();
		}
	});
});

describe('emitIfConnected — fire-and-forget emit guard', () => {
	it('skips emit and returns false when disconnected', () => {
		const socket = makeSocket(false);
		const sent = emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' },
			{ source: 'browse', command: 'browse:search' }
		);

		expect(sent).toBe(false);
		expect(socket.emit).not.toHaveBeenCalled();
	});

	it('pushes a feedback toast on disconnected emit', () => {
		const socket = makeSocket(false);
		emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' },
			{ source: 'browse', command: 'browse:search' }
		);
		expect(get(commandFeedbackStore)?.message).toBe('Not connected to server');
	});

	it('emits and returns true when connected', () => {
		const socket = makeSocket(true);
		const sent = emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' }
		);
		expect(sent).toBe(true);
		expect(socket.emit).toHaveBeenCalledWith('browse:search', { input: 'beatles' });
	});

	it('does not push a feedback toast when no feedback option is given', () => {
		const socket = makeSocket(false);
		emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' }
		);
		expect(get(commandFeedbackStore)).toBeNull();
	});
});
