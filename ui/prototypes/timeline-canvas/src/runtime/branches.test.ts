import { describe, expect, it } from 'vitest';
import { createScenario } from '../fixtures';
import { MAX_BRANCH_CANDIDATES, MAX_BRANCH_DEPTH, MAX_OPEN_BRANCHES, boundBranches } from './branches';

describe('bounded synthetic branches', () => {
	it('keeps at most three branches, eight candidates each, and depth two', () => {
		const source = createScenario('large').branches[0];
		const oversized = Array.from({ length: 7 }, (_, branchIndex) => ({
			...source,
			id: `oversized-${branchIndex}`,
			depth: (branchIndex % 2 === 0 ? 1 : 2) as 1 | 2,
			candidates: Array.from({ length: 12 }, (_, candidateIndex) => ({
				...source.candidates[candidateIndex % source.candidates.length],
				id: `oversized-${branchIndex}-candidate-${candidateIndex}`,
				depth: (candidateIndex % 2 === 0 ? 1 : 2) as 1 | 2
			}))
		}));
		const bounded = boundBranches(oversized);

		expect(MAX_OPEN_BRANCHES).toBe(3);
		expect(MAX_BRANCH_CANDIDATES).toBe(8);
		expect(MAX_BRANCH_DEPTH).toBe(2);
		expect(bounded).toHaveLength(3);
		expect(bounded.every((branch) => branch.depth <= 2)).toBe(true);
		expect(bounded.every((branch) => branch.candidates.length <= 8)).toBe(true);
		expect(bounded.flatMap((branch) => branch.candidates).every((candidate) => candidate.depth <= 2)).toBe(
			true
		);
	});
});
