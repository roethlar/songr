import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Publication boundary, §3 enforcement on the UI side.
 *
 * The backend gets this from an ESLint rule. This side has no ESLint at all —
 * its pipeline is `svelte-check` and this test runner — so the rule is expressed
 * as a test, which means it binds in the check that already runs rather than in
 * a new script somebody has to remember to call.
 *
 * It also has to exist separately from the backend rule because `src/shared/` is
 * consumed here through the `@shared/*` alias: a backend-only rule cannot see
 * this half of the surface (`.agents/plans/publication.md` §3 says so directly).
 *
 * What is allowed to cross: `@libraryFeatures`, and nothing else. That alias is
 * this side's equivalent of the backend's single interface module — it is
 * resolved at config-load time by `resolveScopeSlots.js`, to the walled slots
 * when they exist on disk and to the committed absent slots when they do not.
 * Public code naming it is the mechanism working, not a violation.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** ui/src */
const UI_SRC = path.resolve(here, '..', '..');
/** repo root */
const REPO_ROOT = path.resolve(UI_SRC, '..', '..');

/**
 * Walled ROUTE roots are discovered by their `.walled-root` marker rather
 * than named here: naming one would put a private route path into this
 * published file (ms2-7). A public export carries neither the routes nor
 * the markers, so discovery honestly yields nothing there.
 */
function discoverMarkedRouteRoots(): string[] {
	const routesDirectory = path.join(UI_SRC, 'routes');
	return readdirSync(routesDirectory)
		.map((entry) => path.join(routesDirectory, entry))
		.filter(
			(candidate) =>
				statSync(candidate).isDirectory() &&
				(() => {
					try {
						return statSync(path.join(candidate, '.walled-root')).isFile();
					} catch {
						return false;
					}
				})()
		);
}

/** The walled roots on this side, as absolute paths. Kept in step with the
 * scanner config's walled-roots group (pinned in inventoryData.test.ts). */
const WALLED_UI_ROOTS = [
	path.join(UI_SRC, 'lib', 'native'),
	path.join(UI_SRC, 'routes', 'library', 'native'),
	...discoverMarkedRouteRoots()
];

/** The walled root inside the shared tree, reached from here via `@shared/*`. */
const WALLED_SHARED_ROOT = path.join(REPO_ROOT, 'src', 'shared', 'native');

const SOURCE_EXTENSIONS = ['.ts', '.js', '.svelte'];

/**
 * Import specifiers, in every form the UI actually writes them: static imports,
 * re-exports, and dynamic imports.
 *
 * The static alternative's gap is statement-bounded (`[^;'"`]*?`, never
 * `[\s\S]*?`), so it cannot skip over a dynamic `import("…")`'s quoted
 * specifier on the way to a later `from` and swallow it (pub-11). Kept in
 * step with the backend matcher in `src/tooling/publication/crossWall.ts`.
 */
const SPECIFIER_PATTERN =
	/(?:\bimport\b|\bexport\b)[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;

function isInside(candidate: string, directory: string): boolean {
	const relative = path.relative(directory, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function collectSourceFiles(directory: string, found: string[] = []): string[] {
	for (const entry of readdirSync(directory)) {
		if (entry === 'node_modules') continue;
		const full = path.join(directory, entry);
		if (statSync(full).isDirectory()) {
			collectSourceFiles(full, found);
			continue;
		}
		if (SOURCE_EXTENSIONS.includes(path.extname(entry))) found.push(full);
	}
	return found;
}

function specifiersIn(contents: string): string[] {
	const specifiers: string[] = [];
	for (const match of contents.matchAll(SPECIFIER_PATTERN)) {
		const specifier = match[1] ?? match[2] ?? match[3];
		if (specifier) specifiers.push(specifier);
	}
	return specifiers;
}

/**
 * Where a specifier lands, or null when it is not a path into this repo (a bare
 * package, `$app/*` stubs, or the sanctioned `@libraryFeatures` crossing).
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
	if (specifier === '@libraryFeatures') return null;
	if (specifier.startsWith('$lib/')) {
		return path.join(UI_SRC, 'lib', specifier.slice('$lib/'.length));
	}
	if (specifier.startsWith('@shared/')) {
		return path.join(REPO_ROOT, 'src', 'shared', specifier.slice('@shared/'.length));
	}
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		return path.resolve(path.dirname(fromFile), specifier);
	}
	return null;
}

describe('publication wall, UI side', () => {
	it('no file outside a walled root imports from inside one', () => {
		const walledRoots = [...WALLED_UI_ROOTS, WALLED_SHARED_ROOT];
		const violations: string[] = [];

		const selfPath = path.join(here, 'publicationWall.test.ts');

		for (const file of collectSourceFiles(UI_SRC)) {
			if (WALLED_UI_ROOTS.some((root) => isInside(file, root))) continue;
			// This file quotes crossings on purpose, in the case below.
			if (file === selfPath) continue;
			const contents = readFileSync(file, 'utf8');
			for (const specifier of specifiersIn(contents)) {
				const resolved = resolveSpecifier(file, specifier);
				if (!resolved) continue;
				if (walledRoots.some((root) => isInside(resolved, root))) {
					violations.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
				}
			}
		}

		expect(
			violations,
			[
				'Publication boundary: code outside a walled root may not import from inside one.',
				'Resolve extended library scopes through the @libraryFeatures slot registry instead',
				'(see .agents/plans/publication.md §3). Offending imports:',
				...violations.map((entry) => `  ${entry}`)
			].join('\n')
		).toEqual([]);
	});

	it('actually recognizes a crossing, so a pass means something', () => {
		// Guards the guard: if the specifier patterns or the alias mapping ever
		// stop matching, this fails rather than the suite silently passing on an
		// empty scan.
		const pretendFile = path.join(UI_SRC, 'routes', 'library', 'UnifiedLibraryMode.svelte');
		const crossings = [
			"import Thing from '../library/native/UnifiedPlaylistsView.svelte';",
			"import type { X } from '$lib/native/stores/unifiedPlaylistsStore';",
			"import type { Y } from '@shared/native/playlistContracts';",
			"export { Z } from './native/scopeSlots';"
		];

		for (const line of crossings) {
			const [specifier] = specifiersIn(line);
			expect(specifier, `no specifier parsed out of: ${line}`).toBeDefined();
			const resolved = resolveSpecifier(pretendFile, specifier);
			expect(resolved, `specifier did not resolve: ${specifier}`).not.toBeNull();
			expect(
				[...WALLED_UI_ROOTS, WALLED_SHARED_ROOT].some((root) =>
					isInside(resolved as string, root)
				),
				`not recognized as a wall crossing: ${specifier}`
			).toBe(true);
		}
	});

	it('leaves the sanctioned crossing alone', () => {
		expect(resolveSpecifier(path.join(UI_SRC, 'routes', 'library', 'x.svelte'), '@libraryFeatures')).toBeNull();
	});

	it('sees a dynamic import that a later `from` would otherwise swallow (pub-11)', () => {
		// The trap shape: an `export` keyword, then a dynamic import into the
		// wall, then an unrelated static `import ... from`. The old
		// SPECIFIER_PATTERN matched from `export` through to the static
		// import's `from`, consuming the quoted walled specifier inside its
		// lazy gap — a real cross-wall dynamic import would pass this suite
		// vacuously.
		const contents = [
			'export const marker = 1;',
			"export async function load() { return import('$lib/native/stores/unifiedPlaylistsStore'); }",
			"import { local } from './localThing';"
		].join('\n');
		const specifiers = specifiersIn(contents);
		expect(specifiers).toContain('$lib/native/stores/unifiedPlaylistsStore');
		expect(specifiers).toContain('./localThing');
	});
});
