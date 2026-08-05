import type { Component } from 'svelte';
import {
	createLibraryViewLoaderController,
	type LibraryViewLoaderController,
	type LibraryViewLoaders
} from '$lib/libraryViewLoaderController';
import { resolveAvailableLibraryView } from '$lib/stores/libraryViewStore';

export type LibraryModeComponent = Component;

export const PRODUCTION_LIBRARY_VIEW_LOADERS: LibraryViewLoaders<LibraryModeComponent> =
	Object.freeze({
		classic: async () => (await import('./ClassicLibraryMode.svelte')).default,
		timeline: async () => (await import('./TimelineLibraryMode.svelte')).default,
		unified: async () => (await import('./UnifiedLibraryMode.svelte')).default
	});

export function createProductionLibraryViewLoaderController(): LibraryViewLoaderController<LibraryModeComponent> {
	return createLibraryViewLoaderController({
		loaders: PRODUCTION_LIBRARY_VIEW_LOADERS,
		resolveMode: resolveAvailableLibraryView
	});
}
