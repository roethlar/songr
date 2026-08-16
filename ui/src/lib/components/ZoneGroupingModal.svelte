<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import { zoneGroupingStore, closeZoneGrouping } from '$lib/stores/zoneGroupingStore';
	import { zonesStore } from '$lib/stores/zonesStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { pushCommandFeedback } from '$lib/stores/commandFeedbackStore';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';

	/**
	 * Flattens all zones to a single { output_id, display_name,
	 * zone_id, zone_name } list so the user picks across zones.
	 * Each unique output appears once. The active zone's first
	 * output is pre-checked so saving without changes is a no-op
	 * (the user is implicitly grouping "the current zone" with
	 * whatever else they tick).
	 */
	const allOutputs = $derived.by(() => {
		const seen = new Set<string>();
		const items: Array<{
			output_id: string;
			display_name: string;
			zone_id: string;
			zone_name: string;
			/**
			 * Set ONLY when the output has exactly one supports_standby
			 * source_control. Per the ZoneOutput contract in
			 * src/shared/types.ts: a single control gets a direct
			 * button; multiple controls require a per-control affordance
			 * (nested menu) which this iteration doesn't ship. When
			 * undefined no button renders, so a multi-control output
			 * (e.g. one selected + one standby) can't be sent the wrong
			 * action via an "any control is asleep → wake everything"
			 * heuristic.
			 *
			 * `isInStandby` and `control_key` come straight from that
			 * one control, so the emit targets exactly it instead of
			 * fanning out across the output.
			 */
			powerControl?: { control_key: string; isInStandby: boolean };
		}> = [];
		for (const zone of $zonesStore) {
			for (const out of zone.outputs ?? []) {
				if (!out.output_id || seen.has(out.output_id)) continue;
				seen.add(out.output_id);
				const standbyControls =
					out.source_controls?.filter((c) => c.supports_standby) ?? [];
				const powerControl =
					standbyControls.length === 1
						? {
								control_key: standbyControls[0].control_key,
								isInStandby: standbyControls[0].status === 'standby'
							}
						: undefined;
				items.push({
					output_id: out.output_id,
					display_name: out.display_name,
					zone_id: zone.zone_id,
					zone_name: zone.display_name,
					powerControl
				});
			}
		}
		return items;
	});

	const activeZone = $derived(
		$selectedZoneStore ? $zonesStore.find((z) => z.zone_id === $selectedZoneStore) : undefined
	);

	let selectedOutputs = $state<Set<string>>(new Set());
	let submitting = $state(false);

	// Reset selection ONLY on the closed→open transition. Reviewer
	// caught (feat-5 reopen #1): the prior effect re-ran on every
	// zonesStore update (because it reads activeZone, derived from
	// zonesStore). A socket-driven zone refresh mid-selection would
	// clobber the user's checkbox state back to "active zone outputs
	// only". Track the previous open value and re-seed only when
	// transitioning false → true.
	let wasOpen = false;
	$effect(() => {
		const open = $zoneGroupingStore;
		if (open && !wasOpen) {
			const next = new Set<string>();
			for (const out of activeZone?.outputs ?? []) {
				if (out.output_id) next.add(out.output_id);
			}
			selectedOutputs = next;
		}
		wasOpen = open;
	});

	function toggleOutput(output_id: string): void {
		const next = new Set(selectedOutputs);
		if (next.has(output_id)) {
			next.delete(output_id);
		} else {
			next.add(output_id);
		}
		selectedOutputs = next;
	}

	/**
	 * Toggle power for a single supports_standby source control:
	 * - `transport:standby` is idempotent — a duplicate call against
	 *   an already-standby control is a no-op (won't wake it).
	 * - `transport:wake` (convenience_switch) wakes the control and
	 *   selects its source.
	 * Always passes `control_key` so the backend acts on exactly the
	 * control the button represents (matches the types.ts contract:
	 * the direct button only exists when there is exactly one
	 * supports_standby control on the output).
	 */
	async function togglePower(
		output_id: string,
		control_key: string,
		isInStandby: boolean
	): Promise<void> {
		const socket = getSocket();
		if (!socket) {
			pushCommandFeedback({
				source: 'transport',
				command: isInStandby ? 'transport:wake' : 'transport:standby',
				message: 'Realtime connection unavailable.'
			});
			return;
		}
		const event = isInStandby ? 'transport:wake' : 'transport:standby';
		await emitWithAck(
			socket,
			event,
			{ output_id, control_key },
			{ timeoutMs: 5000, feedback: { source: 'transport', command: event } }
		);
		// State update is server-driven: the next zones broadcast
		// reflects the new source_control status. We don't optimistically
		// flip isInStandby because Roon may reject the request (e.g.
		// network-level error) — let the server be the source of truth.
	}

	async function save(): Promise<void> {
		if (selectedOutputs.size < 2 || submitting) return;
		const socket = getSocket();
		if (!socket) {
			pushCommandFeedback({
				source: 'transport',
				command: 'transport:group',
				message: 'Realtime connection unavailable.'
			});
			return;
		}
		submitting = true;
		try {
			// emitWithAck contract: resolves with AckResponse<T>, never
			// rejects for server-side failures (timeout, malformed ack,
			// disconnected, server-reported error). Inspect the result
			// and keep the modal open on failure so the user can retry
			// without losing their selection. The `feedback` option
			// already surfaces a toast via commandFeedbackStore — we
			// just preserve the dialog state.
			const response = await emitWithAck(
				socket,
				'transport:group',
				{ output_ids: Array.from(selectedOutputs) },
				{
					timeoutMs: 5000,
					feedback: { source: 'transport', command: 'transport:group' }
				}
			);
			if (response.success) {
				closeZoneGrouping();
			}
			// else: stay open, selection preserved, toast handled by
			// emitWithAck's feedback option.
		} finally {
			submitting = false;
		}
	}

	function onBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) closeZoneGrouping();
	}

	// Esc closes; Tab cycling stays inside the dialog (same pattern
	// as NowPlayingOverlay).
	let dialogEl: HTMLDivElement | null = $state(null);
	let previouslyFocused: HTMLElement | null = null;

	onMount(() => {
		const handler = (e: KeyboardEvent) => {
			if (!get(zoneGroupingStore)) return;
			if (e.key === 'Escape') {
				closeZoneGrouping();
			} else if (e.key === 'Tab' && dialogEl) {
				const focusables = Array.from(
					dialogEl.querySelectorAll<HTMLElement>(
						'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
					)
				);
				if (focusables.length === 0) {
					e.preventDefault();
					dialogEl.focus();
					return;
				}
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				const active = document.activeElement as HTMLElement | null;
				if (e.shiftKey && active === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && active === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	});

	$effect(() => {
		const open = $zoneGroupingStore;
		if (open) {
			previouslyFocused = document.activeElement as HTMLElement | null;
			void tick().then(() => {
				if (!dialogEl) return;
				const close = dialogEl.querySelector<HTMLElement>('.zg-close');
				(close ?? dialogEl).focus();
			});
		} else if (previouslyFocused && document.body.contains(previouslyFocused)) {
			previouslyFocused.focus();
			previouslyFocused = null;
		}
	});
</script>

{#if $zoneGroupingStore}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="zg-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="Group zones"
		tabindex="-1"
		bind:this={dialogEl}
		onclick={onBackdropClick}
	>
		<div class="zg-dialog">
			<header class="zg-header">
				<h2>Group zones</h2>
				<button
					type="button"
					class="zg-close"
					onclick={closeZoneGrouping}
					aria-label="Close group zones"
				>✕</button>
			</header>

			<p class="zg-hint">
				Pick the outputs to group into one synchronized zone.
				Roon preserves the first output's queue.
			</p>

			<ul class="zg-list" aria-label="Available outputs">
				{#each allOutputs as out}
					<li class="zg-li">
						<label class="zg-row">
							<input
								type="checkbox"
								checked={selectedOutputs.has(out.output_id)}
								onchange={() => toggleOutput(out.output_id)}
							/>
							<span class="zg-name">{out.display_name}</span>
							<span class="zg-zone">{out.zone_name}</span>
						</label>
						{#if out.powerControl}
							{@const pc = out.powerControl}
							<button
								type="button"
								class="zg-power"
								class:zg-power-standby={pc.isInStandby}
								onclick={() => togglePower(out.output_id, pc.control_key, pc.isInStandby)}
								aria-label={pc.isInStandby
									? `Wake ${out.display_name}`
									: `Standby ${out.display_name}`}
								title={pc.isInStandby
									? `Wake ${out.display_name}`
									: `Standby ${out.display_name}`}
							>⏻</button>
						{/if}
					</li>
				{/each}
				{#if allOutputs.length === 0}
					<li class="zg-empty">No outputs available.</li>
				{/if}
			</ul>

			<footer class="zg-footer">
				<button
					type="button"
					class="zg-btn zg-btn-secondary"
					onclick={closeZoneGrouping}
				>Cancel</button>
				<button
					type="button"
					class="zg-btn zg-btn-primary"
					onclick={save}
					disabled={selectedOutputs.size < 2 || submitting}
					aria-label="Group selected outputs"
				>{submitting ? 'Grouping…' : 'Group'}</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.zg-backdrop {
		position: fixed;
		inset: 0;
		background: var(--songr-scrim);
		display: grid;
		place-items: center;
		z-index: 1000;
		padding: 1rem;
	}

	.zg-dialog {
		background: var(--songr-panel);
		color: var(--songr-text);
		border: 1px solid var(--songr-line);
		border-radius: 12px;
		max-width: 480px;
		width: 100%;
		padding: 1.25rem;
		box-shadow: 0 22px 52px var(--songr-shadow-soft);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.zg-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.zg-header h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.zg-close {
		background: transparent;
		border: 0;
		color: inherit;
		font-size: 1.1rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		border-radius: 6px;
	}
	.zg-close:hover {
		background: var(--songr-raise);
	}

	.zg-hint {
		margin: 0;
		color: var(--songr-soft);
		font-size: 0.85rem;
	}

	.zg-list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 50vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	/* Each list item is a row; the row's label spans the full
	   width when no power button is present, otherwise sits alongside
	   the power button. */
	.zg-li {
		display: flex;
		align-items: stretch;
		gap: 0.4rem;
	}

	.zg-row {
		flex: 1;
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0.6rem;
		align-items: center;
		padding: 0.55rem 0.6rem;
		border-radius: 8px;
		cursor: pointer;
		background: var(--songr-raise);
	}
	.zg-row:hover {
		background: var(--songr-hover);
	}

	.zg-power {
		flex-shrink: 0;
		width: 36px;
		background: var(--songr-raise);
		color: var(--songr-soft);
		border: 1px solid var(--songr-line-12);
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.95rem;
	}
	.zg-power:hover {
		background: var(--songr-hover);
		color: var(--songr-text);
	}
	/* Visual cue: outputs currently in standby get a muted-accent
	   highlight so the user knows "click to wake" vs "click to sleep". */
	.zg-power-standby {
		color: var(--songr-accent-bright);
		background: color-mix(in srgb, var(--songr-accent) 14%, transparent);
	}
	.zg-power-standby:hover {
		background: color-mix(in srgb, var(--songr-accent) 26%, transparent);
	}

	.zg-name {
		font-weight: 600;
	}

	.zg-zone {
		font-size: 0.8rem;
		color: var(--songr-soft);
	}

	.zg-empty {
		padding: 1rem;
		text-align: center;
		color: var(--songr-soft);
	}

	.zg-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.zg-btn {
		padding: 0.5rem 1rem;
		border-radius: 8px;
		border: 0;
		cursor: pointer;
		font-weight: 600;
	}
	.zg-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.zg-btn-secondary {
		background: var(--songr-raise);
		border: 1px solid var(--songr-line-12);
		color: inherit;
	}
	.zg-btn-primary {
		background: var(--songr-accent);
		color: var(--songr-on-accent);
	}
</style>
