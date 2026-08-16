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

	it.each(['/library', '/', '/retired-route'])(
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
