export { coreStore, isCorePaired, loadCoreStatus, setCoreStatus } from './coreStore';
export { zonesStore, zoneMapStore, loadZones, setZonesSnapshot, upsertZone, removeZone, updateSeekPosition } from './zonesStore';
export { interpolatedSeekStore } from './interpolatedSeekStore';
export { nowPlayingStore, nowPlayingList, setNowPlaying, removeNowPlaying, resetNowPlaying } from './nowPlayingStore';
export { queueStore, setQueueSnapshot, clearQueue, resetQueue } from './queueStore';
export {
	selectedZoneStore,
	setSelectedZone,
	setEffectiveZone,
	getPinnedZone
} from './selectedZoneStore';
export {
	commandFeedbackStore,
	commandFeedbackQueue,
	pushCommandFeedback,
	dismissCommandFeedback,
	clearCommandFeedback
} from './commandFeedbackStore';
export {
	pendingLibraryIntentStore,
	publishLibraryIntent,
	claimLibraryIntent,
	cancelLibraryIntent,
	resetLibraryIntentStore,
	type PendingLibraryIntent
} from './libraryIntentStore';
export { socketStatusStore, setSocketStatus, type SocketStatus } from './socketStatusStore';
export {
	recentlyPlayedStore,
	loadRecentlyPlayed,
	applyRecentlyPlayedInserted,
	applyRecentlyPlayedCleared,
	applyClearResponse,
	resetRecentlyPlayed,
	type RecentlyPlayedState
} from './recentlyPlayedStore';
export {
	favoritesStore,
	loadFavorites,
	addFavorite,
	removeFavorite,
	resetFavorites,
	type FavoritesState
} from './favoritesStore';

export { healthStore, loadHealth, setHealth } from './healthStore';

import { loadCoreStatus } from './coreStore';
import { loadZones } from './zonesStore';
import { loadRecentlyPlayed } from './recentlyPlayedStore';
import { loadFavorites } from './favoritesStore';
import { loadHealth } from './healthStore';
import { loadNavigationSettings } from './navigationSettingsStore';
import { loadPresentationSettings } from './presentationSettingsStore';
export { presentationSettingsStore, loadPresentationSettings, applyPresentationSettings } from './presentationSettingsStore';
export { navigationSettingsStore, loadNavigationSettings, applyNavigationSettings } from './navigationSettingsStore';

export async function initializeStores(fetchFn: typeof fetch): Promise<void> {
	await Promise.all([
		loadCoreStatus(fetchFn),
		loadZones(fetchFn),
		loadRecentlyPlayed(fetchFn),
		loadFavorites(fetchFn),
		loadHealth(fetchFn),
		loadNavigationSettings(fetchFn),
		loadPresentationSettings(fetchFn)
	]);
}
