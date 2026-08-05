export { coreStore, isCorePaired, loadCoreStatus, setCoreStatus } from './coreStore';
export { zonesStore, zoneMapStore, loadZones, setZonesSnapshot, upsertZone, removeZone, updateSeekPosition } from './zonesStore';
export { interpolatedSeekStore } from './interpolatedSeekStore';
export { nowPlayingStore, nowPlayingList, setNowPlaying, removeNowPlaying, resetNowPlaying } from './nowPlayingStore';
export { queueStore, setQueueSnapshot, clearQueue, resetQueue } from './queueStore';
export { selectedZoneStore, setSelectedZone } from './selectedZoneStore';
export { themeStore, initializeTheme, setTheme, toggleTheme } from './themeStore';
export {
	browseStore,
	setBrowseResult,
	appendBrowseItems,
	setBrowseLoading,
	setBrowseError,
	setSearchLoading,
	setSearchError,
	setSearchResults,
	clearSearchResults,
	resetBrowse
} from './browseStore';
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
export { browseNavStore } from './browseNavStore';
export { socketStatusStore, setSocketStatus, type SocketStatus } from './socketStatusStore';
export {
	browseHistoryStore,
	getClassicHistorySnapshot,
	pushHistory,
	popHistory,
	popForward,
	resetHistory,
	replaceHistory,
	type BrowseBreadcrumb,
	type BrowseHistoryContext,
	type BrowseHistoryStep,
	type ClassicHistorySnapshot
} from './browseHistoryStore';
export {
	exploreRailStore,
	resolveExploreRail,
	invalidateExploreRail,
	type ExploreRailEntry,
	type ExploreRailState
} from './exploreRailStore';
export {
	welcomeStatsStore,
	loadWelcomeStats,
	invalidateWelcomeStats,
	type WelcomeStats,
	type WelcomeStatsState
} from './welcomeStatsStore';
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

export async function initializeStores(fetchFn: typeof fetch): Promise<void> {
	await Promise.all([
		loadCoreStatus(fetchFn),
		loadZones(fetchFn),
		loadRecentlyPlayed(fetchFn),
		loadFavorites(fetchFn),
		loadHealth(fetchFn)
	]);
}
