import type {
	ScenarioName,
	SyntheticAlbum,
	SyntheticArtist,
	SyntheticBranch,
	SyntheticCatalog,
	SyntheticPagingStressFixture,
	SyntheticScenario,
	SyntheticScenarioDefinition
} from './types';

export const SYNTHETIC_ARTIST_COUNT = 1_671;
export const SYNTHETIC_ALBUM_COUNT = 3_896;
export const PAGING_STRESS_ALBUM_COUNT = 4_541;

export const SCENARIOS = {
	small: {
		id: 'small',
		label: 'One-release artist',
		discographySize: 1,
		description: 'Fits a single known release without leaving it stranded in empty space.'
	},
	medium: {
		id: 'medium',
		label: 'Eleven-release artist',
		discographySize: 11,
		description: 'Exercises chronology, same-year collisions, and an honest Undated tail.'
	},
	large: {
		id: 'large',
		label: 'Thirty-eight-release artist',
		discographySize: 38,
		description: 'Exercises bounded navigation and semantic zoom with three branches.'
	},
	stress: {
		id: 'stress',
		label: 'Paging and culling stress',
		discographySize: PAGING_STRESS_ALBUM_COUNT,
		description: 'Exercises the real index and renderer caps without becoming an artwork wall.'
	}
} as const satisfies Record<ScenarioName, SyntheticScenarioDefinition>;

const SYNTHETIC_TITLE_WORDS = [
	'Blue',
	'Orbit',
	'Paper',
	'Harbor',
	'Quiet',
	'Signal',
	'Glass',
	'Morning',
	'Field',
	'Ember',
	'North',
	'Current'
] as const;

function pad(value: number, width = 4): string {
	return String(value).padStart(width, '0');
}

function syntheticTitle(index: number): string {
	const first = SYNTHETIC_TITLE_WORDS[index % SYNTHETIC_TITLE_WORDS.length];
	const second = SYNTHETIC_TITLE_WORDS[(index * 5 + 3) % SYNTHETIC_TITLE_WORDS.length];
	return `${first} ${second} ${pad(index + 1)}`;
}

function releaseEvidence(index: number): Pick<SyntheticAlbum, 'originalReleaseYear' | 'editionReleaseYear'> {
	const originalReleaseYear = index % 9 === 4 ? null : 1956 + ((index * 7) % 69);
	const editionReleaseYear =
		originalReleaseYear === null
			? 2001 + (index % 24)
			: index % 6 === 0
				? Math.min(2026, originalReleaseYear + 12)
				: originalReleaseYear;

	return { originalReleaseYear, editionReleaseYear };
}

function createAlbum(index: number, artistId: string, prefix: string): SyntheticAlbum {
	return {
		id: `${prefix}-album-${pad(index + 1, 5)}`,
		artistId,
		title: syntheticTitle(index),
		ordinal: index,
		...releaseEvidence(index),
		artworkIndex: index % 12
	};
}

export function createSyntheticCatalog(): SyntheticCatalog {
	const albumCounts = new Array<number>(SYNTHETIC_ARTIST_COUNT).fill(0);
	const albums = Array.from({ length: SYNTHETIC_ALBUM_COUNT }, (_, index) => {
		const artistIndex = index % SYNTHETIC_ARTIST_COUNT;
		albumCounts[artistIndex] += 1;
		return createAlbum(index, `synthetic-catalog-artist-${pad(artistIndex + 1)}`, 'synthetic-catalog');
	});
	const artists = Array.from({ length: SYNTHETIC_ARTIST_COUNT }, (_, index): SyntheticArtist => ({
		id: `synthetic-catalog-artist-${pad(index + 1)}`,
		name: `Synthetic Artist ${pad(index + 1)}`,
		albumCount: albumCounts[index]
	}));

	return {
		artists,
		albums,
		counts: { artists: artists.length, albums: albums.length }
	};
}

function createScenarioAlbums(name: ScenarioName, count: number): SyntheticAlbum[] {
	const artistId = `synthetic-scenario-${name}-artist`;
	return Array.from({ length: count }, (_, index) => createAlbum(index, artistId, `synthetic-${name}`));
}

function createScenarioBranches(name: ScenarioName, albums: SyntheticAlbum[]): SyntheticBranch[] {
	if (name === 'small' || albums.length === 0) return [];

	const branchCount = name === 'medium' ? 1 : 3;
	const labels = ['More by this synthetic artist', 'Artist search fixture', 'Date-neighbor fixture'] as const;
	return Array.from({ length: branchCount }, (_, branchIndex): SyntheticBranch => {
		const id = `synthetic-${name}-branch-${branchIndex + 1}`;
		const depth: 1 | 2 = branchIndex === 2 ? 2 : 1;
		const sourceAlbum = albums[(branchIndex * 7) % albums.length];
		const candidates = Array.from({ length: 8 }, (_, candidateIndex) => {
			const evidenceIndex = albums.length + branchIndex * 8 + candidateIndex;
			return {
				...createAlbum(
					evidenceIndex,
					`synthetic-branch-artist-${branchIndex + 1}`,
					`${id}-candidate`
				),
				branchId: id,
				depth,
				provenance: labels[branchIndex]
			};
		});
		return {
			id,
			label: labels[branchIndex],
			depth,
			sourceAlbumId: sourceAlbum.id,
			candidates
		};
	});
}

export function createScenario(name: ScenarioName): SyntheticScenario {
	const definition = SCENARIOS[name];
	const albums = createScenarioAlbums(name, definition.discographySize);
	const artist: SyntheticArtist = {
		id: `synthetic-scenario-${name}-artist`,
		name: `Synthetic ${definition.label}`,
		albumCount: albums.length
	};

	return {
		...definition,
		artist,
		albums,
		branches: createScenarioBranches(name, albums)
	};
}

export function createPagingStressFixture(pageSize = 500): SyntheticPagingStressFixture {
	if (!Number.isInteger(pageSize) || pageSize <= 0) {
		throw new RangeError('pageSize must be a positive integer');
	}
	const albums = createScenarioAlbums('stress', PAGING_STRESS_ALBUM_COUNT);
	const pages: SyntheticAlbum[][] = [];
	for (let start = 0; start < albums.length; start += pageSize) {
		pages.push(albums.slice(start, start + pageSize));
	}
	return { albums, pages, pageSize, total: albums.length };
}

export function chronologyLabel(album: Pick<SyntheticAlbum, 'originalReleaseYear'>): string {
	return album.originalReleaseYear === null ? 'Undated' : String(album.originalReleaseYear);
}
