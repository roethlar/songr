import { zoomCameraAtPoint } from './geometry';
import type { TimelineManualOffset } from './manualPlacement';
import type { Camera, ScreenViewport } from './types';

export const TIMELINE_POINTER_DRAG_THRESHOLD_PX = 6;
export const TIMELINE_WHEEL_IDLE_MS = 160;

const TIMELINE_WHEEL_ZOOM_SENSITIVITY = 0.002;
const TIMELINE_WHEEL_LINE_PX = 16;
const MAX_RETAINED_TERMINAL_GESTURES = 64;

export type TimelineGestureCancelReason =
	| 'pointercancel'
	| 'lostcapture'
	| 'escape'
	| 'dispose';

export type TimelineGestureTarget =
	| { readonly kind: 'background' }
	| {
			readonly kind: 'album';
			readonly albumLocalId: string;
			readonly preOffset: TimelineManualOffset | null;
	  };

export interface TimelinePointerDownInput {
	readonly pointerId: number;
	readonly button: number;
	readonly clientX: number;
	readonly clientY: number;
	readonly target: TimelineGestureTarget;
	readonly spaceKey?: boolean;
}

export interface TimelinePointerInput {
	readonly pointerId: number;
	readonly gestureId: number;
	readonly clientX: number;
	readonly clientY: number;
}

export interface TimelinePointerIdentity {
	readonly pointerId: number;
	readonly gestureId: number;
}

export interface TimelineWheelInput {
	readonly clientX: number;
	readonly clientY: number;
	readonly deltaX: number;
	readonly deltaY: number;
	/** DOM WheelEvent deltaMode: pixels (0), lines (1), or pages (2). */
	readonly deltaMode?: 0 | 1 | 2;
	readonly ctrlKey?: boolean;
	readonly metaKey?: boolean;
}

export interface TimelinePointerCaptureRequest {
	readonly pointerId: number;
	readonly gestureId: number;
}

export interface TimelineAlbumDragPreview {
	readonly gestureId: number;
	readonly albumLocalId: string;
	readonly offset: TimelineManualOffset;
	readonly clientX: number;
	readonly clientY: number;
}

export interface TimelineAlbumDropTarget {
	/** Null means the pointer settled inside the fixed dock but no port was valid. */
	readonly zoneId: string | null;
}

export interface TimelineAlbumDropHitTest {
	readonly gestureId: number;
	readonly albumLocalId: string;
	readonly clientX: number;
	readonly clientY: number;
}

export interface TimelineAlbumDragCommit extends TimelineAlbumDragPreview {
	readonly dropTarget: TimelineAlbumDropTarget | null;
}

export interface TimelineAlbumDragCancel {
	readonly gestureId: number;
	readonly albumLocalId: string;
	readonly preOffset: TimelineManualOffset | null;
	readonly reason: TimelineGestureCancelReason;
}

export interface TimelineAlbumTap {
	readonly gestureId: number;
	readonly albumLocalId: string;
	readonly clientX: number;
	readonly clientY: number;
}

export interface TimelineCameraGesturePreview {
	readonly camera: Camera;
	readonly source: 'pointer' | 'wheel';
	readonly gestureId: number | null;
}

export interface TimelineCameraGestureCommit extends TimelineCameraGesturePreview {}

export interface TimelineCameraGestureCancel {
	readonly gestureId: number;
	readonly camera: Camera;
	readonly reason: TimelineGestureCancelReason;
}

export interface TimelineWheelIdle {
	readonly camera: Camera;
}

export interface TimelineGestureCallbacks {
	readonly capturePointer?: (request: TimelinePointerCaptureRequest) => void;
	readonly releasePointer?: (request: TimelinePointerCaptureRequest) => void;
	readonly previewAlbum?: (preview: TimelineAlbumDragPreview) => void;
	readonly resolveAlbumDropTarget?: (
		request: TimelineAlbumDropHitTest
	) => TimelineAlbumDropTarget | null;
	readonly commitAlbum?: (commit: TimelineAlbumDragCommit) => void;
	readonly cancelAlbum?: (cancel: TimelineAlbumDragCancel) => void;
	readonly tapAlbum?: (tap: TimelineAlbumTap) => void;
	readonly previewCamera?: (preview: TimelineCameraGesturePreview) => void;
	readonly commitCamera?: (commit: TimelineCameraGestureCommit) => void;
	readonly cancelCamera?: (cancel: TimelineCameraGestureCancel) => void;
	readonly wheelIdle?: (idle: TimelineWheelIdle) => void;
}

export interface TimelineGestureScheduler {
	readonly requestFrame: (callback: () => void) => number;
	readonly cancelFrame: (handle: number) => void;
	readonly setTimer: (callback: () => void, delayMs: number) => number;
	readonly clearTimer: (handle: number) => void;
}

export interface TimelineGestureControllerOptions {
	readonly getCamera: () => Camera;
	readonly getViewport: () => ScreenViewport;
	readonly callbacks?: TimelineGestureCallbacks;
	readonly scheduler?: TimelineGestureScheduler;
}

export type TimelinePointerDownResult =
	| {
			readonly accepted: true;
			readonly gestureId: number;
			readonly kind: 'album-armed' | 'pan';
	  }
	| {
			readonly accepted: false;
			readonly reason: 'busy' | 'disposed' | 'unsupported-button';
	  };

export interface TimelineActiveGestureIdentity extends TimelinePointerIdentity {
	readonly kind: 'album-armed' | 'album-drag' | 'pan';
}

interface ClientPoint {
	readonly x: number;
	readonly y: number;
}

interface ActiveGesture {
	readonly gestureId: number;
	readonly pointerId: number;
	readonly kind: 'album' | 'pan';
	readonly start: ClientPoint;
	latest: ClientPoint;
	readonly startScale: number;
	readonly pressedAlbumId: string | null;
	readonly primaryButton: boolean;
	readonly albumLocalId: string | null;
	readonly preOffset: TimelineManualOffset | null;
	readonly startCamera: Camera | null;
	dragStarted: boolean;
	hasMovement: boolean;
}

interface CompatibilityClickSuppression {
	readonly albumLocalId: string | null;
}

function browserScheduler(): TimelineGestureScheduler {
	return {
		requestFrame(callback) {
			if (typeof globalThis.requestAnimationFrame !== 'function') {
				throw new Error('requestAnimationFrame is unavailable');
			}
			return globalThis.requestAnimationFrame(callback);
		},
		cancelFrame(handle) {
			globalThis.cancelAnimationFrame?.(handle);
		},
		setTimer(callback, delayMs) {
			return globalThis.setTimeout(callback, delayMs) as unknown as number;
		},
		clearTimer(handle) {
			globalThis.clearTimeout(handle);
		}
	};
}

function requireFinite(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
	return value;
}

function requirePointerId(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function requireGestureId(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError('gestureId must be a positive safe integer');
	}
	return value;
}

function requirePoint(clientX: number, clientY: number): ClientPoint {
	return {
		x: requireFinite(clientX, 'clientX'),
		y: requireFinite(clientY, 'clientY')
	};
}

function requireOffset(offset: TimelineManualOffset | null): TimelineManualOffset | null {
	if (offset === null) return null;
	return Object.freeze({
		dx: requireFinite(offset.dx, 'preOffset dx'),
		dy: requireFinite(offset.dy, 'preOffset dy')
	});
}

function requireCamera(camera: Camera): Camera {
	const scale = requireFinite(camera.scale, 'camera scale');
	if (scale <= 0) throw new RangeError('camera scale must be positive');
	return Object.freeze({
		centerX: requireFinite(camera.centerX, 'camera centerX'),
		centerY: requireFinite(camera.centerY, 'camera centerY'),
		scale
	});
}

function copyOffset(offset: TimelineManualOffset | null): TimelineManualOffset {
	return Object.freeze({ dx: offset?.dx ?? 0, dy: offset?.dy ?? 0 });
}

function copyCamera(camera: Camera): Camera {
	return Object.freeze({
		centerX: camera.centerX,
		centerY: camera.centerY,
		scale: camera.scale
	});
}

function distanceFromStart(gesture: ActiveGesture): number {
	return Math.hypot(
		gesture.latest.x - gesture.start.x,
		gesture.latest.y - gesture.start.y
	);
}

function albumOffsetAt(gesture: ActiveGesture): TimelineManualOffset {
	const preOffset = copyOffset(gesture.preOffset);
	return Object.freeze({
		dx: requireFinite(
			preOffset.dx + (gesture.latest.x - gesture.start.x) / gesture.startScale,
			'album drag offset dx'
		),
		dy: requireFinite(
			preOffset.dy + (gesture.latest.y - gesture.start.y) / gesture.startScale,
			'album drag offset dy'
		)
	});
}

function cameraAt(gesture: ActiveGesture): Camera {
	const startCamera = gesture.startCamera;
	if (!startCamera) throw new Error('pan gesture is missing its start camera');
	return requireCamera({
		centerX: startCamera.centerX - (gesture.latest.x - gesture.start.x) / gesture.startScale,
		centerY: startCamera.centerY - (gesture.latest.y - gesture.start.y) / gesture.startScale,
		scale: startCamera.scale
	});
}

/**
 * DOM-independent Pointer Events state machine. The host owns event listeners,
 * pointer capture calls, camera state, placement reduction, and persistence.
 */
export class TimelineGestureController {
	readonly #getCamera: () => Camera;
	readonly #getViewport: () => ScreenViewport;
	readonly #callbacks: TimelineGestureCallbacks;
	readonly #scheduler: TimelineGestureScheduler;

	#active: ActiveGesture | null = null;
	#nextGestureId = 1;
	#pointerFrame: number | null = null;
	#pointerFrameGeneration = 0;
	#wheelFrame: number | null = null;
	#wheelTimer: number | null = null;
	#wheelStartCamera: Camera | null = null;
	#wheelCamera: Camera | null = null;
	#wheelDirty = false;
	#wheelGeneration = 0;
	#wheelTimerGeneration = 0;
	#terminalGestureIds = new Set<number>();
	#terminalGestureOrder: number[] = [];
	#clickSuppression: CompatibilityClickSuppression | null = null;
	#clickSuppressionTimer: number | null = null;
	#clickSuppressionGeneration = 0;
	#disposed = false;

	constructor(options: TimelineGestureControllerOptions) {
		this.#getCamera = options.getCamera;
		this.#getViewport = options.getViewport;
		this.#callbacks = options.callbacks ?? {};
		this.#scheduler = options.scheduler ?? browserScheduler();
	}

	activeGesture(): TimelineActiveGestureIdentity | null {
		const active = this.#active;
		if (!active) return null;
		return Object.freeze({
			pointerId: active.pointerId,
			gestureId: active.gestureId,
			kind:
				active.kind === 'pan'
					? 'pan'
					: active.dragStarted
						? 'album-drag'
						: 'album-armed'
		});
	}

	pointerDown(input: TimelinePointerDownInput): TimelinePointerDownResult {
		if (this.#disposed) return { accepted: false, reason: 'disposed' };
		if (this.#active) return { accepted: false, reason: 'busy' };
		const isPrimaryButton = input.button === 0;
		const isMiddleButton = input.button === 1;
		const forcePan = isMiddleButton || (isPrimaryButton && input.spaceKey === true);
		const isAlbumArm = isPrimaryButton && !forcePan && input.target.kind === 'album';
		const isBackgroundPan = isPrimaryButton && input.target.kind === 'background';
		if (!forcePan && !isAlbumArm && !isBackgroundPan) {
			return { accepted: false, reason: 'unsupported-button' };
		}

		requirePointerId(input.pointerId, 'pointerId');
		const start = requirePoint(input.clientX, input.clientY);
		this.#cancelWheelBurst();
		this.#clearClickSuppression();
		const gestureId = this.#allocateGestureId();
		const camera = requireCamera(this.#getCamera());
		const targetAlbum = input.target.kind === 'album' ? input.target.albumLocalId : null;
		if (targetAlbum !== null && targetAlbum.length === 0) {
			throw new TypeError('albumLocalId must be non-empty');
		}
		const preOffset =
			input.target.kind === 'album' ? requireOffset(input.target.preOffset) : null;
		this.#active = {
			gestureId,
			pointerId: input.pointerId,
			kind: isAlbumArm ? 'album' : 'pan',
			start,
			latest: start,
			startScale: camera.scale,
			pressedAlbumId: targetAlbum,
			primaryButton: isPrimaryButton,
			albumLocalId: isAlbumArm ? targetAlbum : null,
			preOffset: isAlbumArm ? preOffset : null,
			startCamera: isAlbumArm ? null : camera,
			dragStarted: false,
			hasMovement: false
		};
		const capture = Object.freeze({ pointerId: input.pointerId, gestureId });
		this.#callbacks.capturePointer?.(capture);
		return {
			accepted: true,
			gestureId,
			kind: isAlbumArm ? 'album-armed' : 'pan'
		};
	}

	pointerMove(input: TimelinePointerInput): boolean {
		const active = this.#matchingActive(input);
		if (!active) return false;
		this.#updatePoint(active, input.clientX, input.clientY);
		this.#schedulePointerFrame();
		return true;
	}

	pointerUp(input: TimelinePointerInput): boolean {
		const active = this.#matchingActive(input);
		if (!active) return false;
		this.#updatePoint(active, input.clientX, input.clientY);

		if (active.kind === 'album') {
			const albumLocalId = active.albumLocalId!;
			this.#suppressCompatibilityClick(albumLocalId);
			if (active.dragStarted) {
				const hitTest = {
					gestureId: active.gestureId,
					albumLocalId,
					clientX: active.latest.x,
					clientY: active.latest.y
				};
				let dropTarget: TimelineAlbumDropTarget | null = null;
				try {
					const resolved = this.#callbacks.resolveAlbumDropTarget?.(hitTest) ?? null;
					if (
						resolved &&
						(resolved.zoneId === null ||
							(typeof resolved.zoneId === 'string' && resolved.zoneId.length > 0))
					) {
						dropTarget = Object.freeze({ zoneId: resolved.zoneId });
					}
				} catch {
					// A failed screen-space hit test must never invent a zone authority.
				}
				this.#beginTerminal(active, false);
				try {
					this.#callbacks.commitAlbum?.({
						...hitTest,
						offset: albumOffsetAt(active),
						dropTarget
					});
				} finally {
					this.#callbacks.releasePointer?.({
						pointerId: active.pointerId,
						gestureId: active.gestureId
					});
				}
			} else {
				this.#beginTerminal(active, true);
				this.#callbacks.tapAlbum?.({
					gestureId: active.gestureId,
					albumLocalId,
					clientX: active.latest.x,
					clientY: active.latest.y
				});
			}
			return true;
		}
		this.#beginTerminal(active, true);

		if (active.primaryButton && active.pressedAlbumId !== null) {
			this.#suppressCompatibilityClick(active.pressedAlbumId);
		} else if (active.primaryButton && active.hasMovement) {
			this.#suppressCompatibilityClick(null);
		}
		if (active.hasMovement) {
			const camera = cameraAt(active);
			this.#callbacks.previewCamera?.({
				camera,
				source: 'pointer',
				gestureId: active.gestureId
			});
			if (distanceFromStart(active) > 0) {
				this.#callbacks.commitCamera?.({
					camera,
					source: 'pointer',
					gestureId: active.gestureId
				});
			}
		}
		return true;
	}

	pointerCancel(input: TimelinePointerInput): boolean {
		const active = this.#matchingActive(input);
		if (!active) return false;
		this.#updatePoint(active, input.clientX, input.clientY);
		return this.#cancelActive(active, 'pointercancel', true);
	}

	lostPointerCapture(input: TimelinePointerIdentity): boolean {
		if (this.#terminalGestureIds.has(requireGestureId(input.gestureId))) return false;
		const active = this.#matchingActiveIdentity(input);
		if (!active) return false;
		return this.#cancelActive(active, 'lostcapture', false);
	}

	escape(): boolean {
		const active = this.#active;
		if (!active) return false;
		return this.#cancelActive(active, 'escape', true);
	}

	wheel(input: TimelineWheelInput): boolean {
		if (this.#disposed || this.#active) return false;
		const point = requirePoint(input.clientX, input.clientY);
		const deltaX = requireFinite(input.deltaX, 'wheel deltaX');
		const deltaY = requireFinite(input.deltaY, 'wheel deltaY');
		const viewport = this.#getViewport();
		const mode = input.deltaMode ?? 0;
		if (mode !== 0 && mode !== 1 && mode !== 2) {
			throw new RangeError('wheel deltaMode must be 0, 1, or 2');
		}
		if (!this.#wheelCamera) {
			this.#wheelStartCamera = requireCamera(this.#getCamera());
			this.#wheelCamera = this.#wheelStartCamera;
			this.#wheelGeneration += 1;
		}
		const multiplierX = mode === 1 ? TIMELINE_WHEEL_LINE_PX : mode === 2 ? viewport.width : 1;
		const multiplierY = mode === 1 ? TIMELINE_WHEEL_LINE_PX : mode === 2 ? viewport.height : 1;
		const normalizedX = requireFinite(deltaX * multiplierX, 'normalized wheel deltaX');
		const normalizedY = requireFinite(deltaY * multiplierY, 'normalized wheel deltaY');
		if (input.ctrlKey || input.metaKey) {
			const exponent = Math.max(
				-20,
				Math.min(20, -normalizedY * TIMELINE_WHEEL_ZOOM_SENSITIVITY)
			);
			this.#wheelCamera = zoomCameraAtPoint(
				this.#wheelCamera,
				this.#wheelCamera.scale * Math.exp(exponent),
				{ x: point.x, y: point.y },
				viewport
			);
		} else {
			this.#wheelCamera = requireCamera({
				centerX: this.#wheelCamera.centerX + normalizedX / this.#wheelCamera.scale,
				centerY: this.#wheelCamera.centerY + normalizedY / this.#wheelCamera.scale,
				scale: this.#wheelCamera.scale
			});
		}
		this.#wheelDirty = true;
		this.#scheduleWheelFrame();
		this.#resetWheelTimer();
		return true;
	}

	/** Cancel a wheel burst and restore the camera from before its first event. */
	cancelWheel(): void {
		this.#cancelWheelBurst();
	}

	consumeCompatibilityClick(albumLocalId: string | null): boolean {
		const suppression = this.#clickSuppression;
		if (!suppression || suppression.albumLocalId !== albumLocalId) return false;
		this.#clearClickSuppression();
		return true;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const active = this.#active;
		if (active) this.#cancelActive(active, 'dispose', true);
		this.#cancelWheelBurst();
		this.#clearClickSuppression();
	}

	#matchingActive(input: TimelinePointerInput): ActiveGesture | null {
		requirePoint(input.clientX, input.clientY);
		return this.#matchingActiveIdentity(input);
	}

	#matchingActiveIdentity(input: TimelinePointerIdentity): ActiveGesture | null {
		requirePointerId(input.pointerId, 'pointerId');
		requireGestureId(input.gestureId);
		if (this.#terminalGestureIds.has(input.gestureId)) return null;
		const active = this.#active;
		if (
			!active ||
			active.pointerId !== input.pointerId ||
			active.gestureId !== input.gestureId
		) {
			return null;
		}
		return active;
	}

	#updatePoint(active: ActiveGesture, clientX: number, clientY: number): void {
		active.latest = requirePoint(clientX, clientY);
		const distance = distanceFromStart(active);
		if (distance > 0) active.hasMovement = true;
		if (
			active.kind === 'album' &&
			!active.dragStarted &&
			distance > TIMELINE_POINTER_DRAG_THRESHOLD_PX
		) {
			active.dragStarted = true;
		}
	}

	#schedulePointerFrame(): void {
		if (this.#pointerFrame !== null) return;
		const generation = ++this.#pointerFrameGeneration;
		this.#pointerFrame = this.#scheduler.requestFrame(() => {
			if (generation !== this.#pointerFrameGeneration) return;
			this.#pointerFrame = null;
			const active = this.#active;
			if (!active) return;
			if (active.kind === 'album') {
				if (!active.dragStarted) return;
				this.#callbacks.previewAlbum?.({
					gestureId: active.gestureId,
					albumLocalId: active.albumLocalId!,
					offset: albumOffsetAt(active),
					clientX: active.latest.x,
					clientY: active.latest.y
				});
				return;
			}
			this.#callbacks.previewCamera?.({
				camera: cameraAt(active),
				source: 'pointer',
				gestureId: active.gestureId
			});
		});
	}

	#scheduleWheelFrame(): void {
		if (this.#wheelFrame !== null) return;
		const generation = this.#wheelGeneration;
		this.#wheelFrame = this.#scheduler.requestFrame(() => {
			if (generation !== this.#wheelGeneration) return;
			this.#wheelFrame = null;
			this.#flushWheelPreview();
		});
	}

	#flushWheelPreview(): void {
		if (!this.#wheelDirty || !this.#wheelCamera) return;
		this.#wheelDirty = false;
		this.#callbacks.previewCamera?.({
			camera: copyCamera(this.#wheelCamera),
			source: 'wheel',
			gestureId: null
		});
	}

	#resetWheelTimer(): void {
		if (this.#wheelTimer !== null) this.#scheduler.clearTimer(this.#wheelTimer);
		const wheelGeneration = this.#wheelGeneration;
		const timerGeneration = ++this.#wheelTimerGeneration;
		this.#wheelTimer = this.#scheduler.setTimer(() => {
			if (
				wheelGeneration !== this.#wheelGeneration ||
				timerGeneration !== this.#wheelTimerGeneration
			) return;
			this.#wheelTimer = null;
			if (this.#wheelFrame !== null) {
				this.#scheduler.cancelFrame(this.#wheelFrame);
				this.#wheelFrame = null;
			}
			this.#flushWheelPreview();
			const camera = this.#wheelCamera;
			this.#wheelStartCamera = null;
			this.#wheelCamera = null;
			if (camera && !this.#disposed) {
				this.#callbacks.wheelIdle?.({ camera: copyCamera(camera) });
			}
		}, TIMELINE_WHEEL_IDLE_MS);
	}

	#cancelWheelBurst(): void {
		this.#wheelGeneration += 1;
		this.#wheelTimerGeneration += 1;
		if (this.#wheelFrame !== null) {
			this.#scheduler.cancelFrame(this.#wheelFrame);
			this.#wheelFrame = null;
		}
		if (this.#wheelTimer !== null) {
			this.#scheduler.clearTimer(this.#wheelTimer);
			this.#wheelTimer = null;
		}
		if (this.#wheelStartCamera) {
			this.#callbacks.previewCamera?.({
				camera: copyCamera(this.#wheelStartCamera),
				source: 'wheel',
				gestureId: null
			});
		}
		this.#wheelStartCamera = null;
		this.#wheelCamera = null;
		this.#wheelDirty = false;
	}

	#cancelActive(
		active: ActiveGesture,
		reason: TimelineGestureCancelReason,
		releaseCapture: boolean
	): boolean {
		if (this.#active !== active || this.#terminalGestureIds.has(active.gestureId)) return false;
		this.#beginTerminal(active, releaseCapture);
		if (active.kind === 'album') {
			this.#suppressCompatibilityClick(active.albumLocalId!);
			if (active.dragStarted) {
				this.#callbacks.previewAlbum?.({
					gestureId: active.gestureId,
					albumLocalId: active.albumLocalId!,
					offset: copyOffset(active.preOffset),
					clientX: active.latest.x,
					clientY: active.latest.y
				});
			}
			this.#callbacks.cancelAlbum?.({
				gestureId: active.gestureId,
				albumLocalId: active.albumLocalId!,
				preOffset: active.preOffset,
				reason
			});
			return true;
		}

		if (active.primaryButton && active.pressedAlbumId !== null) {
			this.#suppressCompatibilityClick(active.pressedAlbumId);
		}
		if (active.hasMovement) {
			this.#callbacks.previewCamera?.({
				camera: copyCamera(active.startCamera!),
				source: 'pointer',
				gestureId: active.gestureId
			});
		}
		this.#callbacks.cancelCamera?.({
			gestureId: active.gestureId,
			camera: copyCamera(active.startCamera!),
			reason
		});
		return true;
	}

	#beginTerminal(active: ActiveGesture, releaseCapture: boolean): void {
		this.#markTerminal(active.gestureId);
		this.#active = null;
		if (this.#pointerFrame !== null) {
			this.#scheduler.cancelFrame(this.#pointerFrame);
			this.#pointerFrame = null;
		}
		this.#pointerFrameGeneration += 1;
		if (releaseCapture) {
			this.#callbacks.releasePointer?.({
				pointerId: active.pointerId,
				gestureId: active.gestureId
			});
		}
	}

	#markTerminal(gestureId: number): void {
		if (this.#terminalGestureIds.has(gestureId)) return;
		this.#terminalGestureIds.add(gestureId);
		this.#terminalGestureOrder.push(gestureId);
		if (this.#terminalGestureOrder.length <= MAX_RETAINED_TERMINAL_GESTURES) return;
		const expired = this.#terminalGestureOrder.shift();
		if (expired !== undefined) this.#terminalGestureIds.delete(expired);
	}

	#suppressCompatibilityClick(albumLocalId: string | null): void {
		this.#clearClickSuppression();
		const generation = this.#clickSuppressionGeneration;
		this.#clickSuppression = { albumLocalId };
		this.#clickSuppressionTimer = this.#scheduler.setTimer(() => {
			if (generation !== this.#clickSuppressionGeneration) return;
			this.#clickSuppressionTimer = null;
			this.#clickSuppression = null;
		}, 0);
	}

	#clearClickSuppression(): void {
		this.#clickSuppressionGeneration += 1;
		if (this.#clickSuppressionTimer !== null) {
			this.#scheduler.clearTimer(this.#clickSuppressionTimer);
			this.#clickSuppressionTimer = null;
		}
		this.#clickSuppression = null;
	}

	#allocateGestureId(): number {
		const gestureId = this.#nextGestureId;
		this.#nextGestureId += 1;
		if (!Number.isSafeInteger(this.#nextGestureId)) this.#nextGestureId = 1;
		while (this.#terminalGestureIds.has(this.#nextGestureId)) this.#nextGestureId += 1;
		return gestureId;
	}
}
