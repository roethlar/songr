import {
	SYNTHETIC_ALBUM_COUNT,
	SYNTHETIC_ARTIST_COUNT,
	createScenario,
	type ScenarioName,
	type SyntheticScenario
} from '../fixtures';
import { boundBranches } from './branches';
import { contentBounds, entityBounds, layoutWorkspaceEntities } from './layout';
import { SPATIAL_INDEX_CELL_SIZE, UniformGridSpatialIndex } from './spatial-index';
import type { Rect, WorkspaceEntity, ZoneTarget } from './types';
import { createSyntheticZones } from './zones';

export interface IndexedWorkspaceEntity {
	id: string;
	bounds: Rect;
	entity: WorkspaceEntity;
}

export interface TimelineWorkspace {
	scenario: SyntheticScenario;
	entities: readonly WorkspaceEntity[];
	entityById: ReadonlyMap<string, WorkspaceEntity>;
	index: UniformGridSpatialIndex<IndexedWorkspaceEntity>;
	bounds: Rect;
	zones: readonly ZoneTarget[];
	logicalCatalogCounts: {
		artists: number;
		albums: number;
	};
}

export function createWorkspace(input: ScenarioName | SyntheticScenario): TimelineWorkspace {
	const sourceScenario = typeof input === 'string' ? createScenario(input) : input;
	const scenario: SyntheticScenario = {
		...sourceScenario,
		albums: [...sourceScenario.albums],
		branches: boundBranches(sourceScenario.branches)
	};
	const entities = layoutWorkspaceEntities(scenario.albums, scenario.branches);
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));
	const index = new UniformGridSpatialIndex<IndexedWorkspaceEntity>(SPATIAL_INDEX_CELL_SIZE);
	for (const entity of entities) {
		index.insert({ id: entity.id, bounds: entityBounds(entity), entity });
	}

	return {
		scenario,
		entities,
		entityById,
		index,
		bounds: contentBounds(entities),
		zones: createSyntheticZones(),
		logicalCatalogCounts: {
			artists: SYNTHETIC_ARTIST_COUNT,
			albums: SYNTHETIC_ALBUM_COUNT
		}
	};
}
