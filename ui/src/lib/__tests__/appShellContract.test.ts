import { describe, expect, it } from 'vitest';
import { resolveAppShellContract } from '../appShellContract';

describe('appShellContract', () => {
	it('uses a full-bleed shell and Unified transport for the committed Library', () => {
		expect(resolveAppShellContract('/library', 'unified')).toEqual({
			presentation: 'unified',
			fullBleedWorkspace: true,
			transportPresentation: 'unified'
		});
	});

	it.each([
		'/library/', '/library/artists', '/library/artists/AC%2FDC',
		'/library/albums/record/tracks', '/library/browse'
	])('keeps the committed Library shell on its descendant URL %s', (pathname) => {
		expect(resolveAppShellContract(pathname, 'unified')).toEqual(resolveAppShellContract('/library', 'unified'));
	});

	it.each(['/libraryish', '/library-old', '/libraries', '/Library', '/other/library', '/library%2Ftracks'])(
		'keeps a non-Library lookalike neutral even with an active view at %s', (pathname) => {
			expect(resolveAppShellContract(pathname, 'unified')).toEqual({
				presentation: 'neutral', fullBleedWorkspace: false, transportPresentation: 'hidden'
			});
		}
	);

	it.each(['/library', '/library/', '/library/artists/record', '/', '/retired-route'])(
		'uses the neutral shell without transport before Unified commits at %s',
		(pathname) => {
			expect(resolveAppShellContract(pathname, null)).toEqual({
			presentation: 'neutral',
			fullBleedWorkspace: false,
			transportPresentation: 'hidden'
			});
		}
	);
});
