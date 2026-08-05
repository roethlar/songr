import type { Rect } from './types';

export const SPATIAL_INDEX_CELL_SIZE = 512;

export interface SpatialItem {
	id: string;
	bounds: Rect;
}

function intersects(a: Rect, b: Rect): boolean {
	return (
		a.x <= b.x + b.width &&
		a.x + a.width >= b.x &&
		a.y <= b.y + b.height &&
		a.y + a.height >= b.y
	);
}

function coveredCells(bounds: Rect, cellSize: number): string[] {
	const minX = Math.floor(bounds.x / cellSize);
	const maxX = Math.floor((bounds.x + Math.max(0, bounds.width)) / cellSize);
	const minY = Math.floor(bounds.y / cellSize);
	const maxY = Math.floor((bounds.y + Math.max(0, bounds.height)) / cellSize);
	const keys: string[] = [];
	for (let x = minX; x <= maxX; x += 1) {
		for (let y = minY; y <= maxY; y += 1) keys.push(`${x}:${y}`);
	}
	return keys;
}

export class UniformGridSpatialIndex<T extends SpatialItem> {
	readonly cellSize: number;
	readonly #items = new Map<string, T>();
	readonly #buckets = new Map<string, Set<string>>();

	constructor(cellSize = SPATIAL_INDEX_CELL_SIZE) {
		if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError('cellSize must be positive');
		this.cellSize = cellSize;
	}

	get size(): number {
		return this.#items.size;
	}

	insert(item: T): void {
		if (this.#items.has(item.id)) this.remove(item.id);
		this.#items.set(item.id, item);
		for (const key of coveredCells(item.bounds, this.cellSize)) {
			let bucket = this.#buckets.get(key);
			if (!bucket) {
				bucket = new Set<string>();
				this.#buckets.set(key, bucket);
			}
			bucket.add(item.id);
		}
	}

	remove(id: string): boolean {
		const item = this.#items.get(id);
		if (!item) return false;
		for (const key of coveredCells(item.bounds, this.cellSize)) {
			const bucket = this.#buckets.get(key);
			bucket?.delete(id);
			if (bucket?.size === 0) this.#buckets.delete(key);
		}
		return this.#items.delete(id);
	}

	get(id: string): T | undefined {
		return this.#items.get(id);
	}

	query(bounds: Rect): T[] {
		const candidateIds = new Set<string>();
		for (const key of coveredCells(bounds, this.cellSize)) {
			for (const id of this.#buckets.get(key) ?? []) candidateIds.add(id);
		}
		return [...candidateIds]
			.map((id) => this.#items.get(id))
			.filter((item): item is T => item !== undefined && intersects(item.bounds, bounds))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	clear(): void {
		this.#items.clear();
		this.#buckets.clear();
	}
}

export function bruteForceSpatialQuery<T extends SpatialItem>(items: readonly T[], bounds: Rect): T[] {
	return items.filter((item) => intersects(item.bounds, bounds)).sort((a, b) => a.id.localeCompare(b.id));
}
