import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('production Library view loaders', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doUnmock('../ClassicLibraryMode.svelte');
		vi.doUnmock('../TimelineLibraryMode.svelte');
		vi.doUnmock('../UnifiedLibraryMode.svelte');
	});

	afterEach(() => {
		vi.doUnmock('../ClassicLibraryMode.svelte');
		vi.doUnmock('../TimelineLibraryMode.svelte');
		vi.doUnmock('../UnifiedLibraryMode.svelte');
		vi.restoreAllMocks();
	});

	it('registers all real lazy loaders without evaluating gated modes', async () => {
		const classicModuleEvaluation = vi.fn();
		const timelineModuleEvaluation = vi.fn();
		const unifiedModuleEvaluation = vi.fn();
		const classicTarget = Object.freeze({ name: 'classic-target' });
		const timelineTarget = Object.freeze({ name: 'timeline-target' });
		const unifiedTarget = Object.freeze({ name: 'unified-target' });
		vi.doMock('../ClassicLibraryMode.svelte', () => {
			classicModuleEvaluation();
			return { default: classicTarget };
		});
		vi.doMock('../TimelineLibraryMode.svelte', () => {
			timelineModuleEvaluation();
			return { default: timelineTarget };
		});
		vi.doMock('../UnifiedLibraryMode.svelte', () => {
			unifiedModuleEvaluation();
			return { default: unifiedTarget };
		});

		const loaders = await import('../libraryViewLoaders');
		expect(classicModuleEvaluation).not.toHaveBeenCalled();
		expect(timelineModuleEvaluation).not.toHaveBeenCalled();
		expect(unifiedModuleEvaluation).not.toHaveBeenCalled();
		expect(Object.keys(loaders.PRODUCTION_LIBRARY_VIEW_LOADERS)).toEqual([
			'classic',
			'timeline',
			'unified'
		]);

		const controller = loaders.createProductionLibraryViewLoaderController();
		const activation = await controller.activate('timeline');

		expect(classicModuleEvaluation).toHaveBeenCalledTimes(1);
		expect(timelineModuleEvaluation).not.toHaveBeenCalled();
		expect(unifiedModuleEvaluation).not.toHaveBeenCalled();
		expect(activation.status).toBe('activated');
		expect(controller.getState()).toMatchObject({
			requestedMode: 'classic',
			activeMode: 'classic',
			activeTarget: classicTarget,
			loading: false,
			error: null
		});

		const loadedTimeline = await loaders.PRODUCTION_LIBRARY_VIEW_LOADERS.timeline?.();
		expect(loadedTimeline).toBe(timelineTarget);
		expect(timelineModuleEvaluation).toHaveBeenCalledTimes(1);

		const loadedUnified = await loaders.PRODUCTION_LIBRARY_VIEW_LOADERS.unified?.();
		expect(loadedUnified).toBe(unifiedTarget);
		expect(unifiedModuleEvaluation).toHaveBeenCalledTimes(1);
	});

	it('activates the real Unified loader when the dev preview resolves it', async () => {
		const unifiedTarget = Object.freeze({ name: 'unified-target' });
		vi.doMock('../ClassicLibraryMode.svelte', () => ({ default: {} }));
		vi.doMock('../TimelineLibraryMode.svelte', () => ({ default: {} }));
		vi.doMock('../UnifiedLibraryMode.svelte', () => ({ default: unifiedTarget }));

		const loaders = await import('../libraryViewLoaders');
		const controller = loaders.createProductionLibraryViewLoaderController();
		// vitest runs as a dev build, so the dev preview path resolves Unified.
		const activation = await controller.activate('unified');

		expect(activation.status).toBe('activated');
		expect(controller.getState()).toMatchObject({
			requestedMode: 'unified',
			activeMode: 'unified',
			activeTarget: unifiedTarget
		});
	});
});
