import { derived, writable } from 'svelte/store';

export type CommandSource = 'transport' | 'browse' | 'queue';

export interface CommandFeedback {
	readonly source: CommandSource;
	readonly command: string;
	readonly message: string;
	/**
	 * Toast styling. Defaults to 'error' (the original behavior —
	 * every push was a failure report). 'success' renders as a
	 * confirmation: ✓ icon, no "Error" heading. Live feedback
	 * 2026-06-10: "Added X to favorites" rendered under a ⚠️
	 * "Browse Error" heading.
	 */
	readonly kind?: 'error' | 'success';
	readonly timestamp: number;
}

export interface CommandFeedbackToast extends CommandFeedback {
	/** Monotonic handle for dismissal — two toasts can otherwise be identical. */
	readonly id: number;
}

/**
 * Concurrent-toast cap. A burst of pushes drops the oldest toast
 * rather than stacking without bound or (the old bug) overwriting
 * the previous toast so only the last of two rapid actions was seen.
 */
const MAX_TOASTS = 3;

const internalQueue = writable<CommandFeedbackToast[]>([]);
let nextToastId = 0;

/** All live toasts, oldest first. */
export const commandFeedbackQueue = {
	subscribe: internalQueue.subscribe
};

/** Latest feedback (or null) — the single-item view most callers assert against. */
export const commandFeedbackStore = derived(internalQueue, ($queue) =>
	$queue.length > 0 ? $queue[$queue.length - 1] : null
);

export function pushCommandFeedback(feedback: Omit<CommandFeedback, 'timestamp'>): void {
	internalQueue.update((queue) =>
		[...queue, { ...feedback, id: ++nextToastId, timestamp: Date.now() }].slice(-MAX_TOASTS)
	);
}

export function dismissCommandFeedback(id: number): void {
	internalQueue.update((queue) => queue.filter((toast) => toast.id !== id));
}

export function clearCommandFeedback(): void {
	internalQueue.set([]);
}
