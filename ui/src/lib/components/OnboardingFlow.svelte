<script lang="ts">
	import { onMount } from 'svelte';
	import { ROON_EXTENSION_DISPLAY_NAME } from '@shared/types';
	import {
		deriveOnboardingFlow,
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
	import { loadZones, zonesStore } from '$lib/stores/zonesStore';
	import { setSelectedZone } from '$lib/stores/selectedZoneStore';
	import { socketStatusStore } from '$lib/stores/socketStatusStore';

	/**
	 * How often the local-playback step re-reads the zone list. Zones also
	 * arrive live over the socket; this is the belt-and-braces path for the
	 * one case that matters here — a Roon Bridge installed while this step
	 * is on screen — so it is deliberately slow.
	 */
	const ZONE_POLL_INTERVAL_MS = 5000;

	/**
	 * Latched by this component, not derived, so a zone disappearing later
	 * in the session cannot reopen the flow over a working app.
	 */
	let completed = $state(false);
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
		completed = true;
	});

	// Poll the zone list only while the local-playback step is on screen.
	$effect(() => {
		if (!flow.active || flow.step !== 'local-playback') return;
		const timer = setInterval(() => {
			// A failed refresh is not the user's problem: the socket push
			// path is still live, and the step is skippable regardless.
			void loadZones(fetch).catch(() => undefined);
		}, ZONE_POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	function skipLocalPlayback(): void {
		completed = true;
	}
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
			{#if flow.step === 'connect'}
				<p class="eyebrow">Step 1 of 2</p>
				<h1 id="onboarding-title">Connect to your Roon Core</h1>
				<p class="lede">
					Open Roon on any device and go to <strong>Settings → Extensions</strong>. Find
					<strong>{ROON_EXTENSION_DISPLAY_NAME}</strong> in the list and choose
					<strong>Enable</strong>.
				</p>
				<p class="status" role="status" data-testid="onboarding-core-status">
					{#if $socketStatusStore !== 'connected'}
						Reconnecting…
					{:else if $coreStore.status === 'unpaired'}
						Your Roon Core disconnected. Enable the extension again in Roon to
						reconnect.
					{:else}
						Looking for your Roon Core. This screen moves on by itself once you
						enable the extension.
					{/if}
				</p>
			{:else}
				<p class="eyebrow">Step 2 of 2</p>
				<h1 id="onboarding-title">Play to this computer</h1>
				{#if hostname}
					<p class="lede">
						Roon can send audio straight to this computer. It is not an audio zone
						yet — installing <strong>Roon Bridge</strong> here makes it one, and Roon
						picks it up automatically.
					</p>
					<p class="status" role="status" data-testid="onboarding-zone-status">
						Watching for a zone called <strong>{hostname}</strong>…
					</p>
				{:else}
					<p class="lede">
						Roon can send audio straight to this computer. It is not an audio zone
						yet — installing <strong>Roon Bridge</strong> here makes it one, and Roon
						picks it up automatically.
					</p>
					<p class="status" role="status" data-testid="onboarding-zone-status">
						This computer's name could not be read, so the new zone won't be picked
						up on its own. Choose it from the zone list once it appears.
					</p>
				{/if}
				<div class="actions">
					<a
						class="primary"
						href={ROON_DOWNLOADS_URL}
						target="_blank"
						rel="noreferrer noopener"
					>
						Get Roon Bridge for {platformLabel(platform)}
					</a>
					<button type="button" class="secondary" onclick={skipLocalPlayback}>
						Skip for now
					</button>
				</div>
				<p class="footnote">
					You can do this later — everything else works without it.
				</p>
			{/if}
		</div>
	</div>
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

	.onboarding-panel {
		width: min(560px, 100%);
		padding: 2rem;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
		border-radius: 16px;
		background: var(--surface-1, #0a0a0a);
		color: var(--text, #f2f2f2);
	}

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
		border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
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
		background: var(--accent, #c8a24a);
		color: #101010;
		font-weight: 600;
		text-decoration: none;
	}

	.secondary {
		border: 1px solid var(--border, rgba(255, 255, 255, 0.2));
		background: transparent;
		color: inherit;
	}

	.secondary:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.footnote {
		margin-top: 0.9rem;
		font-size: 0.78rem;
		opacity: 0.55;
	}
</style>
