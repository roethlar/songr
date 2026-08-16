import { mount } from 'svelte';

import '../../src/app.css';
import '../../src/routes/library/unified-surface.css';
import UnifiedTrackPage from '../../src/routes/library/UnifiedTrackPage.svelte';
import type { PaletteSearchRow } from '../../src/lib/stores/unifiedPaletteSearchStore';
import type { UnifiedSongRelationship } from '@shared/unifiedSearchContracts';
import type { UnifiedLibraryDensity } from '../../src/lib/stores/unifiedLibraryPrefsStore';

const song: PaletteSearchRow = {
	resultId: 'result-fixture-track',
	title: 'Fixture Song',
	subtitle: 'Fixture Artist — First Fixture Album',
	imageKey: null
};

const relationship: UnifiedSongRelationship = {
	songTitle: 'Fixture Song',
	albums: [
		{
			albumLocalId: 'album-one',
			artistLocalId: 'artist-fixture',
			title: 'First Fixture Album',
			artist: 'Fixture Artist',
			editionText: ''
		}
	],
	composerLabels: ['Jamie Composer']
};

const log: string[] = [];

const target = document.querySelector<HTMLElement>('#app');
if (!target) throw new Error('Missing editorial track fixture target');

mount(UnifiedTrackPage, {
	target,
	props: {
		song,
		zones: [{ zoneId: 'zone-a', name: 'Kitchen' }],
		relationshipPhase: 'ready',
		relationship,
		onBack() {
			log.push('back');
		},
		onClose() {
			log.push('close');
		},
		onAction(semantic, zoneId) {
			log.push(`${semantic}@${zoneId}`);
		},
		onFavorite() {
			log.push('favorite');
		},
		onOpenAlbum(album) {
			log.push(`album:${album.albumLocalId}`);
		},
		onOpenArtist(artistLocalId) {
			log.push(`artist:${artistLocalId}`);
		},
		onOpenComposer(label) {
			log.push(`composer:${label}`);
		}
	}
});

const fixture = {
	setPresentation(theme: 'dark' | 'light', density: UnifiedLibraryDensity) {
		document.documentElement.dataset.theme = theme;
		target.dataset.d = density;
	},
	actionLog(): string[] {
		return [...log];
	}
};

declare global {
	interface Window {
		editorialTrackFixture: typeof fixture;
	}
}

window.editorialTrackFixture = fixture;
