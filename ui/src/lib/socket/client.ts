import { browser } from '$app/environment';
import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export const getSocket = (): Socket | null => {
	if (!browser) {
		return null;
	}

	if (!socket) {
		// Try websocket first (lower latency) and fall back to long-polling
		// if it fails. NOTE: Engine.IO only attempts the next transport in
		// the array when `tryAllTransports: true` is set — without it,
		// `transports: ['websocket', 'polling']` is effectively
		// websocket-only, which silently fails on networks/proxies that
		// block upgrade requests.
		//
		// `reconnectionAttempts` caps the auto-reconnect budget. The
		// default is Infinity, which means `reconnect_failed` never fires
		// and the UI would sit on "Connecting…" forever for a genuinely
		// lost server. With ~1s → 5s backoff, 20 attempts is roughly
		// 1.5 minutes before we flip to "Disconnected" and prompt a
		// refresh. Short blips (laptop wake, mobile handoff) finish well
		// before that threshold.
		socket = io({
			path: '/socket.io',
			transports: ['websocket', 'polling'],
			tryAllTransports: true,
			reconnectionAttempts: 20
		});
	}

	return socket;
};
