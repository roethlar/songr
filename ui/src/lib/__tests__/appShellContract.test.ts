import { describe, expect, it } from 'vitest';
import { resolveAppShellContract } from '../appShellContract';

describe('appShellContract', () => {
	it('keeps every non-Library route on the normal shell regardless of Library mode', () => {
		for (const activeMode of [null, 'classic', 'timeline', 'unified'] as const) {
			expect(resolveAppShellContract('/queue', activeMode)).toEqual({
				presentation: 'normal',
				showClassicChrome: true,
				allowClassicBrowseEffects: true,
				fullBleedWorkspace: false,
				transportPresentation: 'full'
			});
		}
	});

	it('uses the unchanged Classic shell only after Classic is committed on Library', () => {
		expect(resolveAppShellContract('/library', 'classic')).toEqual({
			presentation: 'classic',
			showClassicChrome: true,
			allowClassicBrowseEffects: true,
			fullBleedWorkspace: false,
			transportPresentation: 'full'
		});
	});

	it('uses a full-bleed shell and compact shared transport only for committed Timeline', () => {
		expect(resolveAppShellContract('/library', 'timeline')).toEqual({
			presentation: 'timeline',
			showClassicChrome: false,
			allowClassicBrowseEffects: false,
			fullBleedWorkspace: true,
			transportPresentation: 'compact'
		});
	});

	it('uses a full-bleed shell and the literal reference transport for committed Unified', () => {
		expect(resolveAppShellContract('/library', 'unified')).toEqual({
			presentation: 'unified',
			showClassicChrome: false,
			allowClassicBrowseEffects: false,
			fullBleedWorkspace: true,
			transportPresentation: 'unified'
		});
	});

	it('uses a neutral focused shell while Library has no committed mode', () => {
		expect(resolveAppShellContract('/library', null)).toEqual({
			presentation: 'neutral',
			showClassicChrome: false,
			allowClassicBrowseEffects: false,
			fullBleedWorkspace: false,
			transportPresentation: 'hidden'
		});
	});
});
