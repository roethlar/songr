import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { resolveLibraryScopeSlotsModule } from '../resolveScopeSlots.js';

/**
 * The alias decision. Every case here injects both the starting directory and
 * the existence probe, so no assertion depends on the real implementation
 * directory being on disk — these tests answer the same way in a checkout that
 * carries it and one that does not, which is the only way a test about absence
 * can mean anything.
 */

const FROM = path.join(path.sep, 'synthetic', 'ui', 'src', 'lib', 'libraryFeatures');
const IMPLEMENTATION = path.join(
	path.sep,
	'synthetic',
	'ui',
	'src',
	'routes',
	'library',
	'native',
	'scopeSlots.ts'
);
const ABSENT = path.join(FROM, 'absentScopeSlots.ts');

describe('resolveLibraryScopeSlotsModule', () => {
	it('resolves the implementation when it is on disk', () => {
		/** @type {string[]} */
		const probed = [];
		const resolved = resolveLibraryScopeSlotsModule({
			from: FROM,
			exists: (candidate) => {
				probed.push(candidate);
				return true;
			}
		});

		expect(resolved).toBe(IMPLEMENTATION);
		// One probe, and it is the implementation entry — not a directory, not
		// a guess derived from the absent module's location.
		expect(probed).toEqual([IMPLEMENTATION]);
	});

	it('falls back to the absent slots when the implementation is not on disk', () => {
		const resolved = resolveLibraryScopeSlotsModule({
			from: FROM,
			exists: () => false
		});

		expect(resolved).toBe(ABSENT);
	});

	it('decides on disk existence alone, with no flag or environment input', () => {
		const asPresent = resolveLibraryScopeSlotsModule({ from: FROM, exists: () => true });
		const asAbsent = resolveLibraryScopeSlotsModule({ from: FROM, exists: () => false });

		expect(asPresent).not.toBe(asAbsent);
		// Both answers are absolute, so every toolchain that maps the alias gets
		// a path it can use whatever its own working directory is.
		expect(path.isAbsolute(asPresent)).toBe(true);
		expect(path.isAbsolute(asAbsent)).toBe(true);
	});

	it('resolves an existing module in this checkout with no arguments at all', () => {
		// The unconfigured call is what the three toolchain configs make. It must
		// land on a real file whether or not this checkout is walled.
		const resolved = resolveLibraryScopeSlotsModule();

		expect(path.isAbsolute(resolved)).toBe(true);
		expect(existsSync(resolved)).toBe(true);
	});
});
