import type { Component } from 'svelte';
import type { Readable } from 'svelte/store';
import type { LibraryAlbumEntry } from '$lib/stores/libraryIndexStore';
import type {
	ActionablePublicSongAuthority,
	PublicSongActionController
} from '$lib/library/PublicSongActionController';
import type { DateFeatureGate } from '$lib/unifiedLibrarySorts';
import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';

/**
 * The interface between the library surface and the extended library scopes
 * (Most played, Playlists), which are supplied by a build-time slot registry
 * rather than imported directly.
 *
 * Why a registry at all: Vite and SvelteKit bundle components statically, so a
 * `.svelte` file named in an import is a hard build dependency. A runtime
 * `try`/`catch` cannot stand in for a file that is not there. The host must
 * therefore never name the extended views; it names this interface, and one
 * alias decides at config-load time which module satisfies it. See
 * `resolveScopeSlots.js` for that decision and `absentScopeSlots.ts` for the
 * resolution that needs no configuration.
 *
 * The dependency direction is one-way on purpose: whatever supplies the slots
 * depends on this file, never the reverse. That is what keeps the host
 * compiling when the implementation is absent. Nothing here may name anything
 * from behind the wall, which is why the state types are parameters rather
 * than concrete shapes: the constraints below say everything the surface reads
 * off a scope state, and it forwards the rest to whichever view came with it.
 */

/** What the surface itself reads off any scope store, whatever supplies it. */
export interface ScopeLoadState {
	readonly loading: boolean;
	readonly loaded: boolean;
	readonly error: string | null;
}

/**
 * The Playlists scope additionally owes the surface a count, because the scope
 * chip reports a total. The surface needs to know how many there are; it has no
 * business knowing what one is, which is why the element type is `unknown`.
 * Every requirement the surface places on a slot state belongs here rather than
 * being discovered when a build without the views fails to compile.
 */
export interface PlaylistsScopeLoadState extends ScopeLoadState {
	readonly playlists: readonly unknown[];
}

export interface ScopeZoneOption {
	readonly zoneId: string;
	readonly name: string;
}

/**
 * A row the surface can hand to the public song resolver. Playlist and Most
 * played rows carry different authority unions behind the wall; both narrow to
 * the actionable public authority, which is the only part the host touches.
 */
export interface ScopeActionTarget {
	readonly authority: ActionablePublicSongAuthority;
	readonly title: string;
}

export interface MostPlayedScopeViewProps<State extends ScopeLoadState> {
	gate: DateFeatureGate;
	state: State;
	actionController: PublicSongActionController;
	zones: readonly ScopeZoneOption[];
	onBeginAction: (
		target: ScopeActionTarget,
		zoneId: string,
		desiredSemantic: UnifiedSongActionSemantic
	) => void;
	onClearAction: () => void;
	onOpenAlbum: (albumLocalId: string) => void;
	fetchFn: typeof fetch;
}

export interface PlaylistsScopeViewProps<State extends PlaylistsScopeLoadState> {
	gate: DateFeatureGate;
	playlistsStore: Readable<State>;
	openPlaylistData: (fetchFn: typeof fetch, playlistId: string) => Promise<void>;
	closePlaylistView: () => void;
	actionController: PublicSongActionController;
	zones: readonly ScopeZoneOption[];
	onBeginAction: (
		target: ScopeActionTarget,
		zoneId: string,
		desiredSemantic: UnifiedSongActionSemantic
	) => void;
	albums: readonly LibraryAlbumEntry[];
	fetchFn: typeof fetch;
}

/**
 * The slots the library surface resolves through the `@libraryFeatures` alias.
 *
 * A `null` view is the honest answer for a build that does not carry the scope:
 * the surface renders its own hint for the scope instead, the same hint it
 * already renders for a restored page whose feature gate has dropped. There is
 * no disabled state anywhere in here — a scope the build cannot serve is
 * absent, never rendered broken.
 *
 * The store slots are never null. A build without the views still runs the
 * surface's scope-activation path, which asks whether data needs loading
 * before it decides to render anything; an inert store answers that honestly
 * (nothing loaded, nothing loading, no error) and its loader is a no-op.
 */
export interface LibraryScopeSlots<
	MostPlayed extends ScopeLoadState,
	Playlists extends PlaylistsScopeLoadState
> {
	readonly mostPlayedView: Component<MostPlayedScopeViewProps<MostPlayed>> | null;
	readonly playlistsView: Component<PlaylistsScopeViewProps<Playlists>> | null;
	readonly mostPlayedStore: Readable<MostPlayed>;
	readonly loadMostPlayed: (fetchFn: typeof fetch) => Promise<void>;
	readonly resetMostPlayed: () => void;
	readonly playlistsStore: Readable<Playlists>;
	readonly loadPlaylists: (fetchFn: typeof fetch) => Promise<void>;
	readonly openPlaylist: (fetchFn: typeof fetch, playlistId: string) => Promise<void>;
	readonly closePlaylist: () => void;
	readonly resetPlaylists: () => void;
}
