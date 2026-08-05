import { browser } from '$app/environment';
import {
	normalizeLibraryPageState,
	type TimelineLibraryPageState
} from '$lib/libraryPageState';

export const TIMELINE_PAGE_SESSION_STORAGE_KEY = 'roon-controller-timeline-page-state-v1';

export type TimelineSessionPageStateRead =
	| { readonly status: 'missing' }
	| { readonly status: 'valid'; readonly pageState: TimelineLibraryPageState }
	| { readonly status: 'invalid' }
	| { readonly status: 'unavailable' };

function normalizedTimelineState(value: unknown): TimelineLibraryPageState | null {
	const state = normalizeLibraryPageState(value);
	return state?.libraryView === 'timeline' ? state : null;
}

/** Read the last keyless Timeline target for this browser tab. */
export function readTimelineSessionPageState(): TimelineSessionPageStateRead {
	if (!browser) return { status: 'unavailable' };
	try {
		const raw = sessionStorage.getItem(TIMELINE_PAGE_SESSION_STORAGE_KEY);
		if (raw === null) return { status: 'missing' };
		const pageState = normalizedTimelineState(JSON.parse(raw));
		return pageState ? { status: 'valid', pageState } : { status: 'invalid' };
	} catch {
		return { status: 'unavailable' };
	}
}

export function getTimelineSessionPageState(): TimelineLibraryPageState | null {
	const result = readTimelineSessionPageState();
	return result.status === 'valid' ? result.pageState : null;
}

/** Persist only the strict Timeline PageState contract; live handles never enter storage. */
export function persistTimelineSessionPageState(value: unknown): boolean {
	const state = normalizedTimelineState(value);
	if (!state || !browser) return false;
	try {
		sessionStorage.setItem(TIMELINE_PAGE_SESSION_STORAGE_KEY, JSON.stringify(state));
		return true;
	} catch {
		return false;
	}
}
