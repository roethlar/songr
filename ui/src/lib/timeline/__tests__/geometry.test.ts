import { describe, expect, it } from 'vitest';
import {
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	cameraCssTransform,
	createCameraQueryWindow,
	fitCamera,
	inverseViewportBounds,
	screenToWorld,
	semanticZoomTier,
	shouldRefreshCameraQuery,
	worldToScreen,
	zoomCameraAtPoint
} from '../geometry';
import type { Camera, Point, ScreenViewport } from '../types';

const viewport: ScreenViewport = { x: 35, y: 20, width: 1_400, height: 900 };

function expectPoint(actual: Point, expected: Point): void {
	expect(actual.x).toBeCloseTo(expected.x, 10);
	expect(actual.y).toBeCloseTo(expected.y, 10);
}

describe('Timeline camera geometry', () => {
	it('round-trips world and screen coordinates through the documented transform', () => {
		const camera: Camera = { centerX: -823.25, centerY: 149.5, scale: 1.73 };
		for (const point of [
			{ x: 0, y: 0 },
			{ x: -3_400.5, y: 912.75 },
			{ x: 18_000, y: -7_250 }
		]) {
			expectPoint(screenToWorld(worldToScreen(point, camera, viewport), camera, viewport), point);
		}
	});

	it('keeps the pointed world coordinate fixed and clamps zoom', () => {
		const camera: Camera = { centerX: 220, centerY: -80, scale: 0.9 };
		const pointer = { x: 1_112, y: 267 };
		const before = screenToWorld(pointer, camera, viewport);
		const zoomed = zoomCameraAtPoint(camera, 1.8, pointer, viewport);

		expectPoint(screenToWorld(pointer, zoomed, viewport), before);
		expect(zoomed.scale).toBe(1.8);
		expect(zoomCameraAtPoint(camera, 99, pointer, viewport).scale).toBe(MAX_CAMERA_SCALE);
		expect(zoomCameraAtPoint(camera, 0.01, pointer, viewport).scale).toBe(MIN_CAMERA_SCALE);
	});

	it('fits bounded content and emits one world transform', () => {
		const fitted = fitCamera(
			{ x: 100, y: -200, width: 1_000, height: 400 },
			viewport,
			{ padding: 100 }
		);
		expect(fitted).toMatchObject({ centerX: 600, centerY: 0 });
		expect(fitted.scale).toBeGreaterThanOrEqual(MIN_CAMERA_SCALE);
		expect(fitted.scale).toBeLessThanOrEqual(MAX_CAMERA_SCALE);
		expect(
			cameraCssTransform({ centerX: 100, centerY: -20, scale: 2 }, { x: 0, y: 0, width: 800, height: 600 })
		).toBe('translate3d(200px, 340px, 0) scale(2)');
	});

	it('uses stable semantic tiers with hysteresis', () => {
		expect(semanticZoomTier(0.5)).toBe('overview');
		expect(semanticZoomTier(0.8)).toBe('navigation');
		expect(semanticZoomTier(1.8)).toBe('detail');
		expect(semanticZoomTier(0.8, 'overview')).toBe('overview');
		expect(semanticZoomTier(1.4, 'detail')).toBe('detail');
	});

	it('retains a query window until its inner overscan or tier is crossed', () => {
		const camera: Camera = { centerX: 0, centerY: 0, scale: 1 };
		const window = createCameraQueryWindow(camera, viewport);
		expect(shouldRefreshCameraQuery(window, camera, viewport)).toBe(false);
		expect(
			shouldRefreshCameraQuery(window, { ...camera, centerX: 100 }, viewport)
		).toBe(false);
		expect(
			shouldRefreshCameraQuery(window, { ...camera, centerX: 500 }, viewport)
		).toBe(true);
		expect(
			shouldRefreshCameraQuery(window, { ...camera, scale: 1.8 }, viewport)
		).toBe(true);
	});

	it('rejects non-finite and impossible geometry', () => {
		expect(() => fitCamera({ x: 0, y: 0, width: -1, height: 2 }, viewport)).toThrow(
			/dimensions/
		);
		expect(() =>
			fitCamera({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 })
		).toThrow(/positive/);
		expect(() =>
			worldToScreen({ x: Number.NaN, y: 0 }, { centerX: 0, centerY: 0, scale: 1 }, viewport)
		).toThrow(/finite/);
	});

	it('rejects finite operands when camera arithmetic would overflow', () => {
		const extreme = Number.MAX_VALUE;
		expect(() =>
			worldToScreen(
				{ x: extreme, y: 0 },
				{ centerX: -extreme, centerY: 0, scale: 1 },
				viewport
			)
		).toThrow(/finite/);
		expect(() =>
			screenToWorld(
				{ x: extreme, y: 0 },
				{ centerX: extreme, centerY: 0, scale: 0.5 },
				viewport
			)
		).toThrow(/finite/);
		expect(() =>
			zoomCameraAtPoint(
				{ centerX: extreme, centerY: 0, scale: 1 },
				0.5,
				{ x: extreme, y: 0 },
				viewport
			)
		).toThrow(/finite/);
		expect(() =>
			cameraCssTransform(
				{ centerX: extreme, centerY: 0, scale: 2 },
				viewport
			)
		).toThrow(/finite/);
		expect(() =>
			inverseViewportBounds(
				{ centerX: 0, centerY: 0, scale: 1 },
				viewport,
				extreme
			)
		).toThrow(/finite/);
		expect(() =>
			fitCamera({ x: 0, y: 0, width: 1, height: 1 }, viewport, { padding: extreme })
		).toThrow(/finite/);
	});
});
