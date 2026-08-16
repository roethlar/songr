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
import type { EditorialItemState } from '../../src/lib/library/EditorialItemController';
import type { EditorialItemView } from '@shared/editorialItemContracts';
import type { UnifiedLibraryDensity } from '../../src/lib/stores/unifiedLibraryPrefsStore';

// Long enough to cross the 700-character collapse threshold.
const LONG_REVIEW = Array.from(
	{ length: 12 },
	(_value, index) =>
		`Paragraph ${index + 1}: this synthetic review prose exists only to exercise the ` +
		'long-form collapse behaviour of the editorial text section in a real browser.'
).join(' ');

const albumView: EditorialItemView = {
	kind: 'album',
	title: 'Fixture Album',
	subtitle: 'Fixture Artist',
	sections: {
		review: { text: LONG_REVIEW, source: 'Fixture Provider', language: 'en' }
	},
	attribution: [{ text: 'Fixture Provider notice', url: 'https://example.com/about' }],
	creditGroups: [
		{
			label: 'Album',
			credits: [
				{ role: 'Producer', name: 'Casey Producer', followTarget: 'follow-producer' },
				{ role: 'Engineer', name: 'Robin Engineer' }
			]
		}
	],
	relationshipGroups: [
		{
			label: 'Similar albums',
			items: [
				{ title: 'Similar Album One', subtitle: 'Other Artist', followTarget: 'follow-similar' }
			]
		},
		{ label: 'See also', items: [{ title: 'Companion Album' }] }
	]
};

const trackView: EditorialItemView = {
	kind: 'track',
	title: 'Middle Song',
	sections: {
		description: {
			text: 'A short synthetic description of the composition behind this exact track.',
			source: 'Fixture Provider',
			language: 'en'
		}
	},
	creditGroups: [
		{ label: 'Composer', credits: [{ role: 'Composer', name: 'Jamie Composer' }] },
		{
			label: 'Performer',
			credits: [{ role: 'Performer', name: 'Casey Producer', followTarget: 'follow-producer' }]
		}
	]
};

const performerView: EditorialItemView = {
	kind: 'artist',
	title: 'Casey Producer',
	sections: {
		biography: {
			text: 'Casey Producer is a synthetic fixture performer with a short biography.',
			source: 'Fixture Provider',
			language: 'en'
		}
	}
};

const similarAlbumView: EditorialItemView = {
	kind: 'album',
	title: 'Similar Album One',
	subtitle: 'Other Artist',
	sections: {
		review: { text: 'A short synthetic review of the followed similar album.', source: 'Fixture Provider', language: 'en' }
	},
	creditGroups: [
		{ label: 'Album', credits: [{ role: 'Producer', name: 'Alex Producer' }] }
	]
};

function ready(view: EditorialItemView): EditorialItemState {
	return {
		phase: 'ready',
		requestId: 'request-editorial',
		sessionId: 'session-editorial',
		generation: 1,
		view,
		code: null,
		section: null,
		retryable: false,
		error: null
	};
}

function initialSheet(): LibraryAlbumState {
	return {
		phase: 'details',
		activeTab: 'details',
		albumLocalId: 'album-editorial',
		generation: 1,
		requestId: 'request-a',
		operationId: 'operation-a',
		resolvingDeadlineAt: Date.now() + 30_000,
		artist: 'Fixture Artist',
		title: 'Fixture Album',
		versions: [
			{
				versionId: 'version-a',
				editionText: '',
				phase: 'loaded',
				trackCount: 3,
				code: null,
				error: null
			}
		],
		selectedVersionId: 'version-a',
		actionsAvailable: true,
		orderedTracks: [
			{ index: 0, title: 'Opening Song' },
			{ index: 1, title: 'Middle Song' },
			{ index: 2, title: 'Closing Song' }
		],
		code: null,
		error: null,
		transitionedAt: Date.now()
	};
}

const sheet = writable(initialSheet());
const action = writable({ phase: 'idle', actions: [], error: null });

const controller = {
	subscribe: sheet.subscribe,
	select() {
		return { started: false, versionId: null };
	},
	showVersions() {},
	showDetails() {}
} as unknown as LibraryAlbumController;

const actionController = {
	subscribe: action.subscribe,
	execute() {},
	cancel() {},
	reset() {}
} as unknown as AlbumActionController;

const target = document.querySelector<HTMLElement>('#app');
if (!target) throw new Error('Missing editorial album fixture target');

// The fixture plays the host role UnifiedLibraryMode owns in the app:
// follow/back swap the editorial state the way the mode's retained
// anchors would. `childContext` mirrors the retained track anchor.
let childContext: 'album' | 'track' = 'album';

const props = $state({
	controller,
	actionController,
	zones: [{ zoneId: 'zone-a', name: 'Kitchen' }] as { zoneId: string; name: string }[],
	backLabel: 'Albums',
	onBack() {},
	onRetry() {},
	onBeginAction() {},
	editorial: ready(albumView) as EditorialItemState | null,
	editorialFollowActive: false,
	onEditorialRetry() {},
	onEditorialFollow(followTarget: string) {
		if (followTarget === 'follow-producer') {
			props.editorial = ready(performerView);
		} else if (followTarget === 'follow-similar') {
			props.editorial = ready(similarAlbumView);
			props.editorialFollowActive = true;
		}
	},
	onEditorialBack() {
		// A performer followed from track credits backs out to those
		// credits; every other back lands on the album's own view.
		if (childContext === 'track' && props.editorial?.view?.kind === 'artist') {
			props.editorial = ready(trackView);
			return;
		}
		childContext = 'album';
		props.editorialFollowActive = false;
		props.editorial = ready(albumView);
	},
	onOpenTrackInfo(_position: number) {
		childContext = 'track';
		props.editorial = ready(trackView);
	}
});

mount(UnifiedAlbumPage, { target, props });

const fixture = {
	reset() {
		childContext = 'album';
		props.editorialFollowActive = false;
		props.editorial = ready(albumView);
		// A fresh sheet value re-runs the page's track-list effect, which
		// closes any open exact-track child.
		sheet.set(initialSheet());
	},
	setPresentation(theme: 'dark' | 'light', density: UnifiedLibraryDensity) {
		document.documentElement.dataset.theme = theme;
		target.dataset.d = density;
	},
	failReview() {
		props.editorial = {
			phase: 'failed',
			requestId: 'request-editorial',
			sessionId: 'session-editorial',
			generation: 1,
			view: null,
			code: 'READ_TIMEOUT',
			section: 'review',
			retryable: true,
			error: 'timed out'
		};
	}
};

declare global {
	interface Window {
		editorialAlbumFixture: typeof fixture;
	}
}

window.editorialAlbumFixture = fixture;
