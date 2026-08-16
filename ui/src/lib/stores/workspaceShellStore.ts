import { writable, type Readable } from 'svelte/store';
import type { AppShellContract } from '$lib/appShellContract';

/**
 * A product-generic shell claim for workspace routes this build may carry.
 *
 * A route claims a frozen shell contract on mount and MUST release it on
 * unmount; the root layout resolves an active claim ahead of the neutral
 * fallback. The shell contract itself never learns any workspace path — a
 * build with no claimant (the public build) resolves every unknown URL to
 * the ordinary neutral shell, so an arbitrary workspace-looking URL cannot
 * turn a workspace shell on.
 */
export interface WorkspaceShellState {
	readonly contract: AppShellContract | null;
}

export interface WorkspaceShellClaim {
	release(): void;
}

const EMPTY_SHELL_STATE: WorkspaceShellState = Object.freeze({ contract: null });

export function createWorkspaceShellStateStore(): {
	store: Readable<WorkspaceShellState>;
	claim(contract: AppShellContract): WorkspaceShellClaim;
} {
	const internal = writable<WorkspaceShellState>(EMPTY_SHELL_STATE);
	let ownerGeneration = 0;

	return {
		store: { subscribe: internal.subscribe },
		claim(contract): WorkspaceShellClaim {
			const generation = ++ownerGeneration;
			let released = false;
			internal.set(Object.freeze({ contract: Object.freeze({ ...contract }) }));

			return {
				release(): void {
					if (released) return;
					released = true;
					if (generation !== ownerGeneration) return;
					ownerGeneration += 1;
					internal.set(EMPTY_SHELL_STATE);
				}
			};
		}
	};
}

const productionShellState = createWorkspaceShellStateStore();

export const workspaceShellStore = productionShellState.store;
export const claimWorkspaceShell = productionShellState.claim;
