import { describe, it, expect } from 'vitest';
import { trackTitle, trackNum, trackTitleCarriesOrdinal } from '../trackTitle';

describe('trackTitle', () => {
	it('strips the single-disc "N. " prefix', () => {
		expect(trackTitle('3. Cornflake Girl')).toBe('Cornflake Girl');
		expect(trackTitle('12. Song')).toBe('Song');
	});

	it('strips the multi-disc "D-T " prefix (with and without dot)', () => {
		expect(trackTitle('1-22 Harlington: Dear Thea')).toBe('Harlington: Dear Thea');
		expect(trackTitle('2-3. Encore')).toBe('Encore');
	});

	it('leaves titles that legitimately start with numbers untouched', () => {
		expect(trackTitle('1979 (Remastered)')).toBe('1979 (Remastered)');
		expect(trackTitle('99 Luftballons')).toBe('99 Luftballons');
		expect(trackTitle('1-800-273-8255')).toBe('1-800-273-8255');
		expect(trackTitle('1-2-3 Yeah')).toBe('1-2-3 Yeah');
	});

	it('leaves unprefixed titles untouched', () => {
		expect(trackTitle('Cornflake Girl')).toBe('Cornflake Girl');
		expect(trackTitle('')).toBe('');
	});
});

describe('trackNum', () => {
	it('extracts single-disc and multi-disc numbers', () => {
		expect(trackNum('3. Cornflake Girl', 0)).toBe('3');
		expect(trackNum('1-22 Harlington: Dear Thea', 0)).toBe('1-22');
		expect(trackNum('2-3. Encore', 0)).toBe('2-3');
	});

	it('falls back to the 1-based row index without a prefix', () => {
		expect(trackNum('Cornflake Girl', 4)).toBe('5');
		expect(trackNum('1979 (Remastered)', 0)).toBe('1');
	});
});

describe('trackTitleCarriesOrdinal', () => {
	it('recognizes titles that begin with their own ordinal', () => {
		expect(trackTitleCarriesOrdinal('1. X')).toBe(true);
		expect(trackTitleCarriesOrdinal('12. X')).toBe(true);
		expect(trackTitleCarriesOrdinal(' 3. X')).toBe(true);
	});

	it('rejects plain titles and near-misses', () => {
		expect(trackTitleCarriesOrdinal('X')).toBe(false);
		expect(trackTitleCarriesOrdinal('1.X')).toBe(false);
		expect(trackTitleCarriesOrdinal('1 X')).toBe(false);
		expect(trackTitleCarriesOrdinal('')).toBe(false);
	});
});
