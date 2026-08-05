import { describe, it, expect } from 'vitest';
import { extractAlbumChips, extractArtistFromSubtitle, isAlbumPage } from '../albumChips';
import { listResult } from '../../test/fixtures/browse';

describe('extractAlbumChips', () => {
	it('returns empty for undefined / empty subtitle', () => {
		expect(extractAlbumChips(undefined)).toEqual([]);
		expect(extractAlbumChips('')).toEqual([]);
	});

	it('extracts a 4-digit year when separated by a real metadata token (·, /, comma, pipe)', () => {
		expect(extractAlbumChips('Tilda Arlen / 1994')).toEqual([
			{ kind: 'year', label: '1994' }
		]);
		expect(extractAlbumChips('Album · 2024')).toEqual([
			{ kind: 'year', label: '2024' }
		]);
	});

	it('does NOT extract a year embedded in free-form prose (P2 reopen #2 follow-on)', () => {
		// "Released 2024 by Some Label" — no real metadata separator
		// (·, /, comma, pipe) adjacent to 2024. Plain whitespace
		// doesn't qualify, which is what protects against
		// "The 1975"-style false positives.
		expect(extractAlbumChips('Released 2024 by Some Label')).toEqual([]);
	});

	it('ignores 4-digit numbers outside the 19xx/20xx range', () => {
		// Track counts, run lengths, etc. shouldn't masquerade as years.
		expect(extractAlbumChips('Album · 1234')).toEqual([]);
		expect(extractAlbumChips('Album · 2200')).toEqual([]);
	});

	it('returns no chips when subtitle is just an artist name', () => {
		expect(extractAlbumChips('Tilda Arlen')).toEqual([]);
		expect(extractAlbumChips('The Beatles')).toEqual([]);
	});

	it('extracts a format tag (FLAC, MQA, DSD, Hi-Res, etc.)', () => {
		expect(extractAlbumChips('Tilda Arlen / FLAC')).toEqual([
			{ kind: 'format', label: 'FLAC' }
		]);
		expect(extractAlbumChips('Album / 2024 / Hi-Res')).toEqual([
			{ kind: 'year', label: '2024' },
			{ kind: 'format', label: 'Hi-Res' }
		]);
		expect(extractAlbumChips('Some Album · MQA Studio · 2020')).toEqual([
			{ kind: 'year', label: '2020' },
			{ kind: 'format', label: 'MQA Studio' }
		]);
	});

	it('matches the longer/more-specific format tag first (MQA Studio not MQA)', () => {
		const chips = extractAlbumChips('Album · MQA Studio');
		const formats = chips.filter((c) => c.kind === 'format');
		expect(formats).toHaveLength(1);
		expect(formats[0].label).toBe('MQA Studio');
	});

	it('is case-insensitive on format tags', () => {
		expect(extractAlbumChips('album / flac')).toContainEqual({
			kind: 'format',
			label: 'FLAC'
		});
		expect(extractAlbumChips('Album / hi-res')).toContainEqual({
			kind: 'format',
			label: 'Hi-Res'
		});
	});

	it('returns at most one format chip even if subtitle mentions it twice', () => {
		const chips = extractAlbumChips('FLAC remaster / FLAC reissue');
		expect(chips.filter((c) => c.kind === 'format')).toHaveLength(1);
	});

	it('year and format can coexist', () => {
		expect(extractAlbumChips('Pet Sounds · 1966 · FLAC')).toEqual([
			{ kind: 'year', label: '1966' },
			{ kind: 'format', label: 'FLAC' }
		]);
	});
});

describe('isAlbumPage', () => {
	it('false when current is null', () => {
		expect(isAlbumPage(null, false)).toBe(false);
		expect(isAlbumPage(null, true)).toBe(false);
	});

	it('false when not a track list', () => {
		const cur = listResult({ level: 2, subtitle: 'Tilda Arlen', items: [] });
		expect(isAlbumPage(cur, false)).toBe(false);
	});

	it('false at navigation levels (< 2) even if track-list-shaped', () => {
		const cur = listResult({ level: 1, subtitle: 'Tilda Arlen', items: [] });
		expect(isAlbumPage(cur, true)).toBe(false);
	});

	it('true at level 2+ track list with a non-empty subtitle', () => {
		const cur = listResult({ level: 2, subtitle: 'Tilda Arlen', items: [] });
		expect(isAlbumPage(cur, true)).toBe(true);
		const deeper = listResult({ level: 3, subtitle: 'Tilda Arlen', items: [] });
		expect(isAlbumPage(deeper, true)).toBe(true);
	});

	it('P2 reopen: false when inferredAllTracks (Library/Tracks, playlist contents)', () => {
		// Pages that satisfy the track-list size heuristic without any
		// itemType=track row aren't albums — they're flat "all tracks"
		// listings. The 3rd arg = true gates them out.
		const cur = listResult({ level: 2, subtitle: '12345 tracks', items: [] });
		expect(isAlbumPage(cur, true, true)).toBe(false);
		expect(isAlbumPage(cur, true, false)).toBe(true); // sanity: arg gates it
	});

	it('false when subtitle is missing or only whitespace', () => {
		const noSubtitle = listResult({ level: 2, items: [] });
		expect(isAlbumPage(noSubtitle, true)).toBe(false);
		const blank = listResult({ level: 2, subtitle: '   ', items: [] });
		expect(isAlbumPage(blank, true)).toBe(false);
	});
});

describe('extractArtistFromSubtitle (P1 reopen)', () => {
	it('returns empty for undefined / empty', () => {
		expect(extractArtistFromSubtitle(undefined)).toBe('');
		expect(extractArtistFromSubtitle('')).toBe('');
	});

	it('returns the subtitle as-is when no chips are present', () => {
		expect(extractArtistFromSubtitle('Tilda Arlen')).toBe('Tilda Arlen');
		expect(extractArtistFromSubtitle('The Beatles')).toBe('The Beatles');
	});

	it('strips a year and surrounding separators', () => {
		expect(extractArtistFromSubtitle('Tilda Arlen · 1994')).toBe('Tilda Arlen');
		expect(extractArtistFromSubtitle('1994 · Tilda Arlen')).toBe('Tilda Arlen');
		expect(extractArtistFromSubtitle('Tilda Arlen / 1994')).toBe('Tilda Arlen');
	});

	it('strips a format tag and surrounding separators', () => {
		expect(extractArtistFromSubtitle('Tilda Arlen · FLAC')).toBe('Tilda Arlen');
		expect(extractArtistFromSubtitle('FLAC · Tilda Arlen')).toBe('Tilda Arlen');
	});

	it('strips both year and format together (the bug shape from the reopen)', () => {
		expect(extractArtistFromSubtitle('Tilda Arlen · 1994 · FLAC')).toBe('Tilda Arlen');
		expect(extractArtistFromSubtitle('Tilda Arlen / 1994 / FLAC')).toBe('Tilda Arlen');
		expect(extractArtistFromSubtitle('Pet Sounds · 1966 · Hi-Res')).toBe('Pet Sounds');
	});

	it('returns empty when subtitle is ONLY chip tokens', () => {
		expect(extractArtistFromSubtitle('1994 · FLAC')).toBe('');
		expect(extractArtistFromSubtitle('FLAC')).toBe('');
	});

	it('P1 reopen #2: preserves internal artist punctuation (AC/DC, Jay-Z, GZA/Genius)', () => {
		// The prior version collapsed every separator in the result,
		// turning "AC/DC" → "AC DC" and "Jay-Z" → "Jay Z". The fix
		// splices only the matched chip span + ONE adjacent separator
		// and leaves every other char untouched.
		expect(extractArtistFromSubtitle('AC/DC · 1980 · FLAC')).toBe('AC/DC');
		expect(extractArtistFromSubtitle('Jay-Z · 2003 · FLAC')).toBe('Jay-Z');
		expect(extractArtistFromSubtitle('GZA/Genius · 1995')).toBe('GZA/Genius');
		// Artist-only subtitle (no chips at all) returns unchanged.
		expect(extractArtistFromSubtitle('AC/DC')).toBe('AC/DC');
		expect(extractArtistFromSubtitle('Jay-Z')).toBe('Jay-Z');
	});
});

describe('extractAlbumChips: year-as-artist-name guard (P2 reopen #2)', () => {
	it('does NOT chip a year-shaped artist name in the leading position', () => {
		// "The 1975" alone (just the artist) → no year chip.
		expect(extractAlbumChips('The 1975')).toEqual([]);
		expect(extractAlbumChips('1999 (Prince)')).toEqual([]);
	});

	it('finds the LATER year when subtitle is "<artist-with-year-name> · <year>"', () => {
		// "The 1975 · 2022 · FLAC" → chip year = 2022, not 1975.
		const chips = extractAlbumChips('The 1975 · 2022 · FLAC');
		expect(chips).toContainEqual({ kind: 'year', label: '2022' });
		expect(chips).not.toContainEqual({ kind: 'year', label: '1975' });
		expect(chips).toContainEqual({ kind: 'format', label: 'FLAC' });
	});

	it('extractArtistFromSubtitle leaves "The 1975" intact when there is a real album year following', () => {
		expect(extractArtistFromSubtitle('The 1975 · 2022 · FLAC')).toBe('The 1975');
		expect(extractArtistFromSubtitle('The 1975 · 2022')).toBe('The 1975');
	});

	it('extractArtistFromSubtitle leaves a year-named artist alone with no metadata', () => {
		expect(extractArtistFromSubtitle('The 1975')).toBe('The 1975');
		expect(extractArtistFromSubtitle('1999')).toBe('1999');
	});
});

describe('extractAlbumChips word-boundary matching (P3 reopen)', () => {
	it('does NOT match format tags embedded in album / artist names', () => {
		// "Wavves" contains "WAV" but is an artist name, not a format.
		expect(extractAlbumChips('Wavves')).toEqual([]);
		// "Flacid" contains "FLAC".
		expect(extractAlbumChips('Flacid')).toEqual([]);
		// "Mp3 Trees" contains "MP3" only as part of a word.
		expect(extractAlbumChips('Mp3Trees')).toEqual([]);
	});

	it('still matches the same tag when separated by a non-alphanumeric character', () => {
		expect(extractAlbumChips('Wavves · WAV')).toContainEqual({
			kind: 'format',
			label: 'WAV'
		});
		expect(extractAlbumChips('Flacid · FLAC')).toContainEqual({
			kind: 'format',
			label: 'FLAC'
		});
	});

	it('matches hyphenated tags (Hi-Res) even though hyphen is the boundary', () => {
		expect(extractAlbumChips('Album · Hi-Res')).toContainEqual({
			kind: 'format',
			label: 'Hi-Res'
		});
	});
});
