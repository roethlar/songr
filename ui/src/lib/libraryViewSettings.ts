import { buildLibraryViewRequestPageStateEnvelope } from '$lib/libraryPageState';
import type { LibraryViewHostActivationOutcome } from '$lib/stores/libraryViewHostStore';
import type { LibraryView } from '$lib/stores/libraryViewStore';

export type LibraryViewSettingsRequestResult =
	| 'unchanged'
	| 'unavailable'
	| 'host-unavailable'
	| 'activation-failed'
	| 'requested'
	| 'navigated';

export interface LibraryViewSettingsRequestOptions {
	readonly pathname: string;
	readonly currentView: LibraryView | null;
	readonly availableViews: readonly LibraryView[];
	readonly requestActiveView: (
		view: LibraryView
	) => Promise<LibraryViewHostActivationOutcome> | null;
	readonly navigate: (
		url: '/library',
		options: { state: App.PageState }
	) => void | Promise<void>;
}

/**
 * Route a controlled Controller-settings selection without ever committing a
 * preference optimistically. The /library host owns the activation transaction
 * and persists only the mode it successfully commits.
 */
export async function requestLibraryViewFromSettings(
	requestedView: LibraryView,
	options: LibraryViewSettingsRequestOptions
): Promise<LibraryViewSettingsRequestResult> {
	if (!options.availableViews.includes(requestedView)) return 'unavailable';
	if (options.currentView === requestedView) return 'unchanged';

	if (options.pathname === '/library') {
		const activation = options.requestActiveView(requestedView);
		if (!activation) return 'host-unavailable';
		return (await activation) === 'failed' ? 'activation-failed' : 'requested';
	}

	await options.navigate('/library', {
		state: buildLibraryViewRequestPageStateEnvelope(requestedView)
	});
	return 'navigated';
}
