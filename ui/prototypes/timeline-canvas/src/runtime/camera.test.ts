import { describe, expect, it } from 'vitest';
import {
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	fitCamera,
	screenToWorld,
	semanticZoomTier,
	worldToScreen,
	zoomAtPoint
} from './index';
import type { Camera, Point, ScreenViewport } from './types';

const viewport: ScreenViewport = { x: 35, y: 20, width: 1_400, height: 900 };

function expectPointClose(actual: Point, expected: Point): void {
	expect(actual.x).toBeCloseTo(expected.x, 10);
	expect(actual.y).toBeCloseTo(expected.y, 10);
}

describe('camera geometry', () => {
	it('round-trips world and screen points through the inverse transform', () => {
		const camera: Camera = { centerX: -823.25, centerY: 149.5, scale: 1.73 };
		for (const point of [
			{ x: 0, y: 0 },
			{ x: -3_400.5, y: 912.75 },
			{ x: 18_000, y: -7_250 }
		]) {
			expectPointClose(screenToWorld(worldToScreen(point, camera, viewport), camera, viewport), point);
		}
	});

	it('keeps the pointed world coordinate fixed while zooming', () => {
		const camera: Camera = { centerX: 220, centerY: -80, scale: 0.9 };
		const pointer = { x: 1_112, y: 267 };
		const before = screenToWorld(pointer, camera, viewport);
		const zoomed = zoomAtPoint(camera, 1.8, pointer, viewport);

		expectPointClose(screenToWorld(pointer, zoomed, viewport), before);
		expect(zoomed.scale).toBe(1.8);
		expect(zoomAtPoint(camera, 99, pointer, viewport).scale).toBe(MAX_CAMERA_SCALE);
		expect(zoomAtPoint(camera, 0.01, pointer, viewport).scale).toBe(MIN_CAMERA_SCALE);
	});

	it('fits content and applies stable semantic-tier hysteresis', () => {
		const fitted = fitCamera({ x: 100, y: -200, width: 1_000, height: 400 }, viewport, { padding: 100 });

		expect(fitted.centerX).toBe(600);
		expect(fitted.centerY).toBe(0);
		expect(fitted.scale).toBeGreaterThanOrEqual(MIN_CAMERA_SCALE);
		expect(fitted.scale).toBeLessThanOrEqual(MAX_CAMERA_SCALE);
		expect(semanticZoomTier(0.5)).toBe('overview');
		expect(semanticZoomTier(0.8)).toBe('navigation');
		expect(semanticZoomTier(1.8)).toBe('detail');
		expect(semanticZoomTier(0.8, 'overview')).toBe('overview');
		expect(semanticZoomTier(1.4, 'detail')).toBe('detail');
	});
});
