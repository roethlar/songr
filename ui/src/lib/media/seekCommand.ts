/**
 * The one way the UI asks a zone to seek.
 *
 * `sendSeek` plus its `createOptimisticSeekBase()` used to be written out
 * twice, verbatim, in `+layout.svelte` and `NowPlayingOverlay.svelte`. Both
 * copies now come from here, so the optimistic base, the token-guarded
 * invalidation and the emit itself have exactly one implementation, and the
 * shared `SeekBar` component can be mounted in a fixture with a recording
 * command in place of the socket.
 */
import { get } from 'svelte/store';
import type { SeekRequest } from '@shared/types';
import { createOptimisticSeekBase } from '$lib/seekKeys';
import { getSocket } from '$lib/socket/client';
import { emitWithAck } from '$lib/socket/emit';
import { pushCommandFeedback } from '$lib/stores/commandFeedbackStore';
import { selectedZoneStore } from '$lib/stores/selectedZoneStore';

export interface SeekCommand {
	/**
	 * Where a relative seek should step from: the last target we sent, while
	 * it is still fresh, rather than a server position that only updates at
	 * ~1 Hz. `contextKey` identifies zone + track, so a track change cannot
	 * reuse the previous track's absolute target.
	 */
	base(contextKey: string | null, serverPosition: number): number;
	/** Send an absolute seek, in seconds, to the selected zone. */
	send(contextKey: string | null, seconds: number): void;
}

export function createSeekCommand(): SeekCommand {
	const optimistic = createOptimisticSeekBase();

	return {
		base: (contextKey, serverPosition) => optimistic.base(contextKey, serverPosition),
		send(contextKey, seconds) {
			const zoneId = get(selectedZoneStore);
			if (!zoneId) return;
			const socket = getSocket();
			if (!socket) {
				pushCommandFeedback({
					source: 'transport',
					command: 'socket',
					message: 'Realtime connection unavailable.'
				});
				return;
			}
			const token = optimistic.record(contextKey, seconds);
			void emitWithAck(
				socket,
				'transport:seek',
				{ zone_id: zoneId, seconds } satisfies SeekRequest,
				{ feedback: { source: 'transport', command: 'transport:seek' } }
			).then((res) => {
				// A failed/disconnected seek must not leave a phantom base;
				// token-guarded so an older failure never clears a newer
				// pending seek.
				if (!res?.success) optimistic.invalidate(token);
			});
		}
	};
}
