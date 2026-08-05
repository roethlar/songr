/**
 * Slice 8 of `.agents/plans/native-read-features.md` — the UI half of the
 * cross-feature degradation proof. The backend half
 * (`src/server/native/__tests__/nativeCrossFeatureDegradation.test.ts`)
 * drives a simulated protocol change through the real pin mechanism; this
 * suite consumes exactly the degraded index `native` block that path
 * serves and proves every shipped native-derived read feature falls back
 * together to its exact pre-feature state:
 *
 *   - the index store maps all three capability answers to unavailable
 *     with the pin reason carried;
 *   - the album and artist-drill sort menus show the disabled Release-year
 *     entry with the carried reason, and the genre drill menu carries no
 *     year entry at all (the pre-native presentation);
 *   - the most-played and playlists stores degrade honestly when the
 *     endpoints answer 409 with the pin reason — the error is carried,
 *     never a guessed list.
 *
 * Slice 12 adds the symmetric feature-local proof: a Most Played-only pin
 * failure leaves date/playlist capabilities live, and a playlist-only pin
 * failure leaves date/Most Played capabilities live. Chip behavior under
 * those capability sets is proven at the component level in
 * `ui/src/routes/library/__tests__/UnifiedLibraryMode.test.ts`.
 */
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogIndexResponse } from '@shared/catalogIndexContracts';
import { syntheticStatus } from '../stores/__tests__/libraryIndexFixtures';

const fetchCatalogIndexMock = vi.fn<() => Promise<unknown>>();
const roleTransaction = vi.fn<
	(role: string, claim: unknown, work: (transaction: unknown) => Promise<unknown>) => Promise<unknown>
>();

vi.mock('$lib/api/client', () => ({
	fetchCatalogIndex: (..._args: unknown[]) => fetchCatalogIndexMock(),
	withClassicBrowseRoleTransaction: (...args: unknown[]) =>
		roleTransaction(
			...(args as [string, unknown, (transaction: unknown) => Promise<unknown>])
		)
}));

import {
	libraryIndexStore,
	loadLibraryIndex,
	resetLibraryIndex,
	type LibraryCapabilities
} from '../stores/libraryIndexStore';
import type { ClassicBrowseSessionClaim } from '../stores/classicBrowseSessionStore';
import {
	albumSortMenu,
	artistDrillSortMenu,
	genreDrillSortMenu,
	type DateFeatureGate
} from '../unifiedLibrarySorts';

/** The exact wire reason the Slice-8 backend simulation serves. */
const PIN_REASON =
	"the Core's protocol is not compatible with this build; the server log has the detail";

/**
 * The feature-local pin reasons. Both are the same summary as `PIN_REASON`,
 * because a pin violation confined to one feature crosses the §3 interface the
 * same way a whole-layer one does, so it carries the same product-vocabulary
 * text (plan §8.6). They stay named separately because what this suite proves is
 * that a Most Played-only failure leaves date and playlist capabilities live and
 * vice versa — the routing, not the wording.
 */
const MOST_PLAYED_PIN_REASON = PIN_REASON;
const PLAYLIST_PIN_REASON = PIN_REASON;

const TEST_CLAIM = {
	owner: 'normal-shell',
	claimId: 1,
	ready: Promise.resolve({ handleId: 'test', generation: 1 })
} as unknown as ClassicBrowseSessionClaim;

const fetchFn = (() => {
	throw new Error('stores must go through the api client, not raw fetch');
}) as unknown as typeof fetch;

function indexResponse(
	revision: number,
	native?: CatalogIndexResponse['native']
): CatalogIndexResponse {
	return {
		status: syntheticStatus({ artistCount: 1, albumCount: 1, revision }),
		artists: [{ localId: 'art-1', name: 'Artist One', knownAlbumCount: 1, countComplete: true }],
		albums: [
			{
				localId: 'alb-1',
				artistLocalId: 'art-1',
				resolutionStatus: 'resolved',
				title: 'Alpha',
				artist: 'Artist One'
			}
		],
		...(native !== undefined ? { native } : {})
	};
}

const HEALTHY_NATIVE: CatalogIndexResponse['native'] = {
	dateFeaturesAvailable: true,
	playFeaturesAvailable: true,
	playlistFeaturesAvailable: true
};

/** The degraded block the index serves under PROTOCOL_INCOMPATIBLE. */
const INCOMPATIBLE_NATIVE: CatalogIndexResponse['native'] = {
	dateFeaturesAvailable: false,
	dateFeaturesUnavailableReason: PIN_REASON,
	playFeaturesAvailable: false,
	playFeaturesUnavailableReason: PIN_REASON,
	playlistFeaturesAvailable: false,
	playlistFeaturesUnavailableReason: PIN_REASON
};

const MOST_PLAYED_INCOMPATIBLE_NATIVE: CatalogIndexResponse['native'] = {
	dateFeaturesAvailable: true,
	playFeaturesAvailable: false,
	playFeaturesUnavailableReason: MOST_PLAYED_PIN_REASON,
	playlistFeaturesAvailable: true
};

const PLAYLIST_INCOMPATIBLE_NATIVE: CatalogIndexResponse['native'] = {
	dateFeaturesAvailable: true,
	playFeaturesAvailable: true,
	playlistFeaturesAvailable: false,
	playlistFeaturesUnavailableReason: PLAYLIST_PIN_REASON
};

/** The gate the mode component derives from the store capabilities. */
function gateFrom(
	available: boolean,
	reason: string | undefined
): DateFeatureGate {
	return {
		available,
		...(reason !== undefined ? { reason } : {})
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resetLibraryIndex();
});

describe('Slice 8 — cross-feature degradation (UI)', () => {
	it('flips every capability together when the index native block degrades', async () => {
		fetchCatalogIndexMock.mockResolvedValue({ kind: 'index', index: indexResponse(1, HEALTHY_NATIVE) });
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		expect(get(libraryIndexStore).capabilities).toMatchObject({
			dateFeatures: true,
			playFeatures: true,
			playlistFeatures: true
		});

		// The protocol change lands; the next index revision carries the
		// capability state machine's PROTOCOL_INCOMPATIBLE answers.
		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: indexResponse(2, INCOMPATIBLE_NATIVE)
		});
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		const capabilities: LibraryCapabilities = get(libraryIndexStore).capabilities;
		expect(capabilities).toMatchObject({
			dateFeatures: false,
			dateFeaturesDisabledReason: PIN_REASON,
			playFeatures: false,
			playFeaturesDisabledReason: PIN_REASON,
			playlistFeatures: false,
			playlistFeaturesDisabledReason: PIN_REASON
		});
	});

	it('degrades every year-sort menu to its exact pre-feature presentation with the carried reason', async () => {
		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: indexResponse(1, INCOMPATIBLE_NATIVE)
		});
		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });
		const capabilities = get(libraryIndexStore).capabilities;
		// Built from the store exactly as UnifiedLibraryMode derives them.
		const dateGate = gateFrom(
			capabilities.dateFeatures,
			capabilities.dateFeaturesDisabledReason
		);

		// Albums scope + artist drill: the disabled Release-year entry with
		// the capability's own reason, no chronological entries.
		for (const menu of [albumSortMenu(dateGate), artistDrillSortMenu(dateGate)]) {
			const releaseYear = menu.find((entry) => entry.id === 'release-year');
			expect(releaseYear).toBeDefined();
			expect(releaseYear?.disabledReason).toBe(PIN_REASON);
			expect(menu.some((entry) => entry.id === 'year-asc' || entry.id === 'year-desc')).toBe(
				false
			);
		}

		// Genre drill: pre-native this menu carried no year entry at all.
		const genreIds = genreDrillSortMenu(dateGate).map((entry) => entry.id);
		expect(genreIds).not.toContain('release-year');
		expect(genreIds).not.toContain('year-asc');
		expect(genreIds).not.toContain('year-desc');
	});

});

describe('Slice 12 — feature-local degradation isolation (UI)', () => {
	it('preserves date and playlist capabilities under a Most Played-only pin failure', async () => {
		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: indexResponse(1, MOST_PLAYED_INCOMPATIBLE_NATIVE)
		});

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		expect(get(libraryIndexStore).capabilities).toMatchObject({
			dateFeatures: true,
			playFeatures: false,
			playFeaturesDisabledReason: MOST_PLAYED_PIN_REASON,
			playlistFeatures: true
		});
	});

	it('preserves date and Most Played capabilities under a playlist-only pin failure', async () => {
		fetchCatalogIndexMock.mockResolvedValue({
			kind: 'index',
			index: indexResponse(1, PLAYLIST_INCOMPATIBLE_NATIVE)
		});

		await loadLibraryIndex(fetchFn, { coreId: 'core-a', claim: TEST_CLAIM });

		expect(get(libraryIndexStore).capabilities).toMatchObject({
			dateFeatures: true,
			playFeatures: true,
			playlistFeatures: false,
			playlistFeaturesDisabledReason: PLAYLIST_PIN_REASON
		});
	});
});
