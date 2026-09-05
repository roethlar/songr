import { describe, it, expect } from 'vitest';
import { normalizeCollectionDrillOpenLocator, COLLECTION_DRILL_SOURCE_CONTRACT } from '@shared/collectionDrillContracts';

const L = {
	sourceContract: COLLECTION_DRILL_SOURCE_CONTRACT,
	hierarchy: 'genres' as const,
	collectionExactName: 'Bright Machinery',
	rendering: { exactTitle: 'Harbour Lantern', exactCredit: 'The Paper Fleet' }
};

describe('dbg', () => {
	it('shows which reject', () => {
		for (const [label, locator] of [
			['hierarchy', { ...L, hierarchy: 'albums' }],
			['name', { ...L, collectionExactName: '' }],
			['rendering', { ...L, rendering: { exactTitle: '', exactCredit: '' } }],
			['extra', { ...L, extra: true }]
		] as const) {
			console.log(label, JSON.stringify(normalizeCollectionDrillOpenLocator(locator)));
		}
	});
});
