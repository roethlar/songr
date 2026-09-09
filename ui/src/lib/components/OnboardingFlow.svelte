<script lang="ts">
	import { onMount } from 'svelte';
	import { ROON_EXTENSION_DISPLAY_NAME } from '@shared/types';
	import {
		deriveOnboardingFlow,
		findLocalZoneId,
		type OnboardingFlowState
	} from '$lib/onboarding/onboardingFlow';
	import {
		ROON_DOWNLOADS_URL,
		detectCurrentPlatform,
		platformLabel
	} from '$lib/onboarding/platform';
	import {
		loadOnboardingStatus,
		onboardingStatusStore
	} from '$lib/stores/onboardingStore';
	import { coreStore } from '$lib/stores/coreStore';
	import { zonesStore } from '$lib/stores/zonesStore';
	import { setSelectedZone } from '$lib/stores/selectedZoneStore';
	import { socketStatusStore } from '$lib/stores/socketStatusStore';
	import { CORE_DISCOVERY_WAIT_MS, type DiscoveredCore } from '@shared/coreDiscovery';
	import { coreDiscoveryStore, loadCoreDiscovery } from '$lib/stores/coreDiscoveryStore';

	/**
	 * Latched by this component, not derived, so a zone disappearing later
	 * in the session cannot reopen the flow over a working app.
	 */
	let completed = $state(false);
	let showBridgeNote = $state(false);
	const platform = detectCurrentPlatform();

	const flow = $derived<OnboardingFlowState>(
		deriveOnboardingFlow({
			everPaired: $onboardingStatusStore.everPaired,
			coreStatus: $coreStore.status,
			hostname: $onboardingStatusStore.hostname,
			zones: $zonesStore,
			completed
		})
	);

	const hostname = $derived($onboardingStatusStore.hostname);
	const cores = $derived($coreDiscoveryStore?.cores ?? []);
	const awaitingApproval = $derived(cores.some((core) => core.phase === 'awaiting-approval'));
	const connected = $derived($socketStatusStore === 'connected');
	const waitingWithoutCore = $derived(
		flow.active && flow.step === 'connect' && connected && $coreDiscoveryStore !== null && cores.length === 0
	);
	let discoveryWaitElapsed = $state(false);

	$effect(() => {
		if (flow.active && flow.step === 'connect' && connected) void loadCoreDiscovery(fetch);
	});

	$effect(() => {
		discoveryWaitElapsed = false;
		if (!waitingWithoutCore) return;
		const timer = setTimeout(() => { discoveryWaitElapsed = true; }, CORE_DISCOVERY_WAIT_MS);
		return () => clearTimeout(timer);
	});

	function phaseLabel(core: DiscoveredCore): string {
		switch (core.phase) {
			case 'connecting': return 'Discovered · Connecting…';
			case 'registering': return 'Connected · Reading Core identity…';
			case 'awaiting-approval': return 'Connected · Waiting for approval in Roon';
			case 'registered': return 'Extension enabled · Waiting for pairing';
			case 'failed': return core.detail ?? 'Connection to this Core failed.';
		}
	}

	onMount(() => {
		// Read once. The store latches the answer; see onboardingStore.
		void loadOnboardingStatus(fetch);
	});

	// The flow's only mutation of app state: adopt the zone that plays to
	// this computer, exactly once, and only on a genuine first run. It runs
	// after the zone has actually appeared in the live list — never
	// optimistically ahead of the server's answer, per the repo's
	// readiness-before-mutation rule.
	$effect(() => {
		if (!flow.firstRun || completed || flow.step !== 'complete') return;
		if (flow.localZoneId) setSelectedZone(flow.localZoneId);
		showBridgeNote = !flow.localZoneId;
		completed = true;
	});

	// An arriving Bridge can dismiss the optional note, but cannot hold up
	// setup or change the zone the user has selected after setup finished.
	$effect(() => {
		if (findLocalZoneId($zonesStore, hostname)) showBridgeNote = false;
	});
</script>

{#if flow.active}
	<div
		class="onboarding-scrim"
		role="dialog"
		aria-modal="true"
		aria-labelledby="onboarding-title"
		data-testid="onboarding-flow"
		data-onboarding-step={flow.step}
	>
		<div class="onboarding-panel">
				<p class="eyebrow">Welcome to Songr</p>
				<h1 id="onboarding-title">Connect to your Roon Core</h1>
				{#if !connected}
					<p class="lede">Reconnecting to Songr. Core discovery status is unavailable until the connection returns.</p>
				{:else if $coreDiscoveryStore === null}
					<p class="lede">Checking Core discovery status…</p>
				{:else if cores.length === 0}
					<p class="lede">
						{#if discoveryWaitElapsed}
							No Roon Core found yet. Songr has not received a Core discovery response.
						{:else}
							Searching your local network for a Roon Core…
						{/if}
					</p>
				{:else}
					<ul class="discovered-cores" aria-label="Discovered Roon Cores">
						{#each cores as core (core.id)}
							<li>
								<strong>{core.displayName}</strong>
								<span class="core-address">{core.host}</span>
								<p class:connection-failed={core.phase === 'failed'}>{phaseLabel(core)}</p>
							</li>
						{/each}
					</ul>
				{/if}
				{#if connected && awaitingApproval}
				<p class="lede" data-testid="onboarding-approval-instructions">
					Open Roon on any device and go to <strong>Settings → Extensions</strong>. Find
					<!-- The server registers as "Songr (<host>)" so several instances
					     paired to one Core stay tellable-apart; show the exact label
					     when the hostname is known. -->
					<strong
						>{hostname
							? `${ROON_EXTENSION_DISPLAY_NAME} (${hostname})`
							: ROON_EXTENSION_DISPLAY_NAME}</strong
					> in the list and choose
					<strong>Enable</strong>.
				</p>
				{/if}
				{#if connected && $coreDiscoveryStore?.error}
					<p class="connection-failed" role="status">{$coreDiscoveryStore.error}</p>
				{/if}
				{#if connected && (discoveryWaitElapsed || cores.some((core) => core.phase === 'failed') || $coreDiscoveryStore?.error)}
					<div class="discovery-help">
						<p>Check that Roon Server is running and this computer is on the same local network.</p>
						<p>A firewall such as UFW, a VPN, or a guest network can block Roon discovery (UDP port 9003) or the connection to the Core. Check that your firewall permits Roon traffic on your local network.</p>
						<p>Songr cannot determine whether a firewall is blocking traffic. It will keep searching and update this screen automatically.</p>
					</div>
				{/if}
				<p class="status" role="status" data-testid="onboarding-core-status">
					{#if !connected}
						Reconnecting…
					{:else if awaitingApproval}
						Approval requested. This screen moves on automatically when you enable Songr in Roon.
					{:else if $coreDiscoveryStore === null}
						Waiting for discovery status from Songr…
					{:else if cores.length > 0}
						{cores.length} {cores.length === 1 ? 'Core discovered' : 'Cores discovered'}. Connection progress appears above.
					{:else}
						Looking for your Roon Core. Approval instructions will appear once Songr connects to it.
					{/if}
				</p>
		</div>
	</div>
{/if}

{#if showBridgeNote}
	<aside class="bridge-note" aria-label="Optional local playback" data-testid="onboarding-bridge-note">
		<h2>Want to play music on this computer?</h2>
		<p>Songr is ready to use. For local playback, download and install <strong>Roon Bridge</strong> on this computer, then enable its audio output in Roon → Settings → Audio.</p>
		<div class="actions">
			<a class="primary" href={ROON_DOWNLOADS_URL} target="_blank" rel="noreferrer noopener">
				Get Roon Bridge for {platformLabel(platform)}
			</a>
			<button type="button" class="secondary" onclick={() => { showBridgeNote = false; }}>Dismiss</button>
		</div>
	</aside>
{/if}

<style>
	.onboarding-scrim {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 1.5rem;
		background: #000;
	}

	/* Self-contained palette, no theme tokens. This surface renders before
	   any theme preference exists, on a hardcoded black scrim; inheriting
	   the theme's text token painted near-black text on black whenever the
	   OS was in light mode (the theme initializer follows
	   prefers-color-scheme), which made the first-run pairing screen
	   unreadable. Guarded by OnboardingFlow.test.ts. */
	.onboarding-panel {
		width: min(560px, 100%);
		max-height: calc(100dvh - 3rem);
		overflow-y: auto;
		padding: 2rem;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 16px;
		background: #0a0a0a;
		color: #f2f2f2;
	}

	.discovered-cores {
		list-style: none;
		padding: 0;
		margin: 1rem 0;
	}

	.discovered-cores li {
		padding: 0.8rem 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.14);
		overflow-wrap: anywhere;
	}

	.discovered-cores p { margin: 0.4rem 0 0; font-size: 0.87rem; }
	.core-address { display: block; opacity: 0.6; font-size: 0.8rem; margin-top: 0.2rem; }
	.connection-failed { color: #f3ba9c; }
	.discovery-help { font-size: 0.87rem; line-height: 1.5; color: #d6d6d6; }
	.discovery-help p + p { margin-top: 0.65rem; }

	.bridge-note {
		position: fixed;
		z-index: 50;
		right: 1.5rem;
		bottom: 6rem;
		width: min(420px, calc(100vw - 3rem));
		max-height: 50dvh;
		overflow-y: auto;
		box-sizing: border-box;
		padding: 1.25rem;
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 12px;
		background: #141414;
		color: #f2f2f2;
		font-size: 0.87rem;
		line-height: 1.5;
	}

	.bridge-note h2 { margin: 0; font-size: 1rem; }
	.bridge-note p { margin: 0.6rem 0 1rem; }

	.eyebrow {
		font-size: 0.7rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		opacity: 0.55;
	}

	h1 {
		margin: 0.4rem 0 0.9rem;
		font-size: 1.5rem;
		line-height: 1.2;
	}

	.lede {
		font-size: 0.95rem;
		line-height: 1.55;
		opacity: 0.88;
	}

	.status {
		margin-top: 1rem;
		padding: 0.7rem 0.85rem;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.04);
		font-size: 0.87rem;
		line-height: 1.45;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 1.2rem;
	}

	.primary,
	.secondary {
		padding: 0.55rem 1rem;
		border-radius: 9px;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.primary {
		border: 1px solid transparent;
		background: #c8a24a;
		color: #101010;
		font-weight: 600;
		text-decoration: none;
	}

	.secondary {
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: transparent;
		color: inherit;
	}

	.secondary:hover {
		background: rgba(255, 255, 255, 0.08);
	}

</style>
