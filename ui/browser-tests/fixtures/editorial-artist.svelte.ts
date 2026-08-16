import { createRawSnippet, mount } from 'svelte';

import '../../src/app.css';
import '../../src/routes/library/unified-surface.css';
import UnifiedArtistPage from '../../src/routes/library/UnifiedArtistPage.svelte';
import type {
	LibraryAlbumEntry,
	LibraryArtistEntry
} from '../../src/lib/stores/libraryIndexStore';
import type { EditorialItemState } from '../../src/lib/library/EditorialItemController';
import type { EditorialItemView } from '@shared/editorialItemContracts';
import type { UnifiedLibraryDensity } from '../../src/lib/stores/unifiedLibraryPrefsStore';

// Long enough to cross the 700-character collapse threshold.
const LONG_BIOGRAPHY = Array.from(
	{ length: 12 },
	(_value, index) =>
		`Paragraph ${index + 1}: this synthetic biography prose exists only to exercise the ` +
		'long-form collapse behaviour of the editorial text section in a real browser.'
).join(' ');

const artistView: EditorialItemView = {
	kind: 'artist',
	title: 'Fixture Artist',
	sections: {
		biography: { text: LONG_BIOGRAPHY, source: 'Fixture Provider', language: 'en' }
	},
	attribution: [{ text: 'Fixture Provider notice' }],
	relationshipGroups: [
		{
			label: 'Similar artists',
			items: [
				{ title: 'Kindred Artist', subtitle: 'Similar', followTarget: 'follow-kindred' },
				{ title: 'Unlinked Artist' }
			]
		},
		{ label: 'Influenced', items: [{ title: 'Descendant Artist', followTarget: 'follow-descendant' }] }
	],
	links: [
		{ text: 'example.com', url: 'https://example.com/fixture-artist' },
		{ text: 'example.org', url: 'https://example.org/fixture-artist' }
	]
};

const relatedArtistView: EditorialItemView = {
	kind: 'artist',
	title: 'Kindred Artist',
	sections: {
		biography: {
			text: 'Kindred Artist is a synthetic fixture performer with a short biography.',
			source: 'Fixture Provider',
			language: 'en'
		}
	}
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

const artist: LibraryArtistEntry = {
	id: 'artist-fixture',
	name: 'Fixture Artist',
	searchKey: 'fixture artist',
	albumCount: 2,
	countComplete: true,
	catalogLocalId: 'artist-fixture'
};

const albums: LibraryAlbumEntry[] = [
	{
		id: 'album-one',
		title: 'First Fixture Album',
		artist: 'Fixture Artist',
		searchKey: 'first fixture album fixture artist',
		artistId: 'artist-fixture'
	},
	{
		id: 'album-two',
		title: 'Second Fixture Album',
		artist: 'Fixture Artist',
		searchKey: 'second fixture album fixture artist',
		artistId: 'artist-fixture'
	}
];

const discography = createRawSnippet(() => ({
	render: () =>
		`<div data-testid="fixture-discography">${albums
			.map((album) => `<span>${album.title}</span>`)
			.join('')}</div>`
}));

const target = document.querySelector<HTMLElement>('#app');
if (!target) throw new Error('Missing editorial artist fixture target');

const props = $state({
	artist,
	albums,
	overlayPhase: 'idle' as const,
	truncated: false,
	backLabel: 'Artists',
	onBack() {},
	discography,
	editorial: ready(artistView) as EditorialItemState | null,
	editorialFollowActive: false,
	onEditorialRetry() {},
	onEditorialFollow(followTarget: string) {
		if (followTarget === 'follow-kindred') {
			props.editorial = ready(relatedArtistView);
			props.editorialFollowActive = true;
		}
	},
	onEditorialBack() {
		props.editorialFollowActive = false;
		props.editorial = ready(artistView);
	}
});

mount(UnifiedArtistPage, { target, props });

const fixture = {
	reset() {
		props.editorialFollowActive = false;
		props.editorial = ready(artistView);
	},
	setPresentation(theme: 'dark' | 'light', density: UnifiedLibraryDensity) {
		document.documentElement.dataset.theme = theme;
		target.dataset.d = density;
	}
};

declare global {
	interface Window {
		editorialArtistFixture: typeof fixture;
	}
}

window.editorialArtistFixture = fixture;
