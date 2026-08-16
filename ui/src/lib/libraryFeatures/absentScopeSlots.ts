import { readable } from 'svelte/store';
import type {
	LibraryScopeSlots,
	PlaylistsScopeLoadState,
	ScopeLoadState
} from './scopeSlotContract';

/**
 * The library scope slots for a build that does not carry the extended library
 * views. This is the default resolution: `resolveScopeSlots.js` picks this
 * module whenever the implementation directory is not on disk, so a checkout
 * without it builds, type-checks and runs with no configuration, no flag and
 * no environment variable.
 *
 * Every slot answers honestly rather than pretending. The views are `null`,
 * which makes the surface render the hint it already renders for a restored
 * page whose feature gate has dropped — the scope is absent, never shown
 * disabled or broken. The stores are inert: nothing loaded, nothing loading,
 * no error, because "no error" is the truth. A build without the feature has
 * not failed to load it.
 *
 * The loaders resolve instead of rejecting for the same reason the backend's
 * feature layer never throws: the surface asks whether a scope needs data
 * before it renders, and an absent scope must not turn that question into an
 * unhandled rejection.
 */

/**
 * The extended state shapes belong to whatever supplies the slots, so this
 * build knows only the load fields the surface itself acts on. The index
 * signature is what lets code that forwards a state object keep compiling
 * against either resolution: it says the rest of the shape exists and is not
 * this build's business, rather than asserting the shape is empty.
 */
export interface MostPlayedState extends ScopeLoadState {
	readonly [field: string]: unknown;
}

export interface PlaylistsState extends PlaylistsScopeLoadState {
	readonly [field: string]: unknown;
}

export type ResolvedLibraryScopeSlots = LibraryScopeSlots<MostPlayedState, PlaylistsState>;

/**
 * Left un-annotated so it keeps the implicit index signature an object literal
 * type carries; annotating it `ScopeLoadState` would make it unassignable to
 * the open state shapes above. `satisfies` still checks it against the
 * contract.
 */
const inertState = {
	loading: false,
	loaded: false,
	error: null
} satisfies ScopeLoadState;

/** Nothing loaded means no playlists, so the scope chip's total is zero. */
const inertPlaylistsState = {
	...inertState,
	playlists: []
} satisfies PlaylistsScopeLoadState;

const inertMostPlayedStore = readable<MostPlayedState>(inertState);
const inertPlaylistsStore = readable<PlaylistsState>(inertPlaylistsState);

const noop = (): void => {};
const resolved = async (): Promise<void> => {};

export const libraryScopeSlots: ResolvedLibraryScopeSlots = {
	mostPlayedView: null,
	playlistsView: null,
	mostPlayedStore: inertMostPlayedStore,
	loadMostPlayed: resolved,
	resetMostPlayed: noop,
	playlistsStore: inertPlaylistsStore,
	loadPlaylists: resolved,
	openPlaylist: resolved,
	closePlaylist: noop,
	resetPlaylists: noop,
	/** No workspaces in this build: nothing rendered, nothing disabled. */
	workspaceLinks: []
};
