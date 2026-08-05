import type { Socket } from 'socket.io-client';
import { pushCommandFeedback, type CommandSource } from '../stores/commandFeedbackStore';

/**
 * Standardized ack response shape that the server sends for every
 * command that supplies an ack callback. Mirrors `AckResponse<T>` in
 * `src/server/socket/index.ts`.
 */
export type AckResponse<T = undefined> =
	| { success: true; data?: T }
	| { success: false; error: string; code?: string };

export interface EmitWithAckOptions {
	/** Override the per-call timeout in ms. Default 5000. */
	timeoutMs?: number;
	/** If set, push a feedback toast on failure under this source/command. */
	feedback?: { source: CommandSource; command: string };
}

export interface BoundedAckSocket {
	timeout(milliseconds: number): {
		emit(
			event: string,
			payload: unknown,
			ack: (error: unknown, response?: unknown) => void
		): unknown;
	};
}

export type BoundedAckResult =
	| { readonly acknowledged: true; readonly value: unknown }
	| { readonly acknowledged: false; readonly error: unknown };

/**
 * Use Socket.IO's own acknowledgement timeout so its private ack registry and
 * any matching buffered packet are retired along with the application result.
 */
export function emitWithBoundedAck(
	socket: BoundedAckSocket,
	event: string,
	payload: unknown,
	timeoutMs: number,
	onResult: (result: BoundedAckResult) => void
): void {
	socket.timeout(timeoutMs).emit(event, payload, (error, value) => {
		onResult(
			error
				? { acknowledged: false, error }
				: { acknowledged: true, value }
		);
	});
}

/**
 * Emit a socket event with an ack callback. Returns the parsed AckResponse.
 *
 * Failure modes that surface as `{ success: false }`:
 * - Server-reported error
 * - Timeout (no ack within `timeoutMs`)
 * - Malformed ack payload
 *
 * If `feedback` is provided, failures are also pushed to commandFeedbackStore
 * so the user sees a toast. Callers should still inspect the return value
 * if they need to take action on the result.
 */
export function emitWithAck<T = undefined>(
	socket: Socket,
	event: string,
	payload: unknown,
	options: EmitWithAckOptions = {}
): Promise<AckResponse<T>> {
	const timeoutMs = options.timeoutMs ?? 5000;

	return new Promise<AckResponse<T>>((resolve) => {
		// Fail fast when the socket is disconnected. socket.io's default
		// behavior is to BUFFER an emit issued while disconnected and
		// flush it on reconnect — for transport-style commands
		// (play/pause/seek/volume/queue) that's wrong: a play issued + UI-
		// timed-out 30s ago shouldn't fire when reconnect lands. We
		// reject here so the caller sees the failure immediately and the
		// user gets a feedback toast; the buffered emit never happens
		// because we never call socket.emit().
		if (!socket.connected) {
			const response: AckResponse<T> = {
				success: false,
				error: 'Not connected to server'
			};
			if (options.feedback) {
				pushCommandFeedback({
					source: options.feedback.source,
					command: options.feedback.command,
					message: response.error
				});
			}
			resolve(response);
			return;
		}

		let settled = false;
		const settle = (response: AckResponse<T>) => {
			if (settled) return;
			settled = true;
			if (!response.success && options.feedback) {
				pushCommandFeedback({
					source: options.feedback.source,
					command: options.feedback.command,
					message: response.error
				});
			}
			resolve(response);
		};

		try {
			emitWithBoundedAck(socket, event, payload, timeoutMs, (result) => {
				if (!result.acknowledged) {
					settle({ success: false, error: 'Command timed out' });
					return;
				}
				settle(parseAck<T>(result.value));
			});
		} catch (err) {
			settle({
				success: false,
				error: err instanceof Error ? err.message : 'Failed to send command'
			});
		}
	});
}

/**
 * Fire-and-forget emit for events that do not use acknowledgments.
 * Like `emitWithAck`, fails fast when disconnected so socket.io can't
 * buffer the emit and replay it on reconnect as a stale command.
 *
 * Returns true if the emit went out, false if disconnected. Caller
 * can use the return value to skip downstream work (e.g. setting
 * loading state) when delivery isn't going to happen.
 */
export function emitIfConnected(
	socket: Socket,
	event: string,
	payload?: unknown,
	feedback?: { source: CommandSource; command: string }
): boolean {
	if (!socket.connected) {
		if (feedback) {
			pushCommandFeedback({
				source: feedback.source,
				command: feedback.command,
				message: 'Not connected to server'
			});
		}
		return false;
	}
	socket.emit(event, payload);
	return true;
}

function parseAck<T>(raw: unknown): AckResponse<T> {
	if (raw && typeof raw === 'object' && 'success' in raw) {
		const r = raw as Record<string, unknown>;
		if (r.success === true) {
			return { success: true, data: r.data as T };
		}
		if (r.success === false && typeof r.error === 'string') {
			return {
				success: false,
				error: r.error,
				code: typeof r.code === 'string' ? r.code : undefined
			};
		}
	}
	// Tolerate older or odd ack shapes — treat as success when nothing
	// looks like an error, otherwise surface as a generic failure.
	if (raw && typeof raw === 'object' && 'error' in raw && typeof (raw as { error: unknown }).error === 'string') {
		return { success: false, error: (raw as { error: string }).error };
	}
	return { success: true };
}
