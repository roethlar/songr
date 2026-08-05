export type ScenarioName = 'small' | 'medium' | 'large' | 'stress';

export interface SyntheticArtist {
	id: string;
	name: string;
	albumCount: number;
}

export interface SyntheticAlbum {
	id: string;
	artistId: string;
	title: string;
	ordinal: number;
	originalReleaseYear: number | null;
	editionReleaseYear: number | null;
	artworkIndex: number | null;
}

export interface SyntheticBranchCandidate extends SyntheticAlbum {
	branchId: string;
	depth: 1 | 2;
	provenance: string;
}

export interface SyntheticBranch {
	id: string;
	label: string;
	depth: 1 | 2;
	sourceAlbumId: string;
	candidates: SyntheticBranchCandidate[];
}

export interface SyntheticScenarioDefinition {
	id: ScenarioName;
	label: string;
	discographySize: number;
	description: string;
}

export interface SyntheticScenario extends SyntheticScenarioDefinition {
	artist: SyntheticArtist;
	albums: SyntheticAlbum[];
	branches: SyntheticBranch[];
}

export interface SyntheticCatalog {
	artists: SyntheticArtist[];
	albums: SyntheticAlbum[];
	counts: {
		artists: number;
		albums: number;
	};
}

export interface SyntheticPagingStressFixture {
	albums: SyntheticAlbum[];
	pages: SyntheticAlbum[][];
	pageSize: number;
	total: number;
}
