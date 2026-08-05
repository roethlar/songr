import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('LibraryViewHost real production registry', () => {
	let originalStorageDescriptor: PropertyDescriptor | undefined;
	let mountedCleanup: (() => Promise<void>) | undefined;

	beforeEach(() => {
		vi.resetModules();
		vi.doUnmock('../libraryViewLoaders');
		vi.doUnmock('../ClassicLibraryMode.svelte');
		vi.doUnmock('../TimelineLibraryMode.svelte');
		vi.doUnmock('../UnifiedLibraryMode.svelte');
		originalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			value: {
				getItem: () => null,
				setItem: vi.fn()
			}
		});
	});

	afterEach(async () => {
		if (mountedCleanup) await mountedCleanup();
		mountedCleanup = undefined;
		vi.doUnmock('../libraryViewLoaders');
		vi.doUnmock('../ClassicLibraryMode.svelte');
		vi.doUnmock('../TimelineLibraryMode.svelte');
		vi.doUnmock('../UnifiedLibraryMode.svelte');
		vi.restoreAllMocks();
		if (originalStorageDescriptor) {
			Object.defineProperty(window, 'localStorage', originalStorageDescriptor);
		} else {
			Reflect.deleteProperty(window, 'localStorage');
		}
	});

	it('mounts the real Unified production default without evaluating gated modes', async () => {
		const classicModuleEvaluation = vi.fn();
		const timelineModuleEvaluation = vi.fn();
		const unifiedModuleEvaluation = vi.fn();
		vi.doMock('../ClassicLibraryMode.svelte', async () => {
			classicModuleEvaluation();
			return { default: (await import('./fixtures/FakeLibraryMode.svelte')).default };
		});
		vi.doMock('../TimelineLibraryMode.svelte', async () => {
			timelineModuleEvaluation();
			return { default: (await import('./fixtures/FakeLibraryMode.svelte')).default };
		});
		vi.doMock('../UnifiedLibraryMode.svelte', async () => {
			unifiedModuleEvaluation();
			return { default: (await import('./fixtures/FakeLibraryMode.svelte')).default };
		});

		const Host = (await import('../+page.svelte')).default;
		const [{ get }, { libraryViewHostStore }] = await Promise.all([
			import('svelte/store'),
			import('$lib/stores/libraryViewHostStore')
		]);
		expect(classicModuleEvaluation).not.toHaveBeenCalled();
		expect(timelineModuleEvaluation).not.toHaveBeenCalled();
		expect(unifiedModuleEvaluation).not.toHaveBeenCalled();
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: null,
			pendingMode: null,
			transition: null
		});

		const { mount, unmount } = await import('svelte');
		const container = document.createElement('div');
		document.body.append(container);
		const instance = mount(Host, { target: container });
		mountedCleanup = async () => {
			await unmount(instance);
			container.remove();
		};

		await vi.waitFor(() =>
			expect(container.querySelector('[data-testid="library-mode-target"]')).not.toBeNull()
		);
		expect(classicModuleEvaluation).not.toHaveBeenCalled();
		expect(timelineModuleEvaluation).not.toHaveBeenCalled();
		expect(unifiedModuleEvaluation).toHaveBeenCalledTimes(1);
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: 'unified',
			pendingMode: null,
			transition: null
		});
		expect(container.querySelectorAll('[data-testid="library-mode-target"]')).toHaveLength(1);
		expect(container.querySelector('[data-testid="library-mode-loading"]')).toBeNull();
		expect(container.querySelector('[data-testid="library-mode-error"]')).toBeNull();

		await mountedCleanup();
		mountedCleanup = undefined;
		expect(get(libraryViewHostStore)).toEqual({
			activeMode: null,
			pendingMode: null,
			transition: null
		});
	});
});
