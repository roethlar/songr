import { mount } from 'svelte';
import { writable } from 'svelte/store';

import '../../src/app.css';
import '../../src/routes/library/unified-surface.css';
import UnifiedAlbumPage from '../../src/routes/library/UnifiedAlbumPage.svelte';
import type {
	LibraryAlbumController,
	LibraryAlbumState
} from '../../src/lib/library/LibraryAlbumController';
import type { AlbumActionController } from '../../src/lib/library/AlbumActionController';
import type { UnifiedLibraryDensity } from '../../src/lib/stores/unifiedLibraryPrefsStore';

const VERSION_A = 'version-a';
const VERSION_B = 'version-b';

function initialState(): LibraryAlbumState {
	return {
		phase: 'versions',
		activeTab: 'versions',
		albumLocalId: 'album-a',
		generation: 4,
		requestId: 'request-a',
		operationId: 'operation-a',
		resolvingDeadlineAt: Date.now() + 30_000,
		artist: 'Fixture Artist',
		title: 'Fixture Album',
		versions: [
			{
				versionId: VERSION_A,
				editionText: '',
				phase: 'idle',
				trackCount: null,
				code: null,
				error: null
			},
			{
				versionId: VERSION_B,
				editionText: '',
				phase: 'idle',
				trackCount: null,
				code: null,
				error: null
			}
		],
		selectedVersionId: null,
		actionsAvailable: false,
		orderedTracks: [],
		code: null,
		error: null,
		transitionedAt: Date.now()
	};
}

const sheet = writable(initialState());
const action = writable({ phase: 'idle', actions: [], error: null });

const controller = {
	subscribe: sheet.subscribe,
	select(versionId: string) {
		sheet.update((state) => ({
			...state,
			phase: 'loading-detail',
			activeTab: 'details',
			selectedVersionId: versionId,
			actionsAvailable: false,
			orderedTracks: [],
			versions: state.versions.map((version) =>
				version.versionId === versionId ? { ...version, phase: 'loading' as const } : version
			)
		}));
		return { started: true, versionId };
	},
	showVersions() {
		sheet.update((state) => ({ ...state, activeTab: 'versions' }));
	},
	showDetails() {
		sheet.update((state) => ({ ...state, activeTab: 'details' }));
	}
} as unknown as LibraryAlbumController;

const actionController = {
	subscribe: action.subscribe,
	execute() {},
	cancel() {},
	reset() {}
} as unknown as AlbumActionController;

const target = document.querySelector<HTMLElement>('#app');
if (!target) throw new Error('Missing album versions fixture target');

mount(UnifiedAlbumPage, {
	target,
	props: {
		controller,
		actionController,
		zones: [{ zoneId: 'zone-a', name: 'Kitchen' }],
		backLabel: 'Albums',
		onBack() {},
		onRetry() {},
		onBeginAction() {}
	}
});

const fixture = {
	reset() {
		sheet.set(initialState());
	},
	setPresentation(theme: 'dark' | 'light', density: UnifiedLibraryDensity) {
		document.documentElement.dataset.theme = theme;
		target.dataset.d = density;
	},
	resolve(versionId: string) {
		const tracks = Array.from({ length: versionId === VERSION_A ? 11 : 13 }, (_value, index) => ({
			index,
			title: `${versionId === VERSION_A ? 'Studio' : 'Live'} track ${index + 1}`
		}));
		sheet.update((state) => ({
			...state,
			phase: 'details',
			activeTab: 'details',
			selectedVersionId: versionId,
			actionsAvailable: true,
			orderedTracks: tracks,
			versions: state.versions.map((version) =>
				version.versionId === versionId
					? { ...version, phase: 'loaded' as const, trackCount: tracks.length }
					: version
			)
		}));
	},
	fail(versionId: string) {
		sheet.update((state) => ({
			...state,
			phase: 'versions',
			activeTab: 'versions',
			versions: state.versions.map((version) =>
				version.versionId === versionId
					? {
							...version,
							phase: 'failed' as const,
							code: 'DETAIL_INCOMPLETE',
							error: 'That version could not be read'
						}
					: version
			)
		}));
	}
};

declare global {
	interface Window {
		albumVersionsFixture: typeof fixture;
	}
}

window.albumVersionsFixture = fixture;
