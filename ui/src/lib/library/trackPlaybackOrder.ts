import type { UnifiedSongActionSemantic } from '@shared/unifiedSearchContracts';
import type { TrackActionBatchStep } from './trackActionBatch';

/**
 * Roon's Play Now replaces the queue; Queue appends; Add Next inserts next.
 * https://community.roonlabs.com/t/track-playback-issues/1046/2
 * https://community.roonlabs.com/t/new-play-mode-request/3575/4
 * Keep audible order equal to the current list, never selection click order.
 */
export function trackPlaybackOrder<T>(
	items: readonly T[], semantic: UnifiedSongActionSemantic
): TrackActionBatchStep<T, UnifiedSongActionSemantic>[] {
	const steps = items.map((item, index) => ({
		item, semantic: semantic === 'play-now' && index > 0 ? 'queue' as const : semantic
	}));
	return semantic === 'add-next' ? steps.reverse() : steps;
}
