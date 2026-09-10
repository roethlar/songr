<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import { get } from 'svelte/store';
	import { unifiedLibraryPrefsStore } from '$lib/stores/unifiedLibraryPrefsStore';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		type LibraryViewActivationCause
	} from '$lib/libraryPageState';
	import { decodeLibraryRoute, encodeLibraryRoute } from '$lib/libraryRoute';
	import { libraryEntryPageState } from '$lib/libraryRouteState';
	import {
		clearPendingLibraryPageStateWrite,
		consumeSelfAuthoredLibraryPageState,
		replaceLibraryPageState
	} from '$lib/libraryPageNavigation';
	import {
		LIBRARY_MODE_ACTIVATION_CONTEXT,
		type CommittedLibraryModeActivation,
		type LibraryModeLifecycle
	} from '$lib/libraryModeActivationContext';
	import { claimLibraryViewHost } from '$lib/stores/libraryViewHostStore';
	import type { LibraryView } from '$lib/libraryView';
	import UnifiedLibraryMode from './UnifiedLibraryMode.svelte';

	let mounted = false;
	function pageStateFromUrl(url: URL = page.url) {
		return libraryEntryPageState(url, get(unifiedLibraryPrefsStore).artistView);
	}

	function currentLibraryUrl(): URL {
		const browserUrl = new URL(window.location.href);
		return browserUrl.pathname === '/library' || browserUrl.pathname.startsWith('/library/')
			? browserUrl
			: page.url;
	}

	let observedPageUrl = page.url.href;
	let committedActivation: CommittedLibraryModeActivation = {
		cause: 'initial',
		pageState: pageStateFromUrl()
	};
	let registeredLifecycle: LibraryModeLifecycle | null = null;
	let initialNavigationHandled = false;

	function commitActivation(cause: LibraryViewActivationCause, url: URL = page.url): void {
		const pageState = pageStateFromUrl(url);
		registeredLifecycle?.suspend();
		committedActivation = { cause, pageState };
		registeredLifecycle?.resume(committedActivation);
	}

	setContext(LIBRARY_MODE_ACTIVATION_CONTEXT, {
		committedActivation: () => committedActivation,
		registerLifecycle(mode: LibraryView, lifecycle: LibraryModeLifecycle): () => void {
			if (mode !== 'unified') throw new TypeError('Only Unified Library can register');
			registeredLifecycle?.suspend();
			registeredLifecycle = lifecycle;
			lifecycle.resume(committedActivation);
			return () => {
				if (registeredLifecycle !== lifecycle) return;
				lifecycle.suspend();
				registeredLifecycle = null;
			};
		}
	});

	afterNavigate(() => {
		if (!mounted || initialNavigationHandled) return;
		initialNavigationHandled = true;
		const route = decodeLibraryRoute(page.url);
		const current = `${page.url.pathname}${page.url.search}`;
		if (route === null || encodeLibraryRoute(route) !== current) {
			replaceLibraryPageState(committedActivation.pageState);
		}
	});

	$effect(() => {
		// SvelteKit republishes `page` for shallow traversal, but its URL can
		// still describe the route that mounted this static fallback. The
		// address bar is authoritative for these same-document Library pages.
		void page.url.href;
		const currentUrl = mounted ? currentLibraryUrl() : page.url;
		const currentPageUrl = currentUrl.href;
		if (!mounted || currentPageUrl === observedPageUrl) return;
		observedPageUrl = currentPageUrl;
		if (consumeSelfAuthoredLibraryPageState(currentUrl)) return;
		commitActivation('history-pop', currentUrl);
	});

	onMount(() => {
		const host = claimLibraryViewHost();
		mounted = true;
		host.publishActiveMode('unified');

		return () => {
			mounted = false;
			registeredLifecycle?.suspend();
			registeredLifecycle = null;
			clearPendingLibraryPageStateWrite();
			host.release();
		};
	});
</script>

<UnifiedLibraryMode />
