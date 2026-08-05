import { assertRect } from './geometry';
import type { Rect } from './types';

export const TIMELINE_SPATIAL_CELL_SIZE = 512;
const MAX_CELLS_PER_ITEM = 256;
const MAX_BUCKETS_PER_QUERY = 16_384;

export interface SpatialItem {
	readonly id: string;
	readonly bounds: Rect;
}

interface CellRange {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	count: number;
}

interface StoredSpatialItem<T extends SpatialItem> {
	item: T;
	bounds: Readonly<Rect>;
	cellKeys: readonly string[];
}

function requireId(id: string): void {
	if (typeof id !== 'string' || id.length === 0) {
		throw new TypeError('spatial item id must be non-empty');
	}
}

function cellRange(bounds: Rect, cellSize: number): CellRange {
	assertRect(bounds, 'spatial bounds');
	const minX = Math.floor(bounds.x / cellSize);
	const maxX = Math.floor((bounds.x + bounds.width) / cellSize);
	const minY = Math.floor(bounds.y / cellSize);
	const maxY = Math.floor((bounds.y + bounds.height) / cellSize);
	if (![minX, maxX, minY, maxY].every(Number.isSafeInteger)) {
		throw new RangeError('spatial cell coordinates must be safe integers');
	}
	const columns = maxX - minX + 1;
	const rows = maxY - minY + 1;
	const count = columns * rows;
	if (!Number.isSafeInteger(count) || count < 1) {
		throw new RangeError('spatial cell coverage is invalid');
	}
	return { minX, maxX, minY, maxY, count };
}

function cellKeys(range: CellRange): string[] {
	const keys: string[] = [];
	for (let x = range.minX; x <= range.maxX; x += 1) {
		for (let y = range.minY; y <= range.maxY; y += 1) keys.push(`${x}:${y}`);
	}
	return keys;
}

function intersects(left: Rect, right: Rect): boolean {
	return (
		left.x <= right.x + right.width &&
		left.x + left.width >= right.x &&
		left.y <= right.y + right.height &&
		left.y + left.height >= right.y
	);
}

function compareIds(left: SpatialItem, right: SpatialItem): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export class UniformGridSpatialIndex<T extends SpatialItem> {
	readonly cellSize: number;
	readonly #items = new Map<string, StoredSpatialItem<T>>();
	readonly #buckets = new Map<string, Set<string>>();

	constructor(cellSize = TIMELINE_SPATIAL_CELL_SIZE) {
		if (!Number.isFinite(cellSize) || cellSize <= 0) {
			throw new RangeError('spatial cellSize must be positive and finite');
		}
		this.cellSize = cellSize;
	}

	get size(): number {
		return this.#items.size;
	}

	insert(item: T): void {
		requireId(item.id);
		const bounds = Object.freeze({ ...item.bounds });
		const range = cellRange(bounds, this.cellSize);
		if (range.count > MAX_CELLS_PER_ITEM) {
			throw new RangeError(`spatial item may cover at most ${MAX_CELLS_PER_ITEM} cells`);
		}
		const keys = Object.freeze(cellKeys(range));
		const snapshot = Object.freeze({ ...item, bounds }) as T;

		this.remove(item.id);
		this.#items.set(item.id, { item: snapshot, bounds, cellKeys: keys });
		for (const key of keys) {
			let bucket = this.#buckets.get(key);
			if (!bucket) {
				bucket = new Set<string>();
				this.#buckets.set(key, bucket);
			}
			bucket.add(item.id);
		}
	}

	remove(id: string): boolean {
		const stored = this.#items.get(id);
		if (!stored) return false;
		for (const key of stored.cellKeys) {
			const bucket = this.#buckets.get(key);
			bucket?.delete(id);
			if (bucket?.size === 0) this.#buckets.delete(key);
		}
		return this.#items.delete(id);
	}

	get(id: string): T | undefined {
		return this.#items.get(id)?.item;
	}

	query(bounds: Rect): T[] {
		const range = cellRange(bounds, this.cellSize);
		let candidates: Iterable<StoredSpatialItem<T>>;
		if (range.count > MAX_BUCKETS_PER_QUERY) {
			// A malformed or very large viewport must never create a multi-million
			// cell loop. The model itself is bounded, so a linear fallback is safer.
			candidates = this.#items.values();
		} else {
			const ids = new Set<string>();
			for (const key of cellKeys(range)) {
				for (const id of this.#buckets.get(key) ?? []) ids.add(id);
			}
			candidates = [...ids]
				.map((id) => this.#items.get(id))
				.filter((item): item is StoredSpatialItem<T> => item !== undefined);
		}

		return [...candidates]
			.filter((stored) => intersects(stored.bounds, bounds))
			.map((stored) => stored.item)
			.sort(compareIds);
	}

	clear(): void {
		this.#items.clear();
		this.#buckets.clear();
	}
}
