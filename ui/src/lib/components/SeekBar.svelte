<!--
  The seek control, once, for every surface that has one.

  It was written out twice — inline in `+layout.svelte`'s play bar and again
  in `NowPlayingOverlay.svelte` — and neither copy could actually be dragged:
  both wired `role="slider"` to `onclick` alone, so the control looked like a
  scrubber, carried a slider's ARIA contract, and answered a press-and-drag by
  jumping once to wherever the pointer happened to be released (songr #13).
  A control on screen that does not do what it looks like it does is the one
  thing this UI may not ship.

  Dragging is real pointer-event scrubbing here: pointerdown captures the
  pointer, pointermove drives a local scrub position so the thumb follows the
  finger, and exactly one seek is sent on release. Only `clientX` is read, so
  a drag that strays vertically off the strip — which is most of them, on a
  3px-tall target — keeps scrubbing instead of being lost.

  The interactive box is deliberately taller than the painted track: the extra
  height is transparent, so the target is easy to hit without changing what is
  drawn. On the play bar that height is bounded by the footer's own bottom
  padding — reach past it and the control starts eating the transport row
  above — so the footer publishes it as `--seek-hit-height` next to the
  padding it derives from, and it differs by density.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { formatTime } from '$lib/formatTime';
	import { createSeekCommand, type SeekCommand } from '$lib/media/seekCommand';
	import { seekTargetForKey } from '$lib/seekKeys';

	interface Props {
		/** Server-fed position, in seconds. Ignored while a drag is in flight. */
		position: number;
		/** Track length in seconds; 0 when nothing is playing. */
		duration: number;
		/** Whether the zone allows seeking at all. */
		canSeek: boolean;
		/**
		 * Zone + track identity, for the optimistic base a held arrow key
		 * steps from. `null` disables the optimistic base.
		 */
		contextKey: string | null;
		/** `transport` is the play bar's strip; `overlay` is the modal's bar. */
		variant: 'transport' | 'overlay';
		/** Test seam: a recording command in place of the socket. */
		command?: SeekCommand;
	}

	let { position, duration, canSeek, contextKey, variant, command }: Props = $props();

	/** Each mounted seek bar owns one optimistic base, exactly as the two
	 *  inline copies did — created on first use so a surface that never
	 *  seeks never builds one, and never in place of an injected command. */
	let ownCommand: SeekCommand | null = null;
	function seek(): SeekCommand {
		if (command) return command;
		ownCommand ??= createSeekCommand();
		return ownCommand;
	}

	let element = $state<HTMLDivElement | null>(null);
	/** Non-null only while a drag is in flight; the fraction under the pointer. */
	let dragFraction = $state<number | null>(null);
	let dragPointerId: number | null = null;

	const displayPosition = $derived(
		dragFraction === null ? position : dragFraction * duration
	);
	const progress = $derived(
		duration > 0 ? Math.max(0, Math.min(displayPosition / duration, 1)) : 0
	);
	const valueMax = $derived(Math.max(0, Math.floor(duration)));
	const valueNow = $derived(Math.max(0, Math.min(Math.floor(displayPosition), valueMax)));

	function fractionAt(clientX: number): number {
		const rect = element?.getBoundingClientRect();
		if (!rect || rect.width === 0) return 0;
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	}

	function endDrag(): void {
		dragPointerId = null;
		dragFraction = null;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerCancel);
	}

	function onPointerMove(event: PointerEvent): void {
		if (dragPointerId === null || event.pointerId !== dragPointerId) return;
		// Only the x axis: a scrub that wanders off a 3px strip vertically is
		// still a scrub, and losing it there is what makes thin sliders feel
		// broken.
		dragFraction = fractionAt(event.clientX);
	}

	function onPointerUp(event: PointerEvent): void {
		if (dragPointerId === null || event.pointerId !== dragPointerId) return;
		const fraction = fractionAt(event.clientX);
		endDrag();
		if (!canSeek || !duration) return;
		// Exactly one seek per gesture, at the release position. A plain click
		// is just a drag of zero length, so there is no separate click path to
		// double-emit with.
		seek().send(contextKey, Math.floor(fraction * duration));
	}

	function onPointerCancel(event: PointerEvent): void {
		if (dragPointerId === null || event.pointerId !== dragPointerId) return;
		// A cancelled gesture is not a seek: drop the scrub and let the server
		// position take the thumb back.
		endDrag();
	}

	function onPointerDown(event: PointerEvent): void {
		if (!canSeek || !duration) return;
		// Primary button only; a right-click is not a scrub.
		if (event.button !== 0) return;
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		dragPointerId = event.pointerId;
		dragFraction = fractionAt(event.clientX);
		// Capture keeps the gesture ours once the pointer leaves the strip.
		// The window listeners below are what actually drives it — capture
		// retargets events but they still bubble — so a browser without it
		// (or jsdom) drags correctly all the same.
		if (typeof target.setPointerCapture === 'function') {
			try {
				target.setPointerCapture(event.pointerId);
			} catch {
				// Capture is an optimization, never a requirement.
			}
		}
		// `preventDefault` above suppressed the focus a press would normally
		// give the slider, and a focused slider is what makes the arrow keys
		// work after a click.
		target.focus?.();
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerCancel);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (!canSeek || !duration) return;
		const target = seekTargetForKey(event.key, seek().base(contextKey, position), duration);
		if (target === null) return;
		event.preventDefault();
		seek().send(contextKey, target);
	}

	onDestroy(() => {
		if (dragPointerId !== null) endDrag();
	});
</script>

<div
	bind:this={element}
	class="seek seek-{variant}"
	class:seekable={canSeek}
	class:dragging={dragFraction !== null}
	data-seek-variant={variant}
	role="slider"
	tabindex={canSeek ? 0 : -1}
	aria-label="Seek"
	aria-valuemin={0}
	aria-valuemax={valueMax}
	aria-valuenow={valueNow}
	aria-valuetext="{formatTime(displayPosition)} of {formatTime(duration)}"
	aria-disabled={!canSeek}
	onpointerdown={onPointerDown}
	onkeydown={onKeydown}
>
	<div class="seek-track"><div class="seek-fill" style:width={`${progress * 100}%`}></div></div>
</div>

<style>
	.seek {
		display: flex;
		/* The whole box is the target, so a touch drag on it must scrub
		   rather than scroll the page. */
		touch-action: none;
	}

	.seek.seekable {
		cursor: pointer;
	}

	.seek-track {
		width: 100%;
		background: var(--songr-hover);
		transition: height 80ms ease;
	}

	.seek-fill {
		height: 100%;
		background: var(--songr-accent);
	}

	/* --- play bar ------------------------------------------------------ */

	/* Pinned to the footer's bottom edge, spanning its full width. The
	   interactive height comes from the footer, which derives it from its own
	   bottom padding (10px by default, 14px at Pi touch density): anything
	   taller would reach up into the transport-controls row. */
	.seek-transport {
		position: absolute;
		inset: auto 0 0;
		align-items: flex-end;
		height: var(--seek-hit-height, 10px);
	}

	.seek-transport .seek-track {
		height: 3px;
	}

	.seek-transport.seekable:hover .seek-track,
	.seek-transport.dragging .seek-track,
	.seek-transport:focus-visible .seek-track {
		height: 5px;
	}

	/* A keyboard-focusable slider needs a visible focus ring; this one had
	   `outline: 0` and no replacement, which predates the hit-area work. The
	   ring is inset because the strip sits flush against the footer's edge. */
	.seek-transport:focus-visible {
		outline: 2px solid var(--songr-accent-bright);
		outline-offset: -2px;
	}

	/* --- Now Playing overlay ------------------------------------------- */

	/* 6px of painted track centred in an 18px target. The margins give back
	   the 6px added above and below, so the modal's vertical rhythm is
	   unchanged and the extra height is purely target area. The fill is an
	   in-flow block inside the track rather than an absolutely-positioned
	   overlay, which is what lets the track keep its rounded caps while the
	   box around it grows. */
	.seek-overlay {
		align-items: center;
		height: 18px;
		margin-top: calc(1rem - 6px);
		margin-bottom: -6px;
		cursor: default;
	}

	.seek-overlay .seek-track {
		height: 6px;
		border-radius: 3px;
	}

	.seek-overlay .seek-fill {
		border-radius: 3px;
	}

	.seek-overlay:focus-visible {
		outline: 2px solid var(--songr-accent-bright);
		outline-offset: 2px;
	}
</style>
