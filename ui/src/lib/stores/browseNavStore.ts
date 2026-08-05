import { writable } from 'svelte/store';

export interface BrowseNavState {
	canBack: boolean;
	canForward: boolean;
	back: () => void;
	forward: () => void;
	home: () => void;
}

const noop = () => {};

export const browseNavStore = writable<BrowseNavState>({
	canBack: false,
	canForward: false,
	back: noop,
	forward: noop,
	home: noop
});
