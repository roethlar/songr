import { describe, it, expect, vi } from 'vitest';
import {
	createSilentAudioKeepalive,
	encodeSilentWav,
	SILENT_CLIP_SECONDS,
	type GestureTargetLike,
	type KeepaliveAudioElement
} from '../silentAudioKeepalive';

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

class FakeAudio implements KeepaliveAudioElement {
	// Deliberately hostile defaults, so the keepalive has to set each one.
	loop = false;
	muted = true;
	volume = 0;
	src = '';
	paused = true;
	playCalls = 0;
	pauseCalls = 0;
	private rejectNext: boolean;

	constructor(options: { rejectNext?: boolean } = {}) {
		this.rejectNext = options.rejectNext ?? false;
	}

	blockAutoplay(blocked: boolean): void {
		this.rejectNext = blocked;
	}

	play(): Promise<void> {
		this.playCalls += 1;
		if (this.rejectNext) {
			return Promise.reject(new DOMException('NotAllowedError'));
		}
		this.paused = false;
		return Promise.resolve();
	}

	pause(): void {
		this.pauseCalls += 1;
		this.paused = true;
	}
}

function createGestureTarget() {
	const listeners = new Map<string, Set<() => void>>();
	const target: GestureTargetLike & {
		count(): number;
		fire(type: string): void;
	} = {
		addEventListener(type, listener) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		count() {
			let total = 0;
			for (const set of listeners.values()) total += set.size;
			return total;
		},
		fire(type) {
			for (const listener of [...(listeners.get(type) ?? [])]) listener();
		}
	};
	return target;
}

describe('encodeSilentWav', () => {
	it('emits a RIFF/WAVE clip long enough to count as media, not a sound effect', () => {
		const wav = encodeSilentWav();
		const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

		expect(readAscii(wav, 0, 4)).toBe('RIFF');
		expect(readAscii(wav, 8, 4)).toBe('WAVE');
		expect(readAscii(wav, 12, 4)).toBe('fmt ');
		expect(readAscii(wav, 36, 4)).toBe('data');

		const sampleRate = view.getUint32(24, true);
		const dataBytes = view.getUint32(40, true);
		const bitsPerSample = view.getUint16(34, true);
		const channels = view.getUint16(22, true);
		const seconds = dataBytes / (sampleRate * channels * (bitsPerSample / 8));

		expect(seconds).toBe(SILENT_CLIP_SECONDS);
		expect(seconds).toBeGreaterThan(5);
		expect(view.getUint32(4, true)).toBe(36 + dataBytes);
	});

	it('fills the samples with the 8-bit PCM zero level, not zero bytes', () => {
		const wav = encodeSilentWav(0.01, 8000);
		const samples = wav.subarray(44);

		expect(samples.length).toBe(80);
		expect(samples.every((sample) => sample === 0x80)).toBe(true);
	});
});

describe('createSilentAudioKeepalive', () => {
	it('plays an unmuted looping clip, because a muted element is dropped from the session', () => {
		const audio = new FakeAudio();
		const keepalive = createSilentAudioKeepalive({
			createAudio: () => audio,
			gestureTarget: null
		});

		keepalive.start();

		expect(audio.playCalls).toBe(1);
		expect(audio.loop).toBe(true);
		expect(audio.muted).toBe(false);
		expect(audio.volume).toBeGreaterThan(0);
	});

	it('creates the element once across start/stop cycles', () => {
		const audio = new FakeAudio();
		const createAudio = vi.fn(() => audio);
		const keepalive = createSilentAudioKeepalive({ createAudio, gestureTarget: null });

		keepalive.start();
		keepalive.start();
		keepalive.stop();
		keepalive.start();

		expect(createAudio).toHaveBeenCalledTimes(1);
		expect(audio.playCalls).toBe(2);
		expect(audio.pauseCalls).toBe(1);
	});

	it('retries once the user provides a gesture when autoplay is refused', async () => {
		const audio = new FakeAudio({ rejectNext: true });
		const gestureTarget = createGestureTarget();
		const keepalive = createSilentAudioKeepalive({ createAudio: () => audio, gestureTarget });

		keepalive.start();
		await Promise.resolve();
		await Promise.resolve();

		expect(audio.paused).toBe(true);
		expect(gestureTarget.count()).toBeGreaterThan(0);

		audio.blockAutoplay(false);
		gestureTarget.fire('pointerdown');

		expect(audio.playCalls).toBe(2);
		expect(audio.paused).toBe(false);
		// Both gesture listeners are removed once one of them fires.
		expect(gestureTarget.count()).toBe(0);
	});

	it('drops a pending gesture retry when the keepalive is no longer wanted', async () => {
		const audio = new FakeAudio({ rejectNext: true });
		const gestureTarget = createGestureTarget();
		const keepalive = createSilentAudioKeepalive({ createAudio: () => audio, gestureTarget });

		keepalive.start();
		await Promise.resolve();
		await Promise.resolve();
		expect(gestureTarget.count()).toBeGreaterThan(0);

		keepalive.stop();

		expect(gestureTarget.count()).toBe(0);
		gestureTarget.fire('keydown');
		expect(audio.playCalls).toBe(1);
	});

	it('releases everything on destroy and refuses to restart', () => {
		const audio = new FakeAudio();
		const gestureTarget = createGestureTarget();
		const onDestroy = vi.fn();
		const keepalive = createSilentAudioKeepalive({
			createAudio: () => audio,
			gestureTarget,
			onDestroy
		});

		keepalive.start();
		keepalive.destroy();

		expect(audio.pauseCalls).toBe(1);
		expect(onDestroy).toHaveBeenCalledTimes(1);
		expect(gestureTarget.count()).toBe(0);

		keepalive.start();
		expect(audio.playCalls).toBe(1);
	});
});
