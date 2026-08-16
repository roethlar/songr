import type { LibraryView } from '$lib/stores/libraryViewStore';

export type AppShellPresentation = 'unified' | 'neutral';
export type TransportPresentation = 'unified' | 'hidden';

export interface AppShellContract {
	presentation: AppShellPresentation;
	fullBleedWorkspace: boolean;
	transportPresentation: TransportPresentation;
}

const UNIFIED_LIBRARY_SHELL = Object.freeze<AppShellContract>({
	presentation: 'unified',
	fullBleedWorkspace: true,
	transportPresentation: 'unified'
});

const NEUTRAL_LIBRARY_SHELL = Object.freeze<AppShellContract>({
	presentation: 'neutral',
	fullBleedWorkspace: false,
	transportPresentation: 'hidden'
});

export function resolveAppShellContract(
	pathname: string,
	activeLibraryView: LibraryView | null
): AppShellContract {
	if (pathname === '/library' && activeLibraryView === 'unified') {
		return UNIFIED_LIBRARY_SHELL;
	}
	return NEUTRAL_LIBRARY_SHELL;
}
