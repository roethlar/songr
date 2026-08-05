import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
import type { ClassicBrowseSessionClaim } from '$lib/stores/classicBrowseSessionStore';
import { ClassicBrowseSessionError } from '$lib/stores/classicBrowseSessionStore';
import {
	unifiedSearchClient,
	type UnifiedSearchClient
} from '$lib/unifiedSearchClient';

export type UnifiedSongActionPhase =
	| 'idle'
	| 'executing'
	| 'executed'
	| 'failed'
	| 'outcome-unknown';

export interface UnifiedSongActionState {
	readonly phase: UnifiedSongActionPhase;
	readonly resultId: string | null;
	readonly semantic: UnifiedSongActionSemantic | null;
	readonly zoneId: string | null;
	readonly code: string | null;
	readonly error: string | null;
	readonly authorityRetired: boolean;
}

export interface UnifiedSongActionInput {
	readonly claim: ClassicBrowseSessionClaim;
	readonly resultId: string;
	readonly semantic: UnifiedSongActionSemantic;
	readonly zoneId: string;
}

const IDLE_STATE: UnifiedSongActionState = Object.freeze({
	phase: 'idle',
	resultId: null,
	semantic: null,
	zoneId: null,
	code: null,
	error: null,
	authorityRetired: false
});

/**
 * Small DOM-independent state machine for one-click retained-song actions.
 * The server owns all execution authority; this controller only prevents a
 * local double start and presents the correlated acknowledgment.
 */
export class UnifiedSongActionController {
	readonly #subscribers = new Set<(state: UnifiedSongActionState) => void>();
	#state = IDLE_STATE;
	#disposed = false;

	constructor(
		private readonly client: Pick<UnifiedSearchClient, 'action'> = unifiedSearchClient
	) {}

	subscribe(run: (state: UnifiedSongActionState) => void): () => void {
		this.#subscribers.add(run);
		run(this.#state);
		return () => this.#subscribers.delete(run);
	}

	snapshot(): UnifiedSongActionState {
		return this.#state;
	}

	async execute(input: UnifiedSongActionInput): Promise<boolean> {
		if (this.#disposed || this.#state.phase === 'executing') return false;
		this.#publish({
			phase: 'executing',
			resultId: input.resultId,
			semantic: input.semantic,
			zoneId: input.zoneId,
			code: null,
			error: null,
			authorityRetired: false
		});
		try {
			const result = await this.client.action(
				input.claim,
				input.resultId,
				input.zoneId,
				input.semantic
			);
			if (this.#disposed) return true;
			this.#publish({
				phase: 'executed',
				resultId: input.resultId,
				semantic: input.semantic,
				zoneId: input.zoneId,
				code: null,
				error: null,
				authorityRetired: result.authorityRetired
			});
		} catch (error) {
			if (this.#disposed) return true;
			const code =
				error instanceof ClassicBrowseSessionError ? error.code : 'SESSION_LOST';
			this.#publish({
				phase: code === 'OUTCOME_UNKNOWN' ? 'outcome-unknown' : 'failed',
				resultId: input.resultId,
				semantic: input.semantic,
				zoneId: input.zoneId,
				code,
				error: error instanceof Error ? error.message : 'Song action failed',
				authorityRetired:
					code === 'OUTCOME_UNKNOWN' ||
					code === 'STALE_RESULT' ||
					code === 'STALE_GENERATION' ||
					code === 'SESSION_LOST'
			});
		}
		return true;
	}

	reset(): void {
		if (this.#state.phase === 'executing') return;
		this.#publish(IDLE_STATE);
	}

	dispose(): void {
		this.#disposed = true;
		this.#subscribers.clear();
	}

	#publish(state: UnifiedSongActionState): void {
		this.#state = Object.freeze({ ...state });
		for (const subscriber of this.#subscribers) subscriber(this.#state);
	}
}
