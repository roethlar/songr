import { describe, expect, it, vi } from 'vitest';
import { requestLibraryViewFromSettings } from '../libraryViewSettings';

describe('requestLibraryViewFromSettings', () => {
	it('delegates an on-Library change to the active host without navigating', async () => {
		const requestActiveView = vi.fn(async () => 'activated' as const);
		const navigate = vi.fn();

		await expect(requestLibraryViewFromSettings('timeline', {
			pathname: '/library',
			currentView: 'classic',
			availableViews: ['classic', 'timeline'],
			requestActiveView,
			navigate
		})).resolves.toBe('requested');
		expect(requestActiveView).toHaveBeenCalledWith('timeline');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('uses one normal route navigation with requested mode page state off Library', async () => {
		const requestActiveView = vi.fn(async () => 'activated' as const);
		const navigate = vi.fn().mockResolvedValue(undefined);

		await expect(requestLibraryViewFromSettings('timeline', {
			pathname: '/queue',
			currentView: 'classic',
			availableViews: ['classic', 'timeline'],
			requestActiveView,
			navigate
		})).resolves.toBe('navigated');
		expect(requestActiveView).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith('/library', {
			state: {
				libraryRequest: {
					libraryView: 'timeline',
					schemaVersion: 1
				}
			}
		});
	});

	it('rejects gated and same-view choices without side effects', async () => {
		const requestActiveView = vi.fn(async () => 'activated' as const);
		const navigate = vi.fn();
		const base = {
			pathname: '/library',
			currentView: 'classic' as const,
			availableViews: ['classic'] as const,
			requestActiveView,
			navigate
		};

		await expect(requestLibraryViewFromSettings('timeline', base)).resolves.toBe('unavailable');
		await expect(requestLibraryViewFromSettings('classic', base)).resolves.toBe('unchanged');
		expect(requestActiveView).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('reports a missing active host without mutating route state', async () => {
		const requestActiveView = vi.fn(() => null);
		const navigate = vi.fn();

		await expect(requestLibraryViewFromSettings('timeline', {
			pathname: '/library',
			currentView: 'classic',
			availableViews: ['classic', 'timeline'],
			requestActiveView,
			navigate
		})).resolves.toBe('host-unavailable');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('reports a failed activation while treating a superseded request as non-error', async () => {
		const navigate = vi.fn();
		const base = {
			pathname: '/library',
			currentView: 'classic' as const,
			availableViews: ['classic', 'timeline'] as const,
			navigate
		};

		await expect(requestLibraryViewFromSettings('timeline', {
			...base,
			requestActiveView: vi.fn(async () => 'failed' as const)
		})).resolves.toBe('activation-failed');
		await expect(requestLibraryViewFromSettings('timeline', {
			...base,
			requestActiveView: vi.fn(async () => 'superseded' as const)
		})).resolves.toBe('requested');
		expect(navigate).not.toHaveBeenCalled();
	});
});
