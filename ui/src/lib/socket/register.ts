import { getSocket } from './client';
import { get } from 'svelte/store';
import {
	setCoreStatus,
	setZonesSnapshot,
	upsertZone,
	removeZone,
	setNowPlaying,
	removeNowPlaying,
	setQueueSnapshot,
	clearQueue,
	pushCommandFeedback,
	nowPlayingStore,
	updateSeekPosition,
	initializeStores,
	setSocketStatus,
	applyRecentlyPlayedInserted,
	applyRecentlyPlayedCleared
} from '../stores';
import type {
	CoreStatusResponse,
	Zone,
	NowPlaying,
	RecentlyPlayedInsertedPayload,
	RecentlyPlayedClearedPayload,
	ZoneQueue
} from '@shared/types';

interface CoreStatusEvent {
	coreStatus: CoreStatusResponse['status'];
	coreInfo?: {
		id: string;
		displayName: string;
		displayVersion: string;
	};
}

interface ZonesEvent {
	zones: Zone[];
}

interface ZoneUpdatedEvent {
	zone: Zone;
}

interface ZoneRemovedEvent {
	zone_id: string;
}

interface CommandErrorEvent {
	command: string;
	error: string;
}

type CleanupFn = () => void;

export function registerSocketHandlers(): CleanupFn {
	const socket = getSocket();
	if (!socket) {
		return () => {
			/* noop */
		};
	}

	const handleCoreStatus = (payload: CoreStatusEvent) => {
		const response: CoreStatusResponse = {
			status: payload.coreStatus,
			core: payload.coreInfo
				? {
					id: payload.coreInfo.id,
					displayName: payload.coreInfo.displayName,
					displayVersion: payload.coreInfo.displayVersion
				}
				: undefined
		};
		setCoreStatus(response);
	};

	const handleZonesSnapshot = (payload: ZonesEvent) => {
		setZonesSnapshot(payload.zones);
		const activeZones = new Set(payload.zones.map((zone) => zone.zone_id));
		const currentNowPlaying = get(nowPlayingStore);
		Object.keys(currentNowPlaying).forEach((zoneId) => {
			if (!activeZones.has(zoneId)) {
				removeNowPlaying(zoneId);
			}
		});
	};

	const handleZoneUpdated = (payload: ZoneUpdatedEvent) => {
		upsertZone(payload.zone);
	};

	const handleZoneRemoved = (payload: ZoneRemovedEvent) => {
		removeZone(payload.zone_id);
		removeNowPlaying(payload.zone_id);
		clearQueue(payload.zone_id);
	};

	const handleQueueUpdated = (payload: { queue: ZoneQueue }) => {
		setQueueSnapshot(payload.queue);
	};

	const handleSeekChanged = (payload: { zone_id: string; seek_position: number }) => {
		updateSeekPosition(payload.zone_id, payload.seek_position);
	};

	const handleNowPlaying = (payload: { zone_id: string; now_playing: NowPlaying | null }) => {
		if (payload.now_playing) {
			setNowPlaying(payload.zone_id, payload.now_playing);
		} else {
			removeNowPlaying(payload.zone_id);
		}
	};

	const handleRecentlyPlayedInserted = (payload: RecentlyPlayedInsertedPayload) => {
		applyRecentlyPlayedInserted(payload);
	};

	const handleRecentlyPlayedCleared = (payload: RecentlyPlayedClearedPayload) => {
		applyRecentlyPlayedCleared(payload);
	};

	const handleTransportError = (payload: CommandErrorEvent) => {
		pushCommandFeedback({
			source: 'transport',
			command: payload.command,
			message: payload.error
		});
	};

	const handleQueueError = (payload: CommandErrorEvent) => {
		pushCommandFeedback({
			source: 'queue',
			command: payload.command,
			message: payload.error
		});
	};

	// Tracks whether this connect is a RE-connect: a user who saw a
	// "Disconnected"/"Connection error" toast gets positive confirmation,
	// while the initial connect stays silent.
	let sawConnectionLoss = false;

	// A socket disconnect is NOT the same as a Roon core unpair. The core
	// state is owned by the server; clearing it here would lie to the user
	// during a transient WebSocket blip. On reconnect, the server re-emits
	// `core-status`, `zones`, and `now-playing-updated` for hydration, and
	// we additionally refetch via REST as a belt-and-braces backstop.
	const handleConnect = () => {
		const reconnected = sawConnectionLoss;
		sawConnectionLoss = false;
		setSocketStatus('connected');
		void initializeStores(fetch);
		if (reconnected) {
			pushCommandFeedback({
				source: 'transport',
				command: 'socket',
				kind: 'success',
				message: 'Reconnected to the server.'
			});
		}
	};

	const handleDisconnect = (reason: string) => {
		sawConnectionLoss = true;
		// socket.io disconnect reasons split into auto-reconnecting vs not.
		// 'io server disconnect' (server explicitly kicked us) and
		// 'io client disconnect' (we called .disconnect()) do NOT
		// auto-reconnect. Everything else (ping timeout, transport close,
		// transport error) does, so reflect that as "connecting".
		const noReconnect = reason === 'io server disconnect' || reason === 'io client disconnect';
		setSocketStatus(noReconnect ? 'disconnected' : 'connecting');
	};

	const handleReconnectFailed = () => {
		// Reconnection attempts exhausted — flip to a hard "disconnected".
		setSocketStatus('disconnected');
		pushCommandFeedback({
			source: 'transport',
			command: 'socket',
			message: 'Connection lost. Refresh the page to reconnect.'
		});
	};

	const handleConnectError = (error: Error) => {
		sawConnectionLoss = true;
		// connect_error fires for the *current* attempt; socket.io keeps
		// trying. Surface it once via the toast so a persistent failure is
		// visible, but keep the status pill in "connecting" rather than
		// flipping to a hard "disconnected" — that would be alarming during
		// a transient network blip on a phone or laptop lid-close.
		setSocketStatus('connecting');
		pushCommandFeedback({
			source: 'transport',
			command: 'socket',
			message: `Connection error: ${error.message}`
		});
	};

	const listeners: Array<[string, (...args: any[]) => void]> = [
		['core-status', handleCoreStatus],
		['zones', handleZonesSnapshot],
		['zone-updated', handleZoneUpdated],
		['zone-removed', handleZoneRemoved],
		['seek-changed', handleSeekChanged],
		['now-playing-updated', handleNowPlaying],
		['queue-updated', handleQueueUpdated],
		['recently-played-inserted', handleRecentlyPlayedInserted],
		['recently-played-cleared', handleRecentlyPlayedCleared],
		['transport:error', handleTransportError],
		['queue:error', handleQueueError]
	];

	listeners.forEach(([event, handler]) => {
		socket.on(event, handler);
	});

	socket.on('connect', handleConnect);
	socket.on('disconnect', handleDisconnect);
	socket.on('connect_error', handleConnectError);
	// reconnect_failed is on the manager, not the socket itself.
	socket.io.on('reconnect_failed', handleReconnectFailed);

	// `socket.connected` reflects the live state at registration time — set
	// the store accordingly so we don't show "connecting" when the socket
	// was already up before this handler attached.
	setSocketStatus(socket.connected ? 'connected' : 'connecting');

	return () => {
		listeners.forEach(([event, handler]) => {
			socket.off(event, handler);
		});
		socket.off('connect', handleConnect);
		socket.off('disconnect', handleDisconnect);
		socket.off('connect_error', handleConnectError);
		socket.io.off('reconnect_failed', handleReconnectFailed);
	};
}
