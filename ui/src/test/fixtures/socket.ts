import { vi } from 'vitest';

/**
 * Test double for the socket.io client used by `$lib/socket/client`.
 * Returned by `createFakeSocket()` so each test file gets its own
 * instance — call this once at module level, wire it into the
 * `vi.mock('$lib/socket/client', ...)` factory's closure, and call
 * `mockReset()` on `.emit` between tests if you assert on calls.
 *
 * Includes the `io` reconnect handle so layout / library tests that
 * subscribe to reconnect events don't crash. Components that don't
 * use `io` simply ignore it.
 */
export interface FakeSocket {
	emit: ReturnType<typeof vi.fn>;
	timeout: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	off: ReturnType<typeof vi.fn>;
	connected: boolean;
	io: {
		on: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
	};
}

export function createFakeSocket(): FakeSocket {
	const socket: FakeSocket = {
		emit: vi.fn(),
		timeout: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		connected: true,
		io: { on: vi.fn(), off: vi.fn() }
	};
	socket.timeout.mockImplementation(() => ({
		emit: (
			event: string,
			payload: unknown,
			ack: (error: unknown, response?: unknown) => void
		) =>
			(
				socket.emit as unknown as (
					event: string,
					payload: unknown,
					ack: (response: unknown) => void
				) => unknown
			)(event, payload, (response) => ack(null, response))
	}));
	return socket;
}
