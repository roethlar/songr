/**
 * The public browser fixture: the Classic browse grid, mounted on deterministic
 * synthetic data.
 *
 * This page exists so `npm run test:browser` stays load-bearing in a checkout
 * without the extended-feature layer. The walled specs under `../native/` cover
 * the extended surfaces and are simply absent there, so without a public page
 * the suite would pass by being empty — which proves nothing.
 *
 * `ItemGrid` is the right subject: it is Classic browse UI, and it imports only
 * `$lib/imageUrl`, `$lib/actions/imageFallback` and the shared `BrowseItem` type,
 * none of which touch the extended layer.
 *
 * Every title here is invented. Nothing on this page may come from a real
 * library — that is the whole difference between this fixture and the walled
 * ones, and `.agents/publication-fixture-manifest.json` records it.
 */
import { mount } from 'svelte';

import ItemGrid from '../../src/lib/components/ItemGrid.svelte';
import type { BrowseItem } from '../../../src/shared/types';
import '../../src/routes/library/unified-surface.css';

const items: BrowseItem[] = [
	{ title: 'Placeholder Suite No. 1', subtitle: 'Fixture Ensemble', itemKey: 'fixture-key-1' },
	{ title: 'Placeholder Suite No. 2', subtitle: 'Fixture Ensemble', itemKey: 'fixture-key-2' },
	{ title: 'Synthetic Étude', subtitle: 'Test Signal Quartet', itemKey: 'fixture-key-3' }
];

const target = document.getElementById('app');
const clicked = document.querySelector('[data-testid="classic-grid-clicked"]');
if (!target) throw new Error('fixture host element is missing');

mount(ItemGrid, {
	target,
	props: {
		items,
		onItemClick: (item: BrowseItem) => {
			if (clicked) clicked.textContent = item.title;
		}
	}
});
