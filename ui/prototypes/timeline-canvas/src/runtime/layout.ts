import { chronologyLabel, type SyntheticAlbum, type SyntheticBranch } from '../fixtures';
import type { Rect, WorkspaceEntity } from './types';

export const MARKER_WIDTH = 132;
export const MARKER_HEIGHT = 112;
const YEAR_SPACING = 148;
const COLLISION_SPACING = 24;
const ALTERNATING_Y = 128;
const UNDATED_SPACING = 116;

interface LayoutAlbum extends SyntheticAlbum {
	kind: 'album' | 'branch-album';
	branchId: string | null;
	branchDepth: 0 | 1 | 2;
	branchLabel: string | null;
}

function compareAlbums(a: LayoutAlbum, b: LayoutAlbum): number {
	if (a.originalReleaseYear === null && b.originalReleaseYear !== null) return 1;
	if (a.originalReleaseYear !== null && b.originalReleaseYear === null) return -1;
	if (a.originalReleaseYear !== b.originalReleaseYear) {
		return (a.originalReleaseYear ?? 0) - (b.originalReleaseYear ?? 0);
	}
	return a.ordinal - b.ordinal || a.id.localeCompare(b.id);
}

function albumLayoutInput(albums: readonly SyntheticAlbum[], branches: readonly SyntheticBranch[]): LayoutAlbum[] {
	const base = albums.map(
		(album): LayoutAlbum => ({
			...album,
			kind: 'album',
			branchId: null,
			branchDepth: 0,
			branchLabel: null
		})
	);
	const branchAlbums = branches.flatMap((branch) =>
		branch.candidates.map(
			(candidate): LayoutAlbum => ({
				...candidate,
				kind: 'branch-album',
				branchId: branch.id,
				branchDepth: branch.depth,
				branchLabel: branch.label
			})
		)
	);
	return [...base, ...branchAlbums];
}

export function layoutWorkspaceEntities(
	albums: readonly SyntheticAlbum[],
	branches: readonly SyntheticBranch[]
): WorkspaceEntity[] {
	const inputs = albumLayoutInput(albums, branches);
	const baseInputs = inputs.filter((album) => album.kind === 'album').sort(compareAlbums);
	const knownYears = baseInputs
		.map((album) => album.originalReleaseYear)
		.filter((year): year is number => year !== null);
	const minYear = knownYears.length > 0 ? Math.min(...knownYears) : 0;
	const maxYear = knownYears.length > 0 ? Math.max(...knownYears) : minYear;
	const collisionByYear = new Map<number, number>();
	let undatedIndex = 0;
	let knownRightmostX = 0;
	const basePositions = new Map<string, { x: number; y: number }>();

	for (let index = 0; index < baseInputs.length; index += 1) {
		const album = baseInputs[index];
		if (album.originalReleaseYear === null) {
			const undatedStart = Math.max((maxYear - minYear + 2) * YEAR_SPACING, knownRightmostX + YEAR_SPACING);
			const x = undatedStart + undatedIndex * UNDATED_SPACING;
			const y = (undatedIndex % 2 === 0 ? -1 : 1) * ALTERNATING_Y;
			basePositions.set(album.id, { x, y });
			undatedIndex += 1;
			continue;
		}

		const collision = collisionByYear.get(album.originalReleaseYear) ?? 0;
		collisionByYear.set(album.originalReleaseYear, collision + 1);
		const side = collision % 2 === 0 ? -1 : 1;
		const stack = Math.floor(collision / 2);
		const x = (album.originalReleaseYear - minYear) * YEAR_SPACING + stack * COLLISION_SPACING;
		knownRightmostX = Math.max(knownRightmostX, x);
		basePositions.set(album.id, {
			x,
			y: side * (ALTERNATING_Y + stack * (MARKER_HEIGHT + 16))
		});
	}

	const branchIndexById = new Map(branches.map((branch, index) => [branch.id, index]));
	const sourceByBranch = new Map(branches.map((branch) => [branch.id, basePositions.get(branch.sourceAlbumId)]));
	const candidateIndexByBranch = new Map<string, number>();

	return inputs.sort(compareAlbums).map((album): WorkspaceEntity => {
		let position = basePositions.get(album.id);
		if (!position && album.branchId) {
			const branchIndex = branchIndexById.get(album.branchId) ?? 0;
			const candidateIndex = candidateIndexByBranch.get(album.branchId) ?? 0;
			candidateIndexByBranch.set(album.branchId, candidateIndex + 1);
			const source = sourceByBranch.get(album.branchId) ?? { x: 0, y: 0 };
			const direction = branchIndex % 2 === 0 ? 1 : -1;
			position = {
				x: source.x + (candidateIndex - 3.5) * 154,
				y: direction * (330 + branchIndex * 180)
			};
		}
		position ??= { x: 0, y: 0 };

		return {
			id: album.id,
			kind: album.kind,
			x: position.x,
			y: position.y,
			width: MARKER_WIDTH,
			height: MARKER_HEIGHT,
			title: album.title,
			subtitle: album.branchLabel ?? chronologyLabel(album),
			year: album.originalReleaseYear,
			artworkIndex: album.artworkIndex,
			ordinal: album.ordinal,
			branchId: album.branchId,
			branchDepth: album.branchDepth
		};
	});
}

export function entityBounds(entity: WorkspaceEntity): Rect {
	return {
		x: entity.x - entity.width / 2,
		y: entity.y - entity.height / 2,
		width: entity.width,
		height: entity.height
	};
}

export function contentBounds(entities: readonly WorkspaceEntity[]): Rect {
	if (entities.length === 0) return { x: -1, y: -1, width: 2, height: 2 };
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const entity of entities) {
		const bounds = entityBounds(entity);
		minX = Math.min(minX, bounds.x);
		minY = Math.min(minY, bounds.y);
		maxX = Math.max(maxX, bounds.x + bounds.width);
		maxY = Math.max(maxY, bounds.y + bounds.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
