<script lang="ts">
	import { onMount, setContext, untrack } from 'svelte';
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
		clearShownLibraryAddress,
		libraryAddressNeedsRestore,
		recordShownLibraryAddress,
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
		// SvelteKit republishes page.url on every history traversal and never on
		// the app's own shallow writes, and the republished URL can still name
		// the route that mounted this static fallback. So page.url is only the
		// signal; the address bar says where history went, and the shown-address
		// record says whether the view is already there.
		void page.url;
		if (!mounted) return;
		const currentUrl = currentLibraryUrl();
		if (!libraryAddressNeedsRestore(currentUrl)) return;
		untrack(() => commitActivation('history-pop', currentUrl));
	});

	onMount(() => {
		const host = claimLibraryViewHost();
		mounted = true;
		recordShownLibraryAddress(currentLibraryUrl());
		host.publishActiveMode('unified');

		return () => {
			mounted = false;
			registeredLifecycle?.suspend();
			registeredLifecycle = null;
			clearShownLibraryAddress();
			host.release();
		};
	});
</script>

<UnifiedLibraryMode />
