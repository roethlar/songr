import { describe, expect, it, vi } from 'vitest';
import {
	LiveLibraryPageController,
	type LiveLibraryPageDependencies,
	type LiveLibraryPageState
} from '../LiveLibraryPageController';
import { libraryAlbumStep, type LibraryRenderingPath } from '../liveLibraryPath';
import { LIBRARY_OPEN_CONTRACT, type LibraryOpenResponse } from '@shared/libraryOpenContracts';
import type { LibraryRootRow, LibraryRowReference } from '@shared/libraryRootsContracts';

const GEN = 'gen-1';
const NEXT_GEN = 'gen-2';

function ref(token: string, generation = GEN): LibraryRowReference {
	return { generation, token };
}

function artistRoot(generation = GEN): LibraryRootRow[] {
	return [
		{ ref: ref('artist:’Til Tuesday', generation), title: '’Til Tuesday', subtitle: '5 Albums' }
	];
}

function level(generation: string, title: string): LibraryOpenResponse {
	return {
		contract: LIBRARY_OPEN_CONTRACT,
		kind: 'level',
		generation,
		title,
		count: 1,
		rows: [
			{
				ref: ref(`album:${title}`, generation),
				title: 'Voices Carry',
				subtitle: '’Til Tuesday',
				kind: 'album'
			}
		]
	};
}

const ARTIST_PATH: LibraryRenderingPath = {
	origin: 'artists',
	steps: [{ kind: 'artist', title: '’Til Tuesday' }]
};

function make(over: Partial<LiveLibraryPageDependencies> = {}) {
	const states: LiveLibraryPageState[] = [];
	const controller = new LiveLibraryPageController({
		heldRoot: () => artistRoot(),
		openRef: async () => level(GEN, '’Til Tuesday'),
		openRoot: async () => ({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' }),
		heldGeneration: () => GEN,
		...over
	});
	controller.subscribe((state) => states.push(state));
	return { controller, states };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('LiveLibraryPageController', () => {
	it('opens by the reference the reader clicked, without re-deriving the row', async () => {
		const clicked = ref('artist:’Til Tuesday');
		const heldRoot = vi.fn(() => artistRoot());
		const openRef = vi.fn(async () => level(GEN, '’Til Tuesday'));
		const { controller } = make({ heldRoot, openRef });
		controller.open({ path: ARTIST_PATH, ref: clicked, title: '’Til Tuesday' });
		await settle();
		// The click was unambiguous. Nothing was looked up, and the one read
		// issued was the reference itself.
		expect(heldRoot).not.toHaveBeenCalled();
		expect(openRef).toHaveBeenCalledTimes(1);
		expect(openRef).toHaveBeenCalledWith(clicked);
		expect(controller.snapshot()).toMatchObject({ phase: 'ready', target: { ref: clicked } });
	});

	it('refuses a reference from another generation and resolves the address instead', async () => {
		const dead = ref('artist:’Til Tuesday', 'gen-0');
		const openRef = vi.fn(async () => level(GEN, '’Til Tuesday'));
		const { controller } = make({ openRef });
		controller.open({ path: ARTIST_PATH, ref: dead, title: '’Til Tuesday' });
		await settle();
		// The dead handle is never sent: it cannot start working again, and
		// sending it would answer stale forever.
		expect(openRef).not.toHaveBeenCalledWith(dead);
		expect(controller.snapshot()).toMatchObject({
			phase: 'ready',
			target: { ref: ref('artist:’Til Tuesday') }
		});
	});

	it('drops the reference on retry, so a retired snapshot re-resolves', async () => {
		const clicked = ref('artist:’Til Tuesday');
		const openRef = vi.fn(async () => level(GEN, '’Til Tuesday'));
		const heldRoot = vi.fn(() => artistRoot());
		const { controller } = make({ openRef, heldRoot });
		controller.open({ path: ARTIST_PATH, ref: clicked, title: '’Til Tuesday' });
		await settle();
		heldRoot.mockClear();
		controller.retry();
		await settle();
		expect(heldRoot).toHaveBeenCalledWith('artists');
	});

	it('states a retired snapshot as stale, which is what the host re-reads on', async () => {
		const { controller } = make({
			openRef: async () => ({ contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' })
		});
		controller.open({ path: ARTIST_PATH, ref: ref('artist:’Til Tuesday'), title: '’Til Tuesday' });
		await settle();
		expect(controller.snapshot()).toMatchObject({ phase: 'failed', stale: true });
	});

	it('states a missing row in the reader’s words, and not as stale', async () => {
		const { controller } = make({ heldRoot: () => [] });
		controller.open({ path: ARTIST_PATH });
		await settle();
		const state = controller.snapshot();
		expect(state.phase).toBe('failed');
		expect(state.stale).toBe(false);
		expect(state.message).toContain('’Til Tuesday');
	});

	it('publishes a group page with every current reference for identical rows', async () => {
		const rows: LibraryRootRow[] = [
			{ ref: ref('duplicate:one'), title: 'Same Artist', subtitle: '2 Albums' },
			{ ref: ref('duplicate:two'), title: 'Same Artist', subtitle: '8 Albums' }
		];
		const openRef = vi.fn(async () => level(GEN, 'must not open'));
		const { controller } = make({ heldRoot: () => rows, openRef });
		const path: LibraryRenderingPath = {
			origin: 'artists',
			steps: [{ kind: 'artist', title: 'Same Artist' }]
		};

		controller.open({ path });
		await settle();

		expect(controller.snapshot()).toMatchObject({
			phase: 'group',
			path,
			message: 'Roon lists 2 identical entries — merge them in Roon',
			group: {
				path,
				targets: [{ ref: ref('duplicate:one') }, { ref: ref('duplicate:two') }]
			}
		});
		expect(openRef).not.toHaveBeenCalled();
	});

	it('lands the level of the page that is open, never of one already replaced', async () => {
		let release: (value: LibraryOpenResponse) => void = () => {};
		const openRef = vi.fn((reference: LibraryRowReference) =>
			reference.token === 'slow'
				? new Promise<LibraryOpenResponse>((resolve) => {
						release = resolve;
					})
				: Promise.resolve(level(GEN, 'second'))
		);
		const { controller } = make({ openRef });
		controller.open({ path: ARTIST_PATH, ref: ref('slow'), title: 'first' });
		controller.open({
			path: { origin: 'artists', steps: [{ kind: 'artist', title: 'Björk' }] },
			ref: ref('fast'),
			title: 'second'
		});
		await settle();
		expect(controller.snapshot()).toMatchObject({ phase: 'ready', target: { title: 'second' } });
		release(level(GEN, 'first'));
		await settle();
		// The superseded read lands nowhere: the page that asked for it is gone.
		expect(controller.snapshot()).toMatchObject({ target: { title: 'second' } });
	});

	it('a reset page stops reading, so a level in flight lands on nothing', async () => {
		let release: (value: LibraryOpenResponse) => void = () => {};
		const { controller } = make({
			openRef: () =>
				new Promise<LibraryOpenResponse>((resolve) => {
					release = resolve;
				})
		});
		controller.open({ path: ARTIST_PATH, ref: ref('artist:’Til Tuesday'), title: '’Til Tuesday' });
		controller.reset();
		release(level(GEN, '’Til Tuesday'));
		await settle();
		expect(controller.snapshot().phase).toBe('idle');
	});

	it('takes Roon’s own heading for the level over the text the row was rendered with', async () => {
		const { controller } = make({
			openRef: async () => level(GEN, 'What Roon calls it')
		});
		controller.open({
			path: ARTIST_PATH,
			ref: ref('artist:’Til Tuesday'),
			title: 'What the row said'
		});
		await settle();
		expect(controller.snapshot().target?.title).toBe('What Roon calls it');
	});

	it('resolves the same page again under a generation that replaced the old one', async () => {
		let generation = GEN;
		const { controller } = make({
			heldRoot: () => artistRoot(generation),
			heldGeneration: () => generation,
			openRef: async (reference) => {
				if (reference.generation !== generation) {
					return { contract: LIBRARY_OPEN_CONTRACT, kind: 'stale' };
				}
				return level(generation, '’Til Tuesday');
			}
		});
		controller.open({ path: ARTIST_PATH, ref: ref('artist:’Til Tuesday'), title: '’Til Tuesday' });
		await settle();
		expect(controller.snapshot().level?.generation).toBe(GEN);

		generation = NEXT_GEN;
		controller.retry();
		await settle();
		const state = controller.snapshot();
		expect(state.phase).toBe('ready');
		expect(state.level?.generation).toBe(NEXT_GEN);
		expect(state.target?.ref.generation).toBe(NEXT_GEN);
		expect(state.target?.title).toBe('’Til Tuesday');
	});

	it('reports a level that could not be read at all, rather than an empty page', async () => {
		const { controller } = make({
			openRef: async () => ({
				contract: LIBRARY_OPEN_CONTRACT,
				kind: 'unavailable',
				reason: 'core-under-pressure',
				message: 'Waiting for your Core.'
			})
		});
		controller.open({ path: ARTIST_PATH, ref: ref('artist:’Til Tuesday'), title: '’Til Tuesday' });
		await settle();
		expect(controller.snapshot()).toMatchObject({
			phase: 'failed',
			stale: false,
			message: 'Waiting for your Core.',
			level: null
		});
	});

	it('opens an album address through its artist, one level at a time', async () => {
		const opened: string[] = [];
		const { controller } = make({
			openRef: async (reference) => {
				opened.push(reference.token);
				return level(GEN, '’Til Tuesday');
			}
		});
		controller.open({
			path: {
				origin: 'artists',
				steps: [
					{ kind: 'artist', title: '’Til Tuesday' },
					libraryAlbumStep('Voices Carry', '’Til Tuesday')
				]
			}
		});
		await settle();
		expect(opened).toEqual(['artist:’Til Tuesday', 'album:’Til Tuesday']);
		expect(controller.snapshot()).toMatchObject({ phase: 'ready' });
	});
});
