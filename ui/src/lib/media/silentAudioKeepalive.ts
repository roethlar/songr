/**
 * Silent-audio activation for the Media Session API.
 *
 * WHY THIS EXISTS. This app is a remote control: the audio comes out of a Roon
 * zone somewhere else on the network, and the page itself plays nothing. But
 * Chromium does not expose a page's `navigator.mediaSession` to the operating
 * system on the strength of metadata alone. The OS-facing session (MPRIS on
 * Linux, SMTC on Windows, Now Playing on macOS) is created from an *active
 * media player* in the page, and the metadata and action handlers only
 * decorate a session that playback already created. Chrome's own Media Session
 * guidance states it that way — "current `navigator.mediaSession.metadata`
 * will be used when any playback starts" — and it records the other two
 * constraints this file is shaped by: media shorter than about five seconds is
 * treated as a transient sound effect and gets no session, and Web Audio does
 * not request audio focus, so it has to be an actual media element.
 *
 * Hence: one detached `<audio>` element looping a generated clip of digital
 * silence, running while a track is loaded in the selected zone.
 *
 * NOT `muted`. Muting is the obvious way to make an audio element safe and it
 * is exactly wrong here: Chromium tracks the muted status of a player and
 * drops a muted one from the media session (a muted tab disappears from
 * Chrome's media controls). The safety here comes from the *content* being
 * silence — every sample is the PCM zero level — not from the element's mute
 * flag, which stays off deliberately.
 *
 * Autoplay: starting playback may be refused until the page has a user
 * gesture. A refusal is not fatal and is not an error worth shouting about —
 * we arm a one-shot gesture listener and try again on the user's next click or
 * keypress, which in practice is the very interaction that starts playback.
 */

/** The slice of `HTMLAudioElement` the keepalive drives, so tests can fake it. */
export interface KeepaliveAudioElement {
	loop: boolean;
	muted: boolean;
	volume: number;
	src: string;
	readonly paused: boolean;
	play(): Promise<void> | void;
	pause(): void;
}

export interface GestureTargetLike {
	addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: string, listener: () => void): void;
}

export interface MediaSessionKeepalive {
	start(): void;
	stop(): void;
	destroy(): void;
}

export interface SilentAudioKeepaliveOptions {
	/** Builds the element. Defaults to a detached `Audio` over a silent clip. */
	createAudio?: () => KeepaliveAudioElement;
	/** Where the retry-after-gesture listeners attach. Defaults to `document`. */
	gestureTarget?: GestureTargetLike | null;
	/** Called when playback is released, so the caller can revoke a blob URL. */
	onDestroy?: () => void;
}

/** Gesture events cheap enough to listen for once and specific to real input. */
const GESTURE_EVENTS = ['pointerdown', 'keydown'] as const;

/**
 * Comfortably past Chromium's ~5 second "this is a sound effect, not media"
 * threshold, and short enough that the buffer stays small (8 kHz 8-bit mono is
 * 8 KB per second).
 */
export const SILENT_CLIP_SECONDS = 20;
const SILENT_CLIP_SAMPLE_RATE = 8000;

/**
 * Encode a mono 8-bit PCM WAV of pure silence.
 *
 * 8-bit PCM samples are *unsigned*: the zero level is 0x80, not 0x00. Filling
 * with zero bytes would emit a full-scale DC offset — audible as a click and,
 * on some outputs, worse.
 */
export function encodeSilentWav(
	seconds: number = SILENT_CLIP_SECONDS,
	sampleRate: number = SILENT_CLIP_SAMPLE_RATE
): Uint8Array<ArrayBuffer> {
	const frames = Math.max(1, Math.floor(seconds * sampleRate));
	const headerBytes = 44;
	const buffer = new ArrayBuffer(headerBytes + frames);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);

	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + frames, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // channels: mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate, true); // byte rate = rate * channels * 1 byte
	view.setUint16(32, 1, true); // block align
	view.setUint16(34, 8, true); // bits per sample
	writeAscii(36, 'data');
	view.setUint32(40, frames, true);
	bytes.fill(0x80, headerBytes);

	return bytes;
}

/**
 * The default element factory. Exported so the browser fixture can hold the
 * very element the app would use and report what the engine did with it.
 */
export function createSilentAudioElement(): HTMLAudioElement {
	const blob = new Blob([encodeSilentWav()], { type: 'audio/wav' });
	const url = URL.createObjectURL(blob);
	const element = new Audio(url);
	element.preload = 'auto';
	// `loop`, `muted` and `volume` are set by the keepalive itself, so the
	// policy is one testable place rather than split across the factory.
	silentAudioObjectUrls.set(element, url);
	return element;
}

/** Tracks blob URLs so `destroy()` can revoke exactly what it created. */
const silentAudioObjectUrls = new WeakMap<object, string>();

export function createSilentAudioKeepalive(
	options: SilentAudioKeepaliveOptions = {}
): MediaSessionKeepalive {
	const createAudio = options.createAudio ?? createSilentAudioElement;
	const gestureTarget =
		options.gestureTarget !== undefined
			? options.gestureTarget
			: typeof document !== 'undefined'
				? document
				: null;

	let element: KeepaliveAudioElement | null = null;
	let wanted = false;
	let destroyed = false;
	let gestureListener: (() => void) | null = null;

	function disarmGestureRetry(): void {
		if (!gestureListener || !gestureTarget) {
			gestureListener = null;
			return;
		}
		for (const type of GESTURE_EVENTS) {
			gestureTarget.removeEventListener(type, gestureListener);
		}
		gestureListener = null;
	}

	function armGestureRetry(): void {
		if (gestureListener || !gestureTarget) return;
		const listener = () => {
			disarmGestureRetry();
			if (wanted && !destroyed) attemptPlay();
		};
		gestureListener = listener;
		for (const type of GESTURE_EVENTS) {
			gestureTarget.addEventListener(type, listener);
		}
	}

	function attemptPlay(): void {
		if (destroyed || !wanted) return;
		if (!element) {
			element = createAudio();
			element.loop = true;
			// Deliberately NOT muted, and not at zero volume: Chromium drops a
			// muted player from the media session, which would defeat the whole
			// point of this element. The clip itself carries only silence.
			element.muted = false;
			element.volume = 1;
		}
		const active = element;
		let result: Promise<void> | void;
		try {
			result = active.play();
		} catch {
			// Synchronous refusal (older engines throw instead of rejecting).
			armGestureRetry();
			return;
		}
		if (result && typeof result.then === 'function') {
			result.then(undefined, () => {
				// Autoplay blocked, or the element was torn down mid-start.
				if (wanted && !destroyed) armGestureRetry();
			});
		}
	}

	return {
		start(): void {
			if (destroyed || wanted) return;
			wanted = true;
			attemptPlay();
		},
		stop(): void {
			if (!wanted) return;
			wanted = false;
			disarmGestureRetry();
			element?.pause();
		},
		destroy(): void {
			if (destroyed) return;
			wanted = false;
			destroyed = true;
			disarmGestureRetry();
			const active = element;
			element = null;
			if (active) {
				active.pause();
				const url = silentAudioObjectUrls.get(active);
				if (url) {
					silentAudioObjectUrls.delete(active);
					URL.revokeObjectURL(url);
				}
			}
			options.onDestroy?.();
		}
	};
}
