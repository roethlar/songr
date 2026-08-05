import { describe, expect, it, vi } from 'vitest';

import { screenToWorld } from '../geometry';
import {
	TIMELINE_POINTER_DRAG_THRESHOLD_PX,
	TIMELINE_WHEEL_IDLE_MS,
	TimelineGestureController,
	type TimelineGestureCallbacks,
	type TimelineGestureScheduler,
	type TimelinePointerDownResult
} from '../TimelineGestureController';
import type { Camera, ScreenViewport } from '../types';

class FakeScheduler implements TimelineGestureScheduler {
	#nextHandle = 1;
	readonly frames = new Map<number, () => void>();
	readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
	readonly allFrames = new Map<number, () => void>();
	readonly allTimers = new Map<number, { callback: () => void; delayMs: number }>();

	requestFrame(callback: () => void): number {
		const handle = this.#nextHandle++;
		this.frames.set(handle, callback);
		this.allFrames.set(handle, callback);
		return handle;
	}

	cancelFrame(handle: number): void {
		this.frames.delete(handle);
	}

	setTimer(callback: () => void, delayMs: number): number {
		const handle = this.#nextHandle++;
		const timer = { callback, delayMs };
		this.timers.set(handle, timer);
		this.allTimers.set(handle, timer);
		return handle;
	}

	clearTimer(handle: number): void {
		this.timers.delete(handle);
	}

	flushFrames(): void {
		const pending = [...this.frames.entries()];
		this.frames.clear();
		for (const [, callback] of pending) callback();
	}

	flushTimers(): void {
		const pending = [...this.timers.entries()];
		this.timers.clear();
		for (const [, { callback }] of pending) callback();
	}

	invokeTimerEvenIfCancelled(handle: number): void {
		this.allTimers.get(handle)?.callback();
	}

	invokeFrameEvenIfCancelled(handle: number): void {
		this.allFrames.get(handle)?.();
	}
}

const viewport: ScreenViewport = { x: 0, y: 0, width: 1_200, height: 800 };
const initialCamera: Camera = { centerX: 50, centerY: 30, scale: 2 };

function accepted(result: TimelinePointerDownResult): Extract<TimelinePointerDownResult, { accepted: true }> {
	expect(result.accepted).toBe(true);
	if (!result.accepted) throw new Error(`gesture was rejected: ${result.reason}`);
	return result;
}

function albumDown(
	controller: TimelineGestureController,
	overrides: Partial<Parameters<TimelineGestureController['pointerDown']>[0]> = {}
) {
	return accepted(controller.pointerDown({
		pointerId: 7,
		button: 0,
		clientX: 100,
		clientY: 100,
		target: { kind: 'album', albumLocalId: 'album-1', preOffset: null },
		...overrides
	}));
}

function makeController(
	callbacks: TimelineGestureCallbacks = {},
	options: { scheduler?: FakeScheduler; camera?: Camera } = {}
) {
	const scheduler = options.scheduler ?? new FakeScheduler();
	let camera = options.camera ?? initialCamera;
	const controller = new TimelineGestureController({
		getCamera: () => camera,
		getViewport: () => viewport,
		callbacks: {
			...callbacks,
			previewCamera: (preview) => {
				camera = preview.camera;
				callbacks.previewCamera?.(preview);
			}
		},
		scheduler
	});
	return { controller, scheduler, camera: () => camera };
}

describe('TimelineGestureController', () => {
	it('keeps a six-CSS-pixel album movement a tap and starts dragging only beyond it', () => {
		const scheduler = new FakeScheduler();
		const tapAlbum = vi.fn();
		const previewAlbum = vi.fn();
		const commitAlbum = vi.fn();
		const { controller } = makeController({ tapAlbum, previewAlbum, commitAlbum }, { scheduler });
		const first = albumDown(controller);

		controller.pointerMove({
			pointerId: 7,
			gestureId: first.gestureId,
			clientX: 100 + TIMELINE_POINTER_DRAG_THRESHOLD_PX,
			clientY: 100
		});
		scheduler.flushFrames();
		expect(controller.activeGesture()?.kind).toBe('album-armed');
		expect(previewAlbum).not.toHaveBeenCalled();
		controller.pointerUp({
			pointerId: 7,
			gestureId: first.gestureId,
			clientX: 100 + TIMELINE_POINTER_DRAG_THRESHOLD_PX,
			clientY: 100
		});
		expect(tapAlbum).toHaveBeenCalledOnce();
		expect(commitAlbum).not.toHaveBeenCalled();

		const second = albumDown(controller);
		controller.pointerMove({
			pointerId: 7,
			gestureId: second.gestureId,
			clientX: 100 + TIMELINE_POINTER_DRAG_THRESHOLD_PX + 0.001,
			clientY: 100
		});
		expect(controller.activeGesture()?.kind).toBe('album-drag');
		scheduler.flushFrames();
		controller.pointerUp({
			pointerId: 7,
			gestureId: second.gestureId,
			clientX: 100 + TIMELINE_POINTER_DRAG_THRESHOLD_PX + 0.001,
			clientY: 100
		});
		expect(previewAlbum).toHaveBeenCalledOnce();
		expect(commitAlbum).toHaveBeenCalledOnce();
		expect(tapAlbum).toHaveBeenCalledOnce();
	});

	it('converts album deltas through the press scale and commits synchronous terminal coordinates', () => {
		const scheduler = new FakeScheduler();
		const previewAlbum = vi.fn();
		const commitAlbum = vi.fn();
		const { controller } = makeController({ previewAlbum, commitAlbum }, { scheduler });
		const press = albumDown(controller, {
			target: {
				kind: 'album',
				albumLocalId: 'album-1',
				preOffset: { dx: 10, dy: -5 }
			}
		});

		controller.pointerMove({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 120,
			clientY: 90
		});
		scheduler.flushFrames();
		expect(previewAlbum).toHaveBeenLastCalledWith({
			gestureId: press.gestureId,
			albumLocalId: 'album-1',
			offset: { dx: 20, dy: -10 },
			clientX: 120,
			clientY: 90
		});

		controller.pointerMove({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 125,
			clientY: 95
		});
		controller.pointerUp({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 130,
			clientY: 100
		});
		expect(commitAlbum).toHaveBeenCalledWith({
			gestureId: press.gestureId,
			albumLocalId: 'album-1',
			offset: { dx: 25, dy: -5 },
			clientX: 130,
			clientY: 100,
			dropTarget: null
		});
		expect(scheduler.frames.size).toBe(0);
	});

	it('coalesces high-frequency pointer previews into one frame with the latest point', () => {
		const scheduler = new FakeScheduler();
		const previewAlbum = vi.fn();
		const { controller } = makeController({ previewAlbum }, { scheduler });
		const press = albumDown(controller);

		for (const clientX of [108, 120, 136]) {
			controller.pointerMove({
				pointerId: 7,
				gestureId: press.gestureId,
				clientX,
				clientY: 100
			});
		}
		expect(scheduler.frames.size).toBe(1);
		expect(previewAlbum).not.toHaveBeenCalled();
		scheduler.flushFrames();
		expect(previewAlbum).toHaveBeenCalledOnce();
		expect(previewAlbum.mock.calls[0][0].offset).toEqual({ dx: 18, dy: 0 });
	});

	it('marks pointer-up terminal before release and ignores synchronous lost capture exactly once', () => {
		const scheduler = new FakeScheduler();
		const commitAlbum = vi.fn();
		const cancelAlbum = vi.fn();
		let controller!: TimelineGestureController;
		const releasePointer = vi.fn((identity) => {
			expect(controller.activeGesture()).toBeNull();
			expect(controller.lostPointerCapture(identity)).toBe(false);
		});
		controller = makeController(
			{ commitAlbum, cancelAlbum, releasePointer },
			{ scheduler }
		).controller;
		const press = albumDown(controller);
		const terminal = {
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 120,
			clientY: 100
		};

		expect(controller.pointerUp(terminal)).toBe(true);
		expect(releasePointer).toHaveBeenCalledOnce();
		expect(commitAlbum).toHaveBeenCalledOnce();
		expect(cancelAlbum).not.toHaveBeenCalled();
		expect(controller.pointerUp(terminal)).toBe(false);
		expect(controller.pointerCancel(terminal)).toBe(false);
		expect(controller.lostPointerCapture(terminal)).toBe(false);
		expect(controller.escape()).toBe(false);
		expect(commitAlbum).toHaveBeenCalledOnce();
	});

	it('hit-tests a zone once, settles the album callback, then releases terminal capture', () => {
		const order: string[] = [];
		let controller!: TimelineGestureController;
		const resolveAlbumDropTarget = vi.fn(() => {
			order.push('hit-test');
			expect(controller.activeGesture()?.kind).toBe('album-drag');
			return { zoneId: 'zone-test' };
		});
		const commitAlbum = vi.fn((commit) => {
			order.push('commit');
			expect(controller.activeGesture()).toBeNull();
			expect(commit.dropTarget).toEqual({ zoneId: 'zone-test' });
		});
		const releasePointer = vi.fn((identity) => {
			order.push('release');
			expect(controller.activeGesture()).toBeNull();
			expect(controller.lostPointerCapture(identity)).toBe(false);
		});
		controller = makeController({
			resolveAlbumDropTarget,
			commitAlbum,
			releasePointer
		}).controller;
		const press = albumDown(controller);
		controller.pointerMove({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 120,
			clientY: 110
		});

		expect(controller.pointerUp({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 130,
			clientY: 115
		})).toBe(true);
		expect(resolveAlbumDropTarget).toHaveBeenCalledOnce();
		expect(resolveAlbumDropTarget).toHaveBeenCalledWith({
			gestureId: press.gestureId,
			albumLocalId: 'album-1',
			clientX: 130,
			clientY: 115
		});
		expect(order).toEqual(['hit-test', 'commit', 'release']);
		expect(commitAlbum).toHaveBeenCalledOnce();
		expect(releasePointer).toHaveBeenCalledOnce();
	});

	it('preserves one inside-dock invalid-target disposition through terminal release', () => {
		const commitAlbum = vi.fn();
		const releasePointer = vi.fn();
		const resolveAlbumDropTarget = vi.fn(() => ({ zoneId: null }));
		const { controller } = makeController({
			resolveAlbumDropTarget,
			commitAlbum,
			releasePointer
		});
		const press = albumDown(controller);
		controller.pointerMove({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 120,
			clientY: 110
		});

		expect(controller.pointerUp({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 130,
			clientY: 115
		})).toBe(true);
		expect(resolveAlbumDropTarget).toHaveBeenCalledOnce();
		expect(commitAlbum).toHaveBeenCalledWith(expect.objectContaining({
			dropTarget: { zoneId: null }
		}));
		expect(releasePointer).toHaveBeenCalledOnce();
	});

	it('rolls a cancelled drag back to its exact pre-offset and never commits it', () => {
		const scheduler = new FakeScheduler();
		const previewAlbum = vi.fn();
		const commitAlbum = vi.fn();
		const cancelAlbum = vi.fn();
		const { controller } = makeController(
			{ previewAlbum, commitAlbum, cancelAlbum },
			{ scheduler }
		);
		const press = albumDown(controller, {
			target: {
				kind: 'album',
				albumLocalId: 'album-1',
				preOffset: { dx: -12, dy: 9 }
			}
		});
		controller.pointerMove({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 130,
			clientY: 120
		});
		scheduler.flushFrames();

		expect(controller.pointerCancel({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 132,
			clientY: 122
		})).toBe(true);
		expect(previewAlbum).toHaveBeenLastCalledWith({
			gestureId: press.gestureId,
			albumLocalId: 'album-1',
			offset: { dx: -12, dy: 9 },
			clientX: 132,
			clientY: 122
		});
		expect(cancelAlbum).toHaveBeenCalledWith({
			gestureId: press.gestureId,
			albumLocalId: 'album-1',
			preOffset: { dx: -12, dy: 9 },
			reason: 'pointercancel'
		});
		expect(commitAlbum).not.toHaveBeenCalled();
		expect(controller.escape()).toBe(false);

		const escaped = albumDown(controller);
		controller.pointerMove({
			pointerId: 7,
			gestureId: escaped.gestureId,
			clientX: 120,
			clientY: 100
		});
		expect(controller.escape()).toBe(true);
		expect(cancelAlbum).toHaveBeenLastCalledWith(expect.objectContaining({
			gestureId: escaped.gestureId,
			reason: 'escape'
		}));

		const lost = albumDown(controller);
		controller.pointerMove({
			pointerId: 7,
			gestureId: lost.gestureId,
			clientX: 120,
			clientY: 100
		});
		const lostIdentity = { pointerId: 7, gestureId: lost.gestureId };
		expect(controller.lostPointerCapture(lostIdentity)).toBe(true);
		expect(controller.lostPointerCapture(lostIdentity)).toBe(false);
		expect(cancelAlbum).toHaveBeenLastCalledWith(expect.objectContaining({
			gestureId: lost.gestureId,
			reason: 'lostcapture'
		}));
		expect(commitAlbum).not.toHaveBeenCalled();
	});

	it('pans from primary background, middle-button, or Space plus primary using press-scale math', () => {
		const scheduler = new FakeScheduler();
		const previewCamera = vi.fn();
		const commitCamera = vi.fn();
		const { controller } = makeController({ previewCamera, commitCamera }, { scheduler });
		const press = accepted(controller.pointerDown({
			pointerId: 3,
			button: 0,
			clientX: 100,
			clientY: 100,
			target: { kind: 'background' }
		}));
		expect(press.kind).toBe('pan');
		controller.pointerMove({
			pointerId: 3,
			gestureId: press.gestureId,
			clientX: 120,
			clientY: 90
		});
		scheduler.flushFrames();
		expect(previewCamera.mock.calls[0][0].camera).toEqual({
			centerX: 40,
			centerY: 35,
			scale: 2
		});
		controller.pointerUp({
			pointerId: 3,
			gestureId: press.gestureId,
			clientX: 130,
			clientY: 80
		});
		expect(commitCamera).toHaveBeenLastCalledWith({
			camera: { centerX: 35, centerY: 40, scale: 2 },
			source: 'pointer',
			gestureId: press.gestureId
		});

		const middle = albumDown(controller, { pointerId: 4, button: 1 });
		expect(middle.kind).toBe('pan');
		controller.pointerCancel({
			pointerId: 4,
			gestureId: middle.gestureId,
			clientX: 100,
			clientY: 100
		});
		const spacePrimary = albumDown(controller, { pointerId: 5, spaceKey: true });
		expect(spacePrimary.kind).toBe('pan');
		controller.pointerCancel({
			pointerId: 5,
			gestureId: spacePrimary.gestureId,
			clientX: 100,
			clientY: 100
		});
	});

	it('restores a pan preview without committing when the pointer returns to its press point', () => {
		const scheduler = new FakeScheduler();
		const previewCamera = vi.fn();
		const commitCamera = vi.fn();
		const { controller } = makeController({ previewCamera, commitCamera }, { scheduler });
		const press = accepted(controller.pointerDown({
			pointerId: 3,
			button: 0,
			clientX: 100,
			clientY: 100,
			target: { kind: 'background' }
		}));
		controller.pointerMove({
			pointerId: 3,
			gestureId: press.gestureId,
			clientX: 130,
			clientY: 120
		});
		scheduler.flushFrames();
		controller.pointerUp({
			pointerId: 3,
			gestureId: press.gestureId,
			clientX: 100,
			clientY: 100
		});

		expect(previewCamera).toHaveBeenLastCalledWith({
			camera: initialCamera,
			source: 'pointer',
			gestureId: press.gestureId
		});
		expect(commitCamera).not.toHaveBeenCalled();
	});

	it('accumulates wheel pan, cursor-centers modifier zoom, coalesces frames, and settles at 160ms', () => {
		const scheduler = new FakeScheduler();
		const previewCamera = vi.fn();
		const wheelIdle = vi.fn();
		const { controller, camera } = makeController({ previewCamera, wheelIdle }, { scheduler });

		controller.wheel({ clientX: 300, clientY: 240, deltaX: 10, deltaY: 20 });
		const firstTimer = [...scheduler.timers.keys()][0];
		controller.wheel({ clientX: 300, clientY: 240, deltaX: 6, deltaY: -4 });
		expect(scheduler.frames.size).toBe(1);
		expect(scheduler.timers.size).toBe(1);
		expect([...scheduler.timers.values()][0].delayMs).toBe(TIMELINE_WHEEL_IDLE_MS);
		scheduler.flushFrames();
		expect(previewCamera).toHaveBeenCalledOnce();
		expect(camera()).toEqual({ centerX: 58, centerY: 38, scale: 2 });
		scheduler.flushTimers();
		expect(wheelIdle).toHaveBeenCalledOnce();
		expect(wheelIdle).toHaveBeenCalledWith({ camera: { centerX: 58, centerY: 38, scale: 2 } });
		scheduler.invokeTimerEvenIfCancelled(firstTimer);
		expect(wheelIdle).toHaveBeenCalledOnce();

		const pointer = { x: 260, y: 180 };
		const worldBefore = screenToWorld(pointer, camera(), viewport);
		controller.wheel({
			clientX: pointer.x,
			clientY: pointer.y,
			deltaX: 0,
			deltaY: -100,
			metaKey: true
		});
		scheduler.flushFrames();
		expect(camera().scale).toBeGreaterThan(2);
		const worldAfter = screenToWorld(pointer, camera(), viewport);
		expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10);
		expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10);
		scheduler.flushTimers();
		expect(wheelIdle).toHaveBeenCalledTimes(2);
	});

	it('rolls back and invalidates wheel idle without allowing a late timer to settle a new burst', () => {
		const scheduler = new FakeScheduler();
		const wheelIdle = vi.fn();
		const { controller, camera } = makeController({ wheelIdle }, { scheduler });
		controller.wheel({ clientX: 100, clientY: 100, deltaX: 1, deltaY: 2 });
		const cancelledTimer = [...scheduler.timers.keys()][0];
		scheduler.flushFrames();
		expect(camera()).not.toEqual(initialCamera);

		controller.cancelWheel();
		expect(camera()).toEqual(initialCamera);
		expect(scheduler.timers.size).toBe(0);
		controller.wheel({ clientX: 100, clientY: 100, deltaX: 3, deltaY: 4 });
		scheduler.invokeTimerEvenIfCancelled(cancelledTimer);
		expect(wheelIdle).not.toHaveBeenCalled();
		scheduler.flushTimers();
		expect(wheelIdle).toHaveBeenCalledOnce();
	});

	it('rolls back and cancels pending wheel idle before accepting a pointer interaction', () => {
		const scheduler = new FakeScheduler();
		const { controller, camera } = makeController({}, { scheduler });
		controller.wheel({ clientX: 100, clientY: 100, deltaX: 4, deltaY: 8 });
		scheduler.flushFrames();
		expect(camera()).not.toEqual(initialCamera);
		expect(scheduler.timers.size).toBe(1);

		const press = albumDown(controller);
		expect(camera()).toEqual(initialCamera);
		expect(scheduler.timers.size).toBe(0);
		expect(controller.activeGesture()).toEqual({
			pointerId: 7,
			gestureId: press.gestureId,
			kind: 'album-armed'
		});
		controller.pointerCancel({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 100,
			clientY: 100
		});
	});

	it('suppresses one matching compatibility click after a controller-owned album gesture', () => {
		const scheduler = new FakeScheduler();
		const { controller } = makeController({}, { scheduler });
		const press = albumDown(controller);
		controller.pointerUp({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 120,
			clientY: 100
		});

		expect(controller.consumeCompatibilityClick('other-album')).toBe(false);
		expect(controller.consumeCompatibilityClick('album-1')).toBe(true);
		expect(controller.consumeCompatibilityClick('album-1')).toBe(false);

		const expiringPress = albumDown(controller);
		controller.pointerUp({
			pointerId: 7,
			gestureId: expiringPress.gestureId,
			clientX: 120,
			clientY: 100
		});
		expect(controller.consumeCompatibilityClick('album-1')).toBe(true);
		const laterPress = albumDown(controller);
		controller.pointerUp({
			pointerId: 7,
			gestureId: laterPress.gestureId,
			clientX: 120,
			clientY: 100
		});
		scheduler.flushTimers();
		expect(controller.consumeCompatibilityClick('album-1')).toBe(false);
	});

	it('suppresses the compatibility click when an armed album press is cancelled', () => {
		const scheduler = new FakeScheduler();
		const tapAlbum = vi.fn();
		const { controller } = makeController({ tapAlbum }, { scheduler });
		const press = albumDown(controller);

		expect(controller.escape()).toBe(true);
		expect(tapAlbum).not.toHaveBeenCalled();
		expect(controller.consumeCompatibilityClick('album-1')).toBe(true);
		expect(controller.consumeCompatibilityClick('album-1')).toBe(false);
		expect(controller.pointerUp({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 100,
			clientY: 100
		})).toBe(false);
	});

	it('dispose cancels capture, frames, timers, and all later scheduled callbacks', () => {
		const pointerScheduler = new FakeScheduler();
		const previewAlbum = vi.fn();
		const cancelAlbum = vi.fn();
		const releasePointer = vi.fn();
		const pointer = makeController(
			{ previewAlbum, cancelAlbum, releasePointer },
			{ scheduler: pointerScheduler }
		);
		const press = albumDown(pointer.controller);
		pointer.controller.pointerMove({
			pointerId: 7,
			gestureId: press.gestureId,
			clientX: 120,
			clientY: 100
		});
		const cancelledFrame = [...pointerScheduler.frames.keys()][0];
		pointer.controller.dispose();
		expect(pointer.controller.activeGesture()).toBeNull();
		expect(releasePointer).toHaveBeenCalledOnce();
		expect(cancelAlbum).toHaveBeenCalledWith(expect.objectContaining({ reason: 'dispose' }));
		expect(pointerScheduler.frames.size).toBe(0);
		pointerScheduler.invokeFrameEvenIfCancelled(cancelledFrame);
		expect(previewAlbum).toHaveBeenCalledOnce();

		const wheelScheduler = new FakeScheduler();
		const previewCamera = vi.fn();
		const wheelIdle = vi.fn();
		const wheel = makeController({ previewCamera, wheelIdle }, { scheduler: wheelScheduler });
		wheel.controller.wheel({ clientX: 100, clientY: 100, deltaX: 4, deltaY: 8 });
		const lateFrame = [...wheelScheduler.frames.keys()][0];
		const lateTimer = [...wheelScheduler.timers.keys()][0];
		wheel.controller.dispose();
		expect(wheelScheduler.frames.size).toBe(0);
		expect(wheelScheduler.timers.size).toBe(0);
		expect(previewCamera).toHaveBeenCalledOnce();
		expect(previewCamera).toHaveBeenCalledWith({
			camera: initialCamera,
			source: 'wheel',
			gestureId: null
		});
		wheelScheduler.invokeFrameEvenIfCancelled(lateFrame);
		wheelScheduler.invokeTimerEvenIfCancelled(lateTimer);
		expect(previewCamera).toHaveBeenCalledOnce();
		expect(wheelIdle).not.toHaveBeenCalled();
		expect(wheel.controller.wheel({
			clientX: 100,
			clientY: 100,
			deltaX: 1,
			deltaY: 1
		})).toBe(false);
	});
});
