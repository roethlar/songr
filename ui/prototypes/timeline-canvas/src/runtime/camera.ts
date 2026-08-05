import type { Camera, Point, Rect, ScreenViewport, SemanticZoomTier } from './types';

export const MIN_CAMERA_SCALE = 0.5;
export const MAX_CAMERA_SCALE = 2.25;
export const SEMANTIC_ZOOM_HYSTERESIS = 0.08;

const OVERVIEW_TO_NAVIGATION = 0.76;
const NAVIGATION_TO_DETAIL = 1.45;

export function clampScale(scale: number): number {
	if (!Number.isFinite(scale)) throw new TypeError('camera scale must be finite');
	return Math.min(MAX_CAMERA_SCALE, Math.max(MIN_CAMERA_SCALE, scale));
}

function viewportCenter(viewport: ScreenViewport): Point {
	return {
		x: viewport.x + viewport.width / 2,
		y: viewport.y + viewport.height / 2
	};
}

export function worldToScreen(point: Point, camera: Camera, viewport: ScreenViewport): Point {
	const center = viewportCenter(viewport);
	return {
		x: center.x + (point.x - camera.centerX) * camera.scale,
		y: center.y + (point.y - camera.centerY) * camera.scale
	};
}

export function screenToWorld(point: Point, camera: Camera, viewport: ScreenViewport): Point {
	const center = viewportCenter(viewport);
	return {
		x: camera.centerX + (point.x - center.x) / camera.scale,
		y: camera.centerY + (point.y - center.y) / camera.scale
	};
}

export function zoomAtPoint(
	camera: Camera,
	nextScale: number,
	pointer: Point,
	viewport: ScreenViewport
): Camera {
	const preservedWorldPoint = screenToWorld(pointer, camera, viewport);
	const scale = clampScale(nextScale);
	const center = viewportCenter(viewport);
	return {
		centerX: preservedWorldPoint.x - (pointer.x - center.x) / scale,
		centerY: preservedWorldPoint.y - (pointer.y - center.y) / scale,
		scale
	};
}

export interface FitCameraOptions {
	padding?: number;
	minScale?: number;
	maxScale?: number;
}

export function fitCamera(bounds: Rect, viewport: ScreenViewport, options: FitCameraOptions = {}): Camera {
	const padding = Math.max(0, options.padding ?? 64);
	const availableWidth = Math.max(1, viewport.width - padding * 2);
	const availableHeight = Math.max(1, viewport.height - padding * 2);
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);
	const minScale = options.minScale ?? MIN_CAMERA_SCALE;
	const maxScale = options.maxScale ?? MAX_CAMERA_SCALE;
	const scale = Math.min(maxScale, Math.max(minScale, Math.min(availableWidth / width, availableHeight / height)));
	return {
		centerX: bounds.x + bounds.width / 2,
		centerY: bounds.y + bounds.height / 2,
		scale
	};
}

export function inverseViewportBounds(
	camera: Camera,
	viewport: ScreenViewport,
	overscanViewportFraction = 0.5
): Rect {
	const extraX = viewport.width * Math.max(0, overscanViewportFraction);
	const extraY = viewport.height * Math.max(0, overscanViewportFraction);
	const topLeft = screenToWorld(
		{ x: viewport.x - extraX, y: viewport.y - extraY },
		camera,
		viewport
	);
	const bottomRight = screenToWorld(
		{ x: viewport.x + viewport.width + extraX, y: viewport.y + viewport.height + extraY },
		camera,
		viewport
	);
	return {
		x: topLeft.x,
		y: topLeft.y,
		width: bottomRight.x - topLeft.x,
		height: bottomRight.y - topLeft.y
	};
}

export function semanticZoomTier(scale: number, previous?: SemanticZoomTier): SemanticZoomTier {
	if (previous === 'overview' && scale < OVERVIEW_TO_NAVIGATION + SEMANTIC_ZOOM_HYSTERESIS) {
		return 'overview';
	}
	if (previous === 'navigation' && scale < OVERVIEW_TO_NAVIGATION - SEMANTIC_ZOOM_HYSTERESIS) {
		return 'overview';
	}
	if (previous === 'navigation' && scale < NAVIGATION_TO_DETAIL + SEMANTIC_ZOOM_HYSTERESIS) {
		return 'navigation';
	}
	if (previous === 'detail' && scale >= NAVIGATION_TO_DETAIL - SEMANTIC_ZOOM_HYSTERESIS) {
		return 'detail';
	}
	if (scale < OVERVIEW_TO_NAVIGATION) return 'overview';
	if (scale < NAVIGATION_TO_DETAIL) return 'navigation';
	return 'detail';
}
