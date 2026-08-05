import type { LibraryView } from '$lib/stores/libraryViewStore';

export type AppShellPresentation = 'normal' | 'classic' | 'timeline' | 'unified' | 'neutral';
export type TransportPresentation = 'full' | 'compact' | 'unified' | 'hidden';

export interface AppShellContract {
	presentation: AppShellPresentation;
	showClassicChrome: boolean;
	allowClassicBrowseEffects: boolean;
	fullBleedWorkspace: boolean;
	transportPresentation: TransportPresentation;
}

const NORMAL_SHELL = Object.freeze<AppShellContract>({
	presentation: 'normal',
	showClassicChrome: true,
	allowClassicBrowseEffects: true,
	fullBleedWorkspace: false,
	transportPresentation: 'full'
});

const CLASSIC_LIBRARY_SHELL = Object.freeze<AppShellContract>({
	presentation: 'classic',
	showClassicChrome: true,
	allowClassicBrowseEffects: true,
	fullBleedWorkspace: false,
	transportPresentation: 'full'
});

const TIMELINE_LIBRARY_SHELL = Object.freeze<AppShellContract>({
	presentation: 'timeline',
	showClassicChrome: false,
	allowClassicBrowseEffects: false,
	fullBleedWorkspace: true,
	transportPresentation: 'compact'
});

const UNIFIED_LIBRARY_SHELL = Object.freeze<AppShellContract>({
	presentation: 'unified',
	showClassicChrome: false,
	allowClassicBrowseEffects: false,
	fullBleedWorkspace: true,
	transportPresentation: 'unified'
});

const NEUTRAL_LIBRARY_SHELL = Object.freeze<AppShellContract>({
	presentation: 'neutral',
	showClassicChrome: false,
	allowClassicBrowseEffects: false,
	fullBleedWorkspace: false,
	transportPresentation: 'hidden'
});

export function resolveAppShellContract(
	pathname: string,
	activeLibraryView: LibraryView | null
): AppShellContract {
	if (pathname !== '/library') return NORMAL_SHELL;
	if (activeLibraryView === 'classic') return CLASSIC_LIBRARY_SHELL;
	if (activeLibraryView === 'timeline') return TIMELINE_LIBRARY_SHELL;
	if (activeLibraryView === 'unified') return UNIFIED_LIBRARY_SHELL;
	return NEUTRAL_LIBRARY_SHELL;
}
