import { MAX_RENDERED_ARTWORK_IMAGES, MAX_RENDERED_WORLD_OBJECTS } from './render-planner';

export interface TimingSummary {
	count: number;
	min: number;
	max: number;
	mean: number;
	p50: number;
	p95: number;
}

export interface CapCounts {
	worldObjects: number;
	artworkImages: number;
	domNodes?: number;
}

export interface CapLimits {
	worldObjects: number;
	artworkImages: number;
	domNodes?: number;
}

export interface CapSnapshot {
	counts: CapCounts;
	limits: CapLimits;
	withinCaps: boolean;
	violations: readonly string[];
}

export function percentile(values: readonly number[], percentileValue: number): number {
	if (values.length === 0) return 0;
	if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 100) {
		throw new RangeError('percentile must be between 0 and 100');
	}
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.some((value) => !Number.isFinite(value))) throw new TypeError('timings must be finite');
	if (sorted.length === 1) return sorted[0];
	const position = (percentileValue / 100) * (sorted.length - 1);
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	const fraction = position - lower;
	return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

export function summarizeQueryTimings(values: readonly number[]): TimingSummary {
	if (values.length === 0) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0 };
	if (values.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new TypeError('query timings must be finite non-negative numbers');
	}
	const total = values.reduce((sum, value) => sum + value, 0);
	return {
		count: values.length,
		min: Math.min(...values),
		max: Math.max(...values),
		mean: total / values.length,
		p50: percentile(values, 50),
		p95: percentile(values, 95)
	};
}

export function createCapSnapshot(
	counts: CapCounts,
	limits: CapLimits = {
		worldObjects: MAX_RENDERED_WORLD_OBJECTS,
		artworkImages: MAX_RENDERED_ARTWORK_IMAGES
	}
): CapSnapshot {
	const violations: string[] = [];
	if (counts.worldObjects > limits.worldObjects) {
		violations.push(`world objects ${counts.worldObjects}/${limits.worldObjects}`);
	}
	if (counts.artworkImages > limits.artworkImages) {
		violations.push(`artwork images ${counts.artworkImages}/${limits.artworkImages}`);
	}
	if (
		counts.domNodes !== undefined &&
		limits.domNodes !== undefined &&
		counts.domNodes > limits.domNodes
	) {
		violations.push(`DOM nodes ${counts.domNodes}/${limits.domNodes}`);
	}
	return { counts: { ...counts }, limits: { ...limits }, withinCaps: violations.length === 0, violations };
}
