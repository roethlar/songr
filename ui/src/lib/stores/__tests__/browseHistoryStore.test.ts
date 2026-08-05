import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

async function importStore() {
	vi.resetModules();
	return await import('../browseHistoryStore');
}

const V4_KEY = 'roon-controller-browse-history-v4';
const V3_KEY = 'roon-controller-browse-history-v3';

const browseContext = { hierarchy: 'browse' as const };
const searchContext = (query = 'jazz') => ({ hierarchy: 'search' as const, query });
const breadcrumb = (title: string) => ({ title });
const step = (hierarchy: 'browse' | 'search', title: string) => ({
	hierarchy,
	breadcrumb: breadcrumb(title)
});
const v4Envelope = (snapshot: unknown) => ({ schemaVersion: 4, snapshot });
const legacyStep = (hierarchy: 'browse' | 'search', itemKey: string, title?: string) => ({
	hierarchy,
	itemKey,
	zoneId: 'legacy-zone',
	multiSessionKey: 'legacy-session',
	...(title === undefined ? {} : { breadcrumb: { title } })
});

describe('browseHistoryStore v4 semantic boundary', () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it('records only keyless breadcrumbs and clears forward on push', async () => {
		const store = await importStore();
		expect(store.pushHistory(browseContext, breadcrumb('Albums'))).toBe(true);
		expect(store.pushHistory(browseContext, breadcrumb('Artist'))).toBe(true);
		store.popHistory();
		expect(get(store.browseHistoryStore).forward).toHaveLength(1);
		expect(store.pushHistory(browseContext, breadcrumb('Genres'))).toBe(true);

		expect(get(store.browseHistoryStore)).toEqual({
			context: browseContext,
			history: [step('browse', 'Albums'), step('browse', 'Genres')],
			forward: []
		});
		const raw = sessionStorage.getItem(V4_KEY)!;
		expect(raw).not.toContain('itemKey');
		expect(raw).not.toContain('legacy-zone');
		expect(raw).not.toContain('multiSessionKey');
	});

	it('starts a fresh explicit context when hierarchy or search query changes', async () => {
		const store = await importStore();
		store.pushHistory(browseContext, breadcrumb('Albums'));
		store.pushHistory(searchContext('jazz'), breadcrumb('Artists'));
		store.pushHistory(searchContext('fusion'), breadcrumb('Albums'));

		expect(get(store.browseHistoryStore)).toEqual({
			context: searchContext('fusion'),
			history: [step('search', 'Albums')],
			forward: []
		});
	});

	it('rejects non-semantic or malformed push input without mutating state', async () => {
		const store = await importStore();
		store.pushHistory(browseContext, breadcrumb('Albums'));
		const before = store.getClassicHistorySnapshot();

		expect(
			store.pushHistory(
				browseContext,
				{ title: 'Injected', itemKey: 'forbidden' } as never
			)
		).toBe(false);
		expect(store.pushHistory(searchContext(''), breadcrumb('Search'))).toBe(false);
		expect(get(store.browseHistoryStore)).toEqual(before);
	});

	it('preserves an explicit search root through back and forward', async () => {
		const store = await importStore();
		store.pushHistory(searchContext(), breadcrumb('Artists'));

		expect(store.popHistory()).toEqual(step('search', 'Artists'));
		expect(get(store.browseHistoryStore)).toEqual({
			context: searchContext(),
			history: [],
			forward: [step('search', 'Artists')]
		});
		expect(store.popForward()).toEqual(step('search', 'Artists'));
		expect(get(store.browseHistoryStore).history).toEqual([step('search', 'Artists')]);
	});

	it('returns undefined for empty back and forward stacks', async () => {
		const store = await importStore();
		expect(store.popHistory()).toBeUndefined();
		expect(store.popForward()).toBeUndefined();
	});

	it('resets to either explicit root and defaults to browse root', async () => {
		const store = await importStore();
		store.pushHistory(browseContext, breadcrumb('Albums'));
		store.resetHistory(searchContext('ambient'));
		expect(get(store.browseHistoryStore)).toEqual({
			context: searchContext('ambient'),
			history: [],
			forward: []
		});

		store.resetHistory();
		expect(get(store.browseHistoryStore)).toEqual({
			context: browseContext,
			history: [],
			forward: []
		});
	});

	it('replaces the complete snapshot atomically and rejects mismatched contexts', async () => {
		const store = await importStore();
		const replacement = {
			context: searchContext(),
			history: [step('search', 'Artists')],
			forward: [step('search', 'Albums')]
		};
		expect(store.replaceHistory(replacement)).toBe(true);
		replacement.history[0].breadcrumb.title = 'Mutated outside';
		expect(get(store.browseHistoryStore).history[0].breadcrumb.title).toBe('Artists');

		expect(
			store.replaceHistory({
				context: browseContext,
				history: [step('search', 'Wrong hierarchy')],
				forward: []
			})
		).toBe(false);
		expect(get(store.browseHistoryStore).context).toEqual(searchContext());
	});

	it('returns and publishes defensive copies', async () => {
		const store = await importStore();
		store.pushHistory(browseContext, breadcrumb('Albums'));
		const fromGetter = store.getClassicHistorySnapshot();
		const fromSubscription = get(store.browseHistoryStore);
		fromGetter.history[0].breadcrumb.title = 'Getter mutation';
		fromSubscription.history[0].breadcrumb.title = 'Subscriber mutation';

		expect(store.getClassicHistorySnapshot().history[0].breadcrumb.title).toBe('Albums');
	});

	describe('strict v4 persistence', () => {
		it('writes and rehydrates an exact versioned envelope', async () => {
			let store = await importStore();
			store.pushHistory(searchContext(), {
				title: 'Artists',
				subtitle: '12 Results',
				searchCategory: true
			});
			const parsed = JSON.parse(sessionStorage.getItem(V4_KEY)!);
			expect(parsed).toEqual(
				v4Envelope({
					context: searchContext(),
					history: [
						{
							hierarchy: 'search',
							breadcrumb: {
								title: 'Artists',
								subtitle: '12 Results',
								searchCategory: true
							}
						}
					],
					forward: []
				})
			);

			store = await importStore();
			expect(get(store.browseHistoryStore).context).toEqual(searchContext());
			expect(get(store.browseHistoryStore).history[0].breadcrumb.title).toBe('Artists');
		});

		it.each([
			['extra envelope key', { ...v4Envelope({ context: browseContext, history: [], forward: [] }), extra: true }],
			['wrong schema version', { schemaVersion: 3, snapshot: { context: browseContext, history: [], forward: [] } }],
			['extra snapshot key', v4Envelope({ context: browseContext, history: [], forward: [], itemKey: 'nope' })],
			['extra context key', v4Envelope({ context: { ...browseContext, query: 'nope' }, history: [], forward: [] })],
			['mismatched step', v4Envelope({ context: browseContext, history: [step('search', 'Artists')], forward: [] })],
			['extra breadcrumb key', v4Envelope({ context: browseContext, history: [{ hierarchy: 'browse', breadcrumb: { title: 'Albums', itemKey: 'nope' } }], forward: [] })]
		])('fails closed on %s without rewriting the stored bytes', async (_name, value) => {
			const raw = JSON.stringify(value);
			sessionStorage.setItem(V4_KEY, raw);
			const store = await importStore();

			expect(get(store.browseHistoryStore)).toEqual({
				context: browseContext,
				history: [],
				forward: []
			});
			expect(sessionStorage.getItem(V4_KEY)).toBe(raw);
		});

		it('fails closed on malformed JSON without rewriting it', async () => {
			sessionStorage.setItem(V4_KEY, 'not-json');
			const store = await importStore();
			expect(get(store.browseHistoryStore).history).toEqual([]);
			expect(sessionStorage.getItem(V4_KEY)).toBe('not-json');
		});
	});

	describe('v3 metadata-only migration', () => {
		it('projects a browse path while dropping every authority field', async () => {
			sessionStorage.setItem(
				V3_KEY,
				JSON.stringify({
					history: [legacyStep('browse', 'stale-a', 'Albums'), legacyStep('browse', 'stale-b', 'Artist')],
					forward: [legacyStep('browse', 'stale-c', 'Album')],
					searchQuery: null
				})
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore)).toEqual({
				context: browseContext,
				history: [step('browse', 'Albums'), step('browse', 'Artist')],
				forward: [step('browse', 'Album')]
			});
			const migrated = sessionStorage.getItem(V4_KEY)!;
			expect(migrated).not.toContain('stale-a');
			expect(migrated).not.toContain('legacy-zone');
			expect(migrated).not.toContain('legacy-session');
		});

		it('preserves independently reconstructible search query and breadcrumbs', async () => {
			sessionStorage.setItem(
				V3_KEY,
				JSON.stringify({
					history: [legacyStep('search', 'stale-search', 'Artists')],
					forward: [],
					searchQuery: 'jazz'
				})
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore)).toEqual({
				context: searchContext(),
				history: [step('search', 'Artists')],
				forward: []
			});
		});

		it.each([
			['browse', { history: [], forward: [], searchQuery: null }, browseContext],
			['search', { history: [], forward: [], searchQuery: 'jazz' }, searchContext()]
		])('preserves an explicit %s root', async (_name, legacy, expectedContext) => {
			sessionStorage.setItem(V3_KEY, JSON.stringify(legacy));
			const store = await importStore();
			expect(get(store.browseHistoryStore)).toEqual({
				context: expectedContext,
				history: [],
				forward: []
			});
		});

		it('discards an entire unreconstructible active path instead of replaying a key', async () => {
			sessionStorage.setItem(
				V3_KEY,
				JSON.stringify({
					history: [legacyStep('browse', 'only-authority'), legacyStep('browse', 'stale-child', 'Child')],
					forward: [legacyStep('browse', 'stale-forward', 'Forward')],
					searchQuery: null
				})
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore)).toEqual({
				context: browseContext,
				history: [],
				forward: []
			});
			expect(sessionStorage.getItem(V4_KEY)).not.toContain('only-authority');
		});

		it('returns a search path without a valid query to the browse safe root', async () => {
			sessionStorage.setItem(
				V3_KEY,
				JSON.stringify({
					history: [legacyStep('search', 'stale', 'Artists')],
					forward: [],
					searchQuery: ''
				})
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore)).toEqual({
				context: browseContext,
				history: [],
				forward: []
			});
		});

		it('drops an independently invalid forward stack while retaining valid history', async () => {
			sessionStorage.setItem(
				V3_KEY,
				JSON.stringify({
					history: [legacyStep('browse', 'stale', 'Albums')],
					forward: [{ ...legacyStep('browse', 'stale-forward', 'Forward'), unexpected: true }],
					searchQuery: null
				})
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore)).toEqual({
				context: browseContext,
				history: [step('browse', 'Albums')],
				forward: []
			});
		});

		it('does not fall back to v3 when a v4 entry exists but is invalid', async () => {
			sessionStorage.setItem(V4_KEY, 'not-json');
			sessionStorage.setItem(
				V3_KEY,
				JSON.stringify({
					history: [legacyStep('browse', 'stale', 'Albums')],
					forward: [],
					searchQuery: null
				})
			);
			const store = await importStore();
			expect(get(store.browseHistoryStore).history).toEqual([]);
		});

		it('ignores older storage versions', async () => {
			sessionStorage.setItem(
				'roon-controller-browse-history-v2',
				JSON.stringify({ history: [legacyStep('browse', 'legacy', 'Albums')], forward: [] })
			);
			const store = await importStore();
			expect(get(store.browseHistoryStore).history).toEqual([]);
		});
	});
});
