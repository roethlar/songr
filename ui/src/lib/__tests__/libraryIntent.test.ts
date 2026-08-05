import { describe, expect, it } from 'vitest';
import { normalizeLibraryIntent } from '$lib/libraryIntent';

describe('normalizeLibraryIntent', () => {
	it('normalizes and freezes all five semantic arms', () => {
		const values = [
			{
				kind: 'artist',
				destination: 'search',
				query: '  Tilda Arlen  ',
				localDescriptorId: ' artist-1 ',
				display: { title: ' Tilda Arlen ', album: ' Little Aftershocks ' }
			},
			{
				kind: 'general',
				destination: 'search',
				query: '  piano trio ',
				display: { title: ' Search everything ' }
			},
			{ kind: 'general', destination: 'welcome-section', section: 'recently-played' },
			{ kind: 'general', destination: 'explore-path', labelPath: [' Library ', ' Albums '] },
			{
				kind: 'general',
				destination: 'search-category',
				query: ' hamilton ',
				categoryTitle: ' Tracks '
			}
		];

		const normalized = values.map(normalizeLibraryIntent);

		expect(normalized).toEqual([
			{
				kind: 'artist',
				destination: 'search',
				query: 'Tilda Arlen',
				localDescriptorId: 'artist-1',
				display: { title: 'Tilda Arlen', album: 'Little Aftershocks' }
			},
			{
				kind: 'general',
				destination: 'search',
				query: 'piano trio',
				display: { title: 'Search everything' }
			},
			{ kind: 'general', destination: 'welcome-section', section: 'recently-played' },
			{ kind: 'general', destination: 'explore-path', labelPath: ['Library', 'Albums'] },
			{
				kind: 'general',
				destination: 'search-category',
				query: 'hamilton',
				categoryTitle: 'Tracks'
			}
		]);
		for (const intent of normalized) expect(Object.isFrozen(intent)).toBe(true);
		const entity = normalized[0];
		const explore = normalized[3];
		expect(entity && 'display' in entity && Object.isFrozen(entity.display)).toBe(true);
		expect(explore?.destination === 'explore-path' && Object.isFrozen(explore.labelPath)).toBe(
			true
		);
	});

	it.each(['artist', 'album', 'track'])('accepts the %s entity kind', (kind) => {
		expect(normalizeLibraryIntent({ kind, destination: 'search', query: 'Name' })).toEqual({
			kind,
			destination: 'search',
			query: 'Name'
		});
	});

	it.each([
		null,
		[],
		{},
		{ kind: 'general', destination: 'search', query: '   ' },
		{ kind: 'artist', destination: 'search', query: 'Name', localDescriptorId: '' },
		{ kind: 'general', destination: 'welcome-section', section: 'history' },
		{ kind: 'general', destination: 'explore-path', labelPath: [] },
		{ kind: 'general', destination: 'explore-path', labelPath: ['Library', ' '] },
		{ kind: 'general', destination: 'search-category', query: 'x', categoryTitle: '' },
		{ kind: 'general', destination: 'other', query: 'x' },
		{ kind: 'playlist', destination: 'search', query: 'x' },
		{ kind: 'general', destination: 'search', query: 'x', display: { title: 'x', artist: 'y' } }
	])('rejects a malformed semantic value: %j', (value) => {
		expect(normalizeLibraryIntent(value)).toBeNull();
	});

	it.each([
		'itemKey',
		'cachedKey',
		'actionToken',
		'multiSessionKey',
		'interactionHandle',
		'levelHandle',
		'zoneId',
		'onSelect'
	])('rejects forbidden or unknown top-level field %s', (field) => {
		expect(
			normalizeLibraryIntent({
				kind: 'album',
				destination: 'search',
				query: 'Blue',
				[field]: field === 'onSelect' ? () => undefined : 'authority'
			})
		).toBeNull();
	});

	it('rejects sparse Explore label paths', () => {
		const labelPath = new Array<string>(1);
		expect(
			normalizeLibraryIntent({
				kind: 'general',
				destination: 'explore-path',
				labelPath
			})
		).toBeNull();
	});

	it('defensively copies nested values before freezing the normalized result', () => {
		const pathInput = {
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Library', 'Albums']
		};
		const displayInput = {
			kind: 'album',
			destination: 'search',
			query: 'Blue',
			display: { title: 'Blue', artist: 'Joni Mitchell' }
		};
		const normalizedPath = normalizeLibraryIntent(pathInput);
		const normalizedDisplay = normalizeLibraryIntent(displayInput);
		if (normalizedPath?.destination !== 'explore-path') throw new Error('expected explore path');
		if (!normalizedDisplay || !('display' in normalizedDisplay)) {
			throw new Error('expected entity display');
		}

		pathInput.labelPath[0] = 'Changed';
		pathInput.labelPath.push('Injected');
		displayInput.display.title = 'Changed';

		expect(normalizedPath).toEqual({
			kind: 'general',
			destination: 'explore-path',
			labelPath: ['Library', 'Albums']
		});
		expect(normalizedDisplay.display).toEqual({ title: 'Blue', artist: 'Joni Mitchell' });
		expect(() => Array.prototype.push.call(normalizedPath.labelPath, 'Nope')).toThrow();
	});
});
