import type {
	PublicSongCandidate,
	PublicSongRowAuthority
} from '@shared/publicSongResolverContracts';
import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
import {
	publicSongResolverClient,
	type PublicSongResolverClient
} from '$lib/publicSongResolverClient';
import {
	ClassicBrowseSessionError,
	type ClassicBrowseSessionClaim
} from '$lib/stores/classicBrowseSessionStore';

export type PublicSongActionPhase =
	| 'idle'
	| 'resolving'
	| 'choosing'
	| 'executing'
	| 'executed'
	| 'failed'
	| 'canceled'
	| 'outcome-unknown';

export interface PublicSongActionState {
	readonly phase: PublicSongActionPhase;
	readonly selectionId: string | null;
	readonly semantic: UnifiedSongActionSemantic | null;
	readonly zoneId: string | null;
	readonly candidates: readonly PublicSongCandidate[];
	readonly selectedCandidateId: string | null;
	readonly code: string | null;
	readonly error: string | null;
	readonly authorityRetired: boolean;
}

export type ActionablePublicSongAuthority = Exclude<
	PublicSongRowAuthority,
	{ state: 'unavailable' }
>;

export interface PublicSongActionInput {
	readonly claim: ClassicBrowseSessionClaim;
	readonly authority: ActionablePublicSongAuthority;
	readonly semantic: UnifiedSongActionSemantic;
	readonly zoneId: string;
}

export type PublicSongActionBeginResult =
	| { readonly started: true }
	| { readonly started: false; readonly reason: 'busy' | 'disposed' };

const EMPTY_CANDIDATES: readonly PublicSongCandidate[] = Object.freeze([]);
const IDLE_STATE: PublicSongActionState = Object.freeze({
	phase: 'idle',
	selectionId: null,
	semantic: null,
	zoneId: null,
	candidates: EMPTY_CANDIDATES,
	selectedCandidateId: null,
	code: null,
	error: null,
	authorityRetired: false
});

function frozenCandidates(
	candidates: readonly PublicSongCandidate[]
): readonly PublicSongCandidate[] {
	return Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })));
}

/**
 * Browser-side one-shot state machine for opaque song selections. Every begin
 * owns a local generation; canceling or superseding it makes late resolver and
 * action acknowledgements inert before their candidate IDs can reach the UI.
 */
export class PublicSongActionController {
	readonly #subscribers = new Set<(state: PublicSongActionState) => void>();
	#state = IDLE_STATE;
	#generation = 0;
	#disposed = false;

	constructor(
		private readonly client: PublicSongResolverClient = publicSongResolverClient
	) {}

	subscribe(run: (state: PublicSongActionState) => void): () => void {
		this.#subscribers.add(run);
		run(this.#state);
		return () => this.#subscribers.delete(run);
	}

	snapshot(): PublicSongActionState {
		return this.#state;
	}

	begin(input: PublicSongActionInput): PublicSongActionBeginResult {
		if (this.#disposed) return { started: false, reason: 'disposed' };
		if (this.#state.phase === 'executing') return { started: false, reason: 'busy' };
		const generation = ++this.#generation;
		this.#activeInputClaim = input.claim;
		this.#publish({
			phase: 'resolving',
			selectionId: input.authority.selectionId,
			semantic: input.semantic,
			zoneId: input.zoneId,
			candidates: EMPTY_CANDIDATES,
			selectedCandidateId: null,
			code: null,
			error: null,
			authorityRetired: false
		});
		void this.#resolve(generation, input);
		return { started: true };
	}

	choose(candidateId: string): boolean {
		if (this.#state.phase !== 'choosing') return false;
		const candidate = this.#state.candidates.find(
			(current) => current.candidateId === candidateId
		);
		if (!candidate) return false;
		const generation = this.#generation;
		this.#publish({
			...this.#state,
			phase: 'executing',
			candidates: EMPTY_CANDIDATES,
			selectedCandidateId: candidate.candidateId,
			code: null,
			error: null
		});
		void this.#execute(generation, candidate);
		return true;
	}

	cancel(): boolean {
		if (
			this.#state.phase !== 'resolving' &&
			this.#state.phase !== 'choosing'
		) {
			return false;
		}
		this.#generation += 1;
		this.#activeInputClaim = null;
		this.#publish({
			...this.#state,
			phase: 'canceled',
			candidates: EMPTY_CANDIDATES,
			selectedCandidateId: null,
			code: 'CANCELED',
			error: null
		});
		return true;
	}

	reset(): void {
		if (this.#state.phase === 'executing') return;
		this.#generation += 1;
		this.#activeInputClaim = null;
		this.#publish(IDLE_STATE);
	}

	/** Hard lifecycle boundary: the owning claim is gone, so late acks are inert. */
	abandon(): void {
		this.#generation += 1;
		this.#activeInputClaim = null;
		this.#publish(IDLE_STATE);
	}

	dispose(): void {
		this.#generation += 1;
		this.#disposed = true;
		this.#activeInputClaim = null;
		this.#subscribers.clear();
	}

	async #resolve(generation: number, input: PublicSongActionInput): Promise<void> {
		try {
			const resolution =
				input.authority.state === 'public-authorized'
					? { kind: 'authorized' as const, candidate: input.authority.candidate }
					: await this.client.resolve(input.claim, input.authority.selectionId);
			if (!this.#isCurrent(generation, 'resolving')) return;
			if (resolution.kind === 'unavailable') {
				this.#publish({
					...this.#state,
					phase: 'failed',
					candidates: EMPTY_CANDIDATES,
					code: resolution.reason.code,
					error: resolution.reason.message
				});
				return;
			}
			if (resolution.kind === 'choice-required') {
				this.#publish({
					...this.#state,
					phase: 'choosing',
					candidates: frozenCandidates(resolution.candidates),
					selectedCandidateId: null,
					code: null,
					error: null
				});
				return;
			}
			this.#publish({
				...this.#state,
				phase: 'executing',
				candidates: EMPTY_CANDIDATES,
				selectedCandidateId: resolution.candidate.candidateId,
				code: null,
				error: null
			});
			await this.#execute(generation, resolution.candidate);
		} catch (error) {
			this.#publishFailure(generation, 'resolving', error);
		}
	}

	async #execute(generation: number, candidate: PublicSongCandidate): Promise<void> {
		const selectionId = this.#state.selectionId;
		const semantic = this.#state.semantic;
		const zoneId = this.#state.zoneId;
		const claim = this.#activeInputClaim;
		if (!selectionId || !semantic || !zoneId || !claim) return;
		try {
			await this.client.action(
				claim,
				selectionId,
				candidate,
				zoneId,
				semantic
			);
			if (!this.#isCurrent(generation, 'executing')) return;
			this.#publish({
				...this.#state,
				phase: 'executed',
				candidates: EMPTY_CANDIDATES,
				code: null,
				error: null,
				authorityRetired: true
			});
		} catch (error) {
			this.#publishFailure(generation, 'executing', error);
		}
	}

	#activeInputClaim: ClassicBrowseSessionClaim | null = null;

	#publishFailure(
		generation: number,
		expectedPhase: 'resolving' | 'executing',
		error: unknown
	): void {
		if (!this.#isCurrent(generation, expectedPhase)) return;
		const code =
			error instanceof ClassicBrowseSessionError ? error.code : 'SESSION_LOST';
		this.#publish({
			...this.#state,
			phase: code === 'OUTCOME_UNKNOWN' ? 'outcome-unknown' : 'failed',
			candidates: EMPTY_CANDIDATES,
			code,
			error: error instanceof Error ? error.message : 'Track action failed',
			authorityRetired:
				code === 'OUTCOME_UNKNOWN' ||
				code === 'STALE_SELECTION' ||
				code === 'SOURCE_CHANGED' ||
				code === 'STALE_CANDIDATE' ||
				code === 'SESSION_LOST'
		});
	}

	#isCurrent(
		generation: number,
		phase: Extract<PublicSongActionPhase, 'resolving' | 'executing'>
	): boolean {
		return !this.#disposed && generation === this.#generation && this.#state.phase === phase;
	}

	#publish(state: PublicSongActionState): void {
		this.#state = Object.freeze({ ...state });
		for (const subscriber of this.#subscribers) subscriber(this.#state);
	}
}
