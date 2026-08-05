import type { Camera, Point, Rect, ScreenViewport, SemanticZoomTier } from './types';

export const MIN_CAMERA_SCALE = 0.5;
export const MAX_CAMERA_SCALE = 2.25;
export const SEMANTIC_ZOOM_HYSTERESIS = 0.08;

const OVERVIEW_TO_NAVIGATION = 0.76;
const NAVIGATION_TO_DETAIL = 1.45;

function requireFinite(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
	return value;
}

export function assertRect(rect: Rect, label = 'rectangle'): void {
	requireFinite(rect.x, `${label} x`);
	requireFinite(rect.y, `${label} y`);
	requireFinite(rect.width, `${label} width`);
	requireFinite(rect.height, `${label} height`);
	if (rect.width < 0 || rect.height < 0) {
		throw new RangeError(`${label} dimensions must not be negative`);
	}
	if (!Number.isFinite(rect.x + rect.width) || !Number.isFinite(rect.y + rect.height)) {
		throw new RangeError(`${label} extent must be finite`);
	}
}

function assertViewport(viewport: ScreenViewport): void {
	assertRect(viewport, 'viewport');
	if (viewport.width <= 0 || viewport.height <= 0) {
		throw new RangeError('viewport dimensions must be positive');
	}
}

function assertCamera(camera: Camera): void {
	requireFinite(camera.centerX, 'camera centerX');
	requireFinite(camera.centerY, 'camera centerY');
	requireFinite(camera.scale, 'camera scale');
	if (camera.scale <= 0) throw new RangeError('camera scale must be positive');
}

function assertPoint(point: Point): void {
	requireFinite(point.x, 'point x');
	requireFinite(point.y, 'point y');
}

function viewportCenter(viewport: ScreenViewport): Point {
	return {
		x: requireFinite(viewport.x + viewport.width / 2, 'viewport center x'),
		y: requireFinite(viewport.y + viewport.height / 2, 'viewport center y')
	};
}

function resultPoint(x: number, y: number, label: string): Point {
	return {
		x: requireFinite(x, `${label} x`),
		y: requireFinite(y, `${label} y`)
	};
}

export function clampCameraScale(scale: number): number {
	requireFinite(scale, 'camera scale');
	return Math.min(MAX_CAMERA_SCALE, Math.max(MIN_CAMERA_SCALE, scale));
}

export function worldToScreen(
	point: Point,
	camera: Camera,
	viewport: ScreenViewport
): Point {
	assertPoint(point);
	assertCamera(camera);
	assertViewport(viewport);
	const center = viewportCenter(viewport);
	const deltaX = requireFinite(point.x - camera.centerX, 'world-to-screen delta x');
	const deltaY = requireFinite(point.y - camera.centerY, 'world-to-screen delta y');
	return resultPoint(
		center.x + requireFinite(deltaX * camera.scale, 'world-to-screen scaled x'),
		center.y + requireFinite(deltaY * camera.scale, 'world-to-screen scaled y'),
		'world-to-screen result'
	);
}

export function screenToWorld(
	point: Point,
	camera: Camera,
	viewport: ScreenViewport
): Point {
	assertPoint(point);
	assertCamera(camera);
	assertViewport(viewport);
	const center = viewportCenter(viewport);
	const deltaX = requireFinite(point.x - center.x, 'screen-to-world delta x');
	const deltaY = requireFinite(point.y - center.y, 'screen-to-world delta y');
	return resultPoint(
		camera.centerX + requireFinite(deltaX / camera.scale, 'screen-to-world scaled x'),
		camera.centerY + requireFinite(deltaY / camera.scale, 'screen-to-world scaled y'),
		'screen-to-world result'
	);
}

export function zoomCameraAtPoint(
	camera: Camera,
	nextScale: number,
	pointer: Point,
	viewport: ScreenViewport
): Camera {
	const preservedWorldPoint = screenToWorld(pointer, camera, viewport);
	const scale = clampCameraScale(nextScale);
	const center = viewportCenter(viewport);
	const pointerDeltaX = requireFinite(pointer.x - center.x, 'zoom pointer delta x');
	const pointerDeltaY = requireFinite(pointer.y - center.y, 'zoom pointer delta y');
	return {
		centerX: requireFinite(
			preservedWorldPoint.x - pointerDeltaX / scale,
			'zoom camera centerX'
		),
		centerY: requireFinite(
			preservedWorldPoint.y - pointerDeltaY / scale,
			'zoom camera centerY'
		),
		scale
	};
}

export interface FitCameraOptions {
	padding?: number;
	minScale?: number;
	maxScale?: number;
}

export function fitCamera(
	bounds: Rect,
	viewport: ScreenViewport,
	options: FitCameraOptions = {}
): Camera {
	assertRect(bounds, 'content bounds');
	assertViewport(viewport);
	const padding = requireFinite(options.padding ?? 64, 'fit padding');
	if (padding < 0) throw new RangeError('fit padding must not be negative');
	const minScale = clampCameraScale(options.minScale ?? MIN_CAMERA_SCALE);
	const maxScale = clampCameraScale(options.maxScale ?? MAX_CAMERA_SCALE);
	if (minScale > maxScale) throw new RangeError('fit minScale must not exceed maxScale');

	const doubledPadding = requireFinite(padding * 2, 'fit doubled padding');
	const availableWidth = Math.max(
		1,
		requireFinite(viewport.width - doubledPadding, 'fit available width')
	);
	const availableHeight = Math.max(
		1,
		requireFinite(viewport.height - doubledPadding, 'fit available height')
	);
	const contentWidth = Math.max(1, bounds.width);
	const contentHeight = Math.max(1, bounds.height);
	const scale = Math.min(
		maxScale,
		Math.max(minScale, Math.min(availableWidth / contentWidth, availableHeight / contentHeight))
	);
	return {
		centerX: requireFinite(bounds.x + bounds.width / 2, 'fit centerX'),
		centerY: requireFinite(bounds.y + bounds.height / 2, 'fit centerY'),
		scale
	};
}

export function cameraCssTransform(camera: Camera, viewport: ScreenViewport): string {
	assertCamera(camera);
	assertViewport(viewport);
	const center = viewportCenter(viewport);
	const translateX = requireFinite(
		center.x - requireFinite(camera.centerX * camera.scale, 'camera transform scaled x'),
		'camera transform translate x'
	);
	const translateY = requireFinite(
		center.y - requireFinite(camera.centerY * camera.scale, 'camera transform scaled y'),
		'camera transform translate y'
	);
	return `translate3d(${translateX}px, ${translateY}px, 0) scale(${camera.scale})`;
}

export function inverseViewportBounds(
	camera: Camera,
	viewport: ScreenViewport,
	overscanViewportFraction = 0
): Rect {
	assertCamera(camera);
	assertViewport(viewport);
	const overscan = requireFinite(overscanViewportFraction, 'overscan fraction');
	if (overscan < 0) throw new RangeError('overscan fraction must not be negative');
	const extraX = requireFinite(viewport.width * overscan, 'overscan x');
	const extraY = requireFinite(viewport.height * overscan, 'overscan y');
	const topLeft = screenToWorld(
		resultPoint(viewport.x - extraX, viewport.y - extraY, 'overscan top-left'),
		camera,
		viewport
	);
	const bottomRight = screenToWorld(
		resultPoint(
			viewport.x + viewport.width + extraX,
			viewport.y + viewport.height + extraY,
			'overscan bottom-right'
		),
		camera,
		viewport
	);
	return {
		x: topLeft.x,
		y: topLeft.y,
		width: requireFinite(bottomRight.x - topLeft.x, 'inverse viewport width'),
		height: requireFinite(bottomRight.y - topLeft.y, 'inverse viewport height')
	};
}

export function semanticZoomTier(
	scale: number,
	previous?: SemanticZoomTier
): SemanticZoomTier {
	const normalized = clampCameraScale(scale);
	if (
		previous === 'overview' &&
		normalized < OVERVIEW_TO_NAVIGATION + SEMANTIC_ZOOM_HYSTERESIS
	) {
		return 'overview';
	}
	if (
		previous === 'navigation' &&
		normalized < OVERVIEW_TO_NAVIGATION - SEMANTIC_ZOOM_HYSTERESIS
	) {
		return 'overview';
	}
	if (
		previous === 'navigation' &&
		normalized < NAVIGATION_TO_DETAIL + SEMANTIC_ZOOM_HYSTERESIS
	) {
		return 'navigation';
	}
	if (
		previous === 'detail' &&
		normalized >= NAVIGATION_TO_DETAIL - SEMANTIC_ZOOM_HYSTERESIS
	) {
		return 'detail';
	}
	if (normalized < OVERVIEW_TO_NAVIGATION) return 'overview';
	if (normalized < NAVIGATION_TO_DETAIL) return 'navigation';
	return 'detail';
}

function containsRect(container: Rect, candidate: Rect): boolean {
	return (
		candidate.x >= container.x &&
		candidate.y >= container.y &&
		candidate.x + candidate.width <= container.x + container.width &&
		candidate.y + candidate.height <= container.y + container.height
	);
}

export interface CameraQueryWindow {
	tier: SemanticZoomTier;
	queryBounds: Rect;
	innerBounds: Rect;
}

export function createCameraQueryWindow(
	camera: Camera,
	viewport: ScreenViewport,
	previousTier?: SemanticZoomTier
): CameraQueryWindow {
	return {
		tier: semanticZoomTier(camera.scale, previousTier),
		queryBounds: inverseViewportBounds(camera, viewport, 0.5),
		innerBounds: inverseViewportBounds(camera, viewport, 0.25)
	};
}

export function shouldRefreshCameraQuery(
	window: CameraQueryWindow,
	camera: Camera,
	viewport: ScreenViewport
): boolean {
	if (semanticZoomTier(camera.scale, window.tier) !== window.tier) return true;
	return !containsRect(window.innerBounds, inverseViewportBounds(camera, viewport));
}
