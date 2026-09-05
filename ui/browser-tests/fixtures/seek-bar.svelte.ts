/**
 * Seek bar fixture — the half of songr #13 jsdom cannot judge.
 *
 * The Vitest suites prove the gesture logic (one seek per drag, at the release
 * position, cancelled drags send nothing) against a fake DOM with no layout
 * engine. What they cannot prove is the part the issue is actually about:
 * whether the control can be GRABBED. That is a question about painted pixels
 * versus hit-testable box — `elementFromPoint`, `getBoundingClientRect`, real
 * `:hover`, real pointer capture — and only a real engine answers it.
 *
 * Every name on this page is invented. No library content may appear here.
 */
import { mount } from 'svelte';
import '../../src/app.css';
import SeekBar from '../../src/lib/components/SeekBar.svelte';
import type { SeekCommand } from '../../src/lib/media/seekCommand';

const DURATION = 240;

const seeks: number[] = [];

/** Stands in for the socket: the gesture is what is under test, not the emit. */
const command: SeekCommand = {
	base: (_contextKey, serverPosition) => serverPosition,
	send: (_contextKey, seconds) => {
		seeks.push(seconds);
	}
};

document.documentElement.dataset.theme = 'dark';

mount(SeekBar, {
	target: document.querySelector('#transport-host') as HTMLElement,
	props: {
		variant: 'transport',
		position: 30,
		duration: DURATION,
		canSeek: true,
		contextKey: 'fixture-zone::Placeholder Track::240',
		command
	}
});

mount(SeekBar, {
	target: document.querySelector('#overlay-host') as HTMLElement,
	props: {
		variant: 'overlay',
		position: 30,
		duration: DURATION,
		canSeek: true,
		contextKey: 'fixture-zone::Placeholder Track::240',
		command
	}
});

const fixture = {
	duration: DURATION,
	seeks,
	reset() {
		seeks.length = 0;
	},
	/** The play bar publishes this; the page sets it to measure both densities. */
	setHitHeight(px: number) {
		(document.querySelector('#transport-host') as HTMLElement).style.setProperty(
			'--seek-hit-height',
			`${px}px`
		);
	}
};

declare global {
	interface Window {
		seekBarFixture: typeof fixture;
	}
}

window.seekBarFixture = fixture;
document.documentElement.dataset.fixtureReady = 'true';
