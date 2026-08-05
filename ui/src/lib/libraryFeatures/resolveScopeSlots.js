import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Decide, at config-load time, which module satisfies the library scope slot
 * contract. Every toolchain that resolves `@libraryFeatures` calls this — the
 * SvelteKit build, the unit-test runner and the browser-test server — so all
 * three agree about what the alias means and no build can end up half-walled.
 *
 * The decision is disk existence, not a flag: a checkout that does not carry
 * the implementation directory resolves the absent slots and builds. That is
 * the whole mechanism. A flag would be a second source of truth and would let
 * a build ask for an implementation that is not there.
 *
 * Plain JS, not TypeScript, because svelte.config.js imports it directly at
 * config-load time, outside any build transform. Same reason as
 * buildRevision.js, which set the precedent.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the implementation lives, relative to this file. */
const IMPLEMENTATION_RELATIVE = path.join('..', '..', 'routes', 'library', 'native');
const IMPLEMENTATION_ENTRY = 'scopeSlots.ts';
const ABSENT_ENTRY = 'absentScopeSlots.ts';

/**
 * The absolute path the `@libraryFeatures` alias must point at.
 *
 * The alias targets an exact file rather than a directory on purpose: a
 * directory alias would also resolve `@libraryFeatures/<anything-else>`, which
 * would give public code a second route to modules the wall exists to keep it
 * away from.
 *
 * @param {{ from?: string, exists?: (candidate: string) => boolean }} [deps]
 * @returns {string}
 */
export function resolveLibraryScopeSlotsModule({ from = here, exists = existsSync } = {}) {
	const implementation = path.resolve(from, IMPLEMENTATION_RELATIVE, IMPLEMENTATION_ENTRY);
	if (exists(implementation)) return implementation;
	return path.resolve(from, ABSENT_ENTRY);
}
