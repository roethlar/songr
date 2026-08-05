import type { SyntheticBranch } from '../fixtures';

export const MAX_OPEN_BRANCHES = 3;
export const MAX_BRANCH_CANDIDATES = 8;
export const MAX_BRANCH_DEPTH = 2;

export function boundBranches(branches: readonly SyntheticBranch[]): SyntheticBranch[] {
	return branches
		.filter((branch) => branch.depth <= MAX_BRANCH_DEPTH)
		.slice(0, MAX_OPEN_BRANCHES)
		.map((branch) => ({
			...branch,
			candidates: branch.candidates
				.filter((candidate) => candidate.depth <= MAX_BRANCH_DEPTH)
				.slice(0, MAX_BRANCH_CANDIDATES)
		}));
}
