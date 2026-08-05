import { describe, expect, it, vi } from 'vitest';
import {
	createLibraryViewLoaderController,
	type LibraryViewLoaderState
} from '../libraryViewLoaderController';
import { resolveAvailableLibraryView } from '$lib/stores/libraryViewStore';

interface Target {
	readonly name: string;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function expectActive(
	state: LibraryViewLoaderState<Target>,
	mode: 'classic' | 'timeline',
	target: Target
): void {
	expect(state.activeMode).toBe(mode);
	expect(state.activeTarget).toBe(target);
	expect(state.loading).toBe(false);
}

describe('libraryViewLoaderController', () => {
	it('loads only the requested target and publishes nothing before it resolves', async () => {
		const pendingClassic = deferred<Target>();
		const classicLoader = vi.fn(() => pendingClassic.promise);
		const timelineLoader = vi.fn<() => Promise<Target>>();
		const controller = createLibraryViewLoaderController({
			loaders: { classic: classicLoader, timeline: timelineLoader }
		});

		expect(classicLoader).not.toHaveBeenCalled();
		expect(timelineLoader).not.toHaveBeenCalled();

		const activation = controller.activate('classic');
		expect(classicLoader).toHaveBeenCalledTimes(1);
		expect(timelineLoader).not.toHaveBeenCalled();
		expect(controller.getState()).toMatchObject({
			requestedMode: 'classic',
			activeMode: null,
			activeTarget: null,
			loading: true,
			error: null
		});

		const classicTarget = Object.freeze({ name: 'classic' });
		pendingClassic.resolve(classicTarget);
		expect((await activation).status).toBe('activated');
		expectActive(controller.getState(), 'classic', classicTarget);
	});

	it('resolves a gated Timeline preference to Classic before loader lookup', async () => {
		const classicTarget = Object.freeze({ name: 'classic' });
		const classicLoader = vi.fn(async () => classicTarget);
		const timelineBomb = vi.fn<() => Promise<Target>>(() => {
			throw new Error('Timeline loader must remain unreachable');
		});
		const controller = createLibraryViewLoaderController({
			loaders: { classic: classicLoader, timeline: timelineBomb },
			resolveMode: resolveAvailableLibraryView
		});

		const activation = controller.activate('timeline');
		expect(controller.getState().requestedMode).toBe('classic');
		expect(classicLoader).toHaveBeenCalledTimes(1);
		expect(timelineBomb).not.toHaveBeenCalled();
		expect((await activation).status).toBe('activated');
		expectActive(controller.getState(), 'classic', classicTarget);
	});

	it('rejects an explicit gated Timeline target without loading the fallback', async () => {
		const classicLoader = vi.fn<() => Promise<Target>>(async () =>
			Object.freeze({ name: 'classic' })
		);
		const timelineLoader = vi.fn<() => Promise<Target>>(async () =>
			Object.freeze({ name: 'timeline' })
		);
		const controller = createLibraryViewLoaderController({
			loaders: { classic: classicLoader, timeline: timelineLoader },
			resolveMode: resolveAvailableLibraryView
		});

		const result = await controller.activate('timeline', {
			requireExactMode: true,
			clearActiveOnFailure: true
		});

		expect(result.status).toBe('failed');
		expect(classicLoader).not.toHaveBeenCalled();
		expect(timelineLoader).not.toHaveBeenCalled();
		expect(controller.getState()).toMatchObject({
			requestedMode: 'classic',
			activeMode: null,
			activeTarget: null,
			loading: false,
			error: expect.objectContaining({ name: 'UnavailableLibraryViewError' })
		});
	});

	it('retains the outgoing target until a warm load swaps it atomically', async () => {
		const classicTarget: Target = Object.freeze({ name: 'classic' });
		const timelineTarget: Target = Object.freeze({ name: 'timeline' });
		const pendingTimeline = deferred<Target>();
		const controller = createLibraryViewLoaderController({
			loaders: {
				classic: vi.fn(async () => classicTarget),
				timeline: vi.fn(() => pendingTimeline.promise)
			}
		});

		await controller.activate('classic');
		const activation = controller.activate('timeline');
		expect(controller.getState()).toMatchObject({
			requestedMode: 'timeline',
			activeMode: 'classic',
			loading: true
		});
		expect(controller.getState().activeTarget).toBe(classicTarget);

		pendingTimeline.resolve(timelineTarget);
		expect((await activation).status).toBe('activated');
		expectActive(controller.getState(), 'timeline', timelineTarget);
	});

	it('runs the activation commit before publishing a newly loaded target', async () => {
		const classicTarget: Target = Object.freeze({ name: 'classic' });
		const timelineTarget: Target = Object.freeze({ name: 'timeline' });
		const controller = createLibraryViewLoaderController({
			loaders: {
				classic: vi.fn(async () => classicTarget),
				timeline: vi.fn(async () => timelineTarget)
			}
		});

		await controller.activate('classic');
		const beforeCommit = vi.fn(({ requestedMode, target }) => {
			expect(requestedMode).toBe('timeline');
			expect(target).toBe(timelineTarget);
			expect(controller.getState().activeMode).toBe('classic');
			expect(controller.getState().activeTarget).toBe(classicTarget);
		});

		expect((await controller.activate('timeline', { beforeCommit })).status).toBe('activated');
		expect(beforeCommit).toHaveBeenCalledTimes(1);
		expectActive(controller.getState(), 'timeline', timelineTarget);
	});

	it('runs the activation commit for an already-loaded mode without loading it again', async () => {
		const classicTarget = Object.freeze({ name: 'classic' });
		const classicLoader = vi.fn(async () => classicTarget);
		const controller = createLibraryViewLoaderController({
			loaders: { classic: classicLoader }
		});

		await controller.activate('classic');
		const beforeCommit = vi.fn();
		expect((await controller.activate('classic', { beforeCommit })).status).toBe('activated');

		expect(classicLoader).toHaveBeenCalledTimes(1);
		expect(beforeCommit).toHaveBeenCalledWith({
			requestedMode: 'classic',
			target: classicTarget
		});
	});

	it('rolls a warm failed request back while retaining the exact outgoing target', async () => {
		const classicTarget = Object.freeze({ name: 'classic' });
		const error = new Error('load failed');
		const controller = createLibraryViewLoaderController({
			loaders: {
				classic: vi.fn(async () => classicTarget),
				timeline: vi.fn(async () => {
					throw error;
				})
			}
		});

		await controller.activate('classic');
		const result = await controller.activate('timeline');

		expect(result.status).toBe('failed');
		expect(controller.getState()).toEqual({
			requestedMode: 'classic',
			activeMode: 'classic',
			activeTarget: classicTarget,
			loading: false,
			error
		});
	});

	it('clears the outgoing target when a history-pop activation fails', async () => {
		const classicTarget = Object.freeze({ name: 'classic' });
		const error = new Error('popped target failed');
		const controller = createLibraryViewLoaderController({
			loaders: {
				classic: vi.fn(async () => classicTarget),
				timeline: vi.fn(async () => {
					throw error;
				})
			}
		});

		await controller.activate('classic');
		const beforeClearActive = vi.fn(() => {
			expect(controller.getState()).toMatchObject({
				activeMode: 'classic',
				activeTarget: classicTarget
			});
		});
		const result = await controller.activate('timeline', {
			clearActiveOnFailure: true,
			beforeClearActive
		});

		expect(result.status).toBe('failed');
		expect(beforeClearActive).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({
			requestedMode: 'timeline',
			activeMode: null,
			activeTarget: null,
			loading: false,
			error
		});
	});

	it('treats a failed activation commit like a warm load failure', async () => {
		const classicTarget: Target = Object.freeze({ name: 'classic' });
		const timelineTarget: Target = Object.freeze({ name: 'timeline' });
		const error = new Error('history commit failed');
		const controller = createLibraryViewLoaderController({
			loaders: {
				classic: vi.fn(async () => classicTarget),
				timeline: vi.fn(async () => timelineTarget)
			}
		});

		await controller.activate('classic');
		const result = await controller.activate('timeline', {
			beforeCommit: () => {
				throw error;
			}
		});

		expect(result.status).toBe('failed');
		expect(controller.getState()).toEqual({
			requestedMode: 'classic',
			activeMode: 'classic',
			activeTarget: classicTarget,
			loading: false,
			error
		});
	});

	it('exposes a cold failure with no target and can retry successfully', async () => {
		const classicTarget = Object.freeze({ name: 'classic' });
		const error = new Error('cold failure');
		const classicLoader = vi
			.fn<() => Promise<Target>>()
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce(classicTarget);
		const controller = createLibraryViewLoaderController({
			loaders: { classic: classicLoader }
		});

		expect((await controller.activate('classic')).status).toBe('failed');
		expect(controller.getState()).toEqual({
			requestedMode: 'classic',
			activeMode: null,
			activeTarget: null,
			loading: false,
			error
		});

		expect((await controller.activate('classic')).status).toBe('activated');
		expect(classicLoader).toHaveBeenCalledTimes(2);
		expectActive(controller.getState(), 'classic', classicTarget);
	});

	it('does not let a stale completion overwrite a newer activation', async () => {
		const pendingClassic = deferred<Target>();
		const pendingTimeline = deferred<Target>();
		const classicTarget = Object.freeze({ name: 'classic' });
		const timelineTarget = Object.freeze({ name: 'timeline' });
		const controller = createLibraryViewLoaderController({
			loaders: {
				classic: vi.fn(() => pendingClassic.promise),
				timeline: vi.fn(() => pendingTimeline.promise)
			}
		});

		const older = controller.activate('classic');
		const newer = controller.activate('timeline');
		pendingTimeline.resolve(timelineTarget);
		expect((await newer).status).toBe('activated');
		expectActive(controller.getState(), 'timeline', timelineTarget);

		pendingClassic.resolve(classicTarget);
		expect((await older).status).toBe('superseded');
		expectActive(controller.getState(), 'timeline', timelineTarget);
	});

	it('invalidates an unmounted activation before its commit can run', async () => {
		const pendingClassic = deferred<Target>();
		const classicTarget: Target = Object.freeze({ name: 'classic' });
		const beforeCommit = vi.fn();
		const controller = createLibraryViewLoaderController<Target>({
			loaders: { classic: vi.fn(() => pendingClassic.promise) }
		});

		const activation = controller.activate('classic', { beforeCommit });
		controller.invalidatePending();
		pendingClassic.resolve(classicTarget);

		expect((await activation).status).toBe('superseded');
		expect(beforeCommit).not.toHaveBeenCalled();
		expect(controller.getState().activeTarget).toBeNull();
	});

	it('does not let a stale rejection disturb a newer activation', async () => {
		const pendingClassic = deferred<Target>();
		const timelineTarget = Object.freeze({ name: 'timeline' });
		const controller = createLibraryViewLoaderController({
			loaders: {
				classic: vi.fn(() => pendingClassic.promise),
				timeline: vi.fn(async () => timelineTarget)
			}
		});

		const older = controller.activate('classic');
		expect((await controller.activate('timeline')).status).toBe('activated');
		expectActive(controller.getState(), 'timeline', timelineTarget);

		pendingClassic.reject(undefined);
		expect((await older).status).toBe('superseded');
		expectActive(controller.getState(), 'timeline', timelineTarget);
		expect(controller.getState().error).toBeNull();
	});
});
