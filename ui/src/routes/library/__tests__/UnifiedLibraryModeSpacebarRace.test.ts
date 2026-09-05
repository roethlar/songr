/**
 * The "a then immediate Space" race (public issue #2 follow-up).
 *
 * Typing a letter anywhere in the library opens the search palette; the
 * app-wide Space shortcut toggles play/pause. Between those two, one turn of
 * the event loop is dangerous: the "a" keydown flips `paletteOpen`, but the
 * palette's aria-modal dialog only reaches the DOM on the next flush, and
 * focus only lands in its input after that. A Space arriving in that same
 * turn must already belong to the palette — it must NOT toggle playback.
 *
 * This suite mounts the real `UnifiedLibraryMode` and starts the real
 * spacebar handler in production order (shortcut first, library capture
 * second, exactly as the layout mounts before the library view resumes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/svelte';
import { createFakeSocket } from '../../../test/fixtures/socket';
import { __resetNavigation } from '../../../test/app-stubs/navigation';
import { clearPendingLibraryPageStateWrite } from '$lib/libraryPageNavigation';
import { resetLibraryIntentStore } from '$lib/stores/libraryIntentStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { clearCommandFeedback } from '$lib/stores/commandFeedbackStore';
import { startSpacebarPlayPause } from '$lib/media/spacebarPlayPause';
import { harnessLibrary, mountMode } from './unifiedLibraryModeHarness';

const socket = createFakeSocket();

vi.mock('$lib/socket/client', () => ({
	getSocket: () => socket
}));

function playPauseCalls(): unknown[][] {
	return socket.emit.mock.calls
		.filter((call) => call[0] === 'transport:play-pause')
		.map((call) => [call[0], call[1]]);
}

describe('UnifiedLibraryMode — Space during the palette-open race', () => {
	let stop: (() => void) | null = null;

	beforeEach(() => {
		__resetNavigation('http://localhost/library');
		clearPendingLibraryPageStateWrite();
		resetLibraryIntentStore();
		setZonesSnapshot([]);
		socket.connected = true;
		socket.emit.mockReset();
		clearCommandFeedback();
		setSelectedZone('zone-1');
		stop = startSpacebarPlayPause();
	});

	afterEach(() => {
		stop?.();
		stop = null;
		setSelectedZone('');
	});

	it('"a" then an immediate Space opens the palette without toggling playback', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		// Same-turn sequence, no flush in between: exactly a fast typist. The
		// palette state has flipped but its dialog is not in the DOM yet and
		// focus has not landed in its input.
		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
		);
		const space = new KeyboardEvent('keydown', {
			key: ' ',
			bubbles: true,
			cancelable: true
		});
		window.dispatchEvent(space);

		expect(playPauseCalls()).toHaveLength(0);
		// Unhandled means untouched: the shortcut must not steal the key either.
		expect(space.defaultPrevented).toBe(false);

		// After the flush the palette is up, seeded with the typed letter.
		expect(await screen.findByTestId('unified-palette')).toBeInTheDocument();
		expect((screen.getByTestId('unified-palette-input') as HTMLInputElement).value).toBe(
			'a'
		);

		// Steady state: with the palette mounted (aria-modal), Space still
		// stays out of playback.
		await fireEvent.keyDown(window, { key: ' ' });
		expect(playPauseCalls()).toHaveLength(0);
	});

	it('Space with the palette closed still toggles playback', async () => {
		mountMode({ liveLibrary: harnessLibrary() });

		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
		);

		expect(playPauseCalls()).toEqual([['transport:play-pause', { zone_id: 'zone-1' }]]);
		// The typed Space is spent on the shortcut, not palette capture.
		expect(screen.queryByTestId('unified-palette')).toBeNull();
	});
});
