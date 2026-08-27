import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the UI build revision stamped into kit.version.name.
 *
 * Precedence: PUBLIC_BUILD_REV env (set by the Docker build arg) →
 * git short SHA → `unstamped-<root package.json version>`.
 *
 * Two properties are load-bearing, and they pull in opposite directions:
 *
 * - DETERMINISTIC WITHIN ONE BUILD. `kit.version.name` names the client
 *   runtime's hydration global (`__sveltekit_<hash(revision)>`), and Vite
 *   evaluates this config once per environment (SSR and client). A
 *   per-evaluation value — e.g. a `Date.now()` fallback — splits that
 *   global between the server-rendered fallback HTML and the client
 *   chunks, and the app boots to a black page with
 *   `Cannot read properties of undefined (reading 'data')`. Proven live
 *   2026-08-17 on the git-less publication export tree (public desktop
 *   build). Everything below the git line must therefore be a pure
 *   function of the tree, never of the clock.
 * - NEVER A CONSTANT ACROSS RELEASES (rev-1): SvelteKit uses version.name
 *   to detect stale deployments, and a constant value makes every release
 *   look identical to a client left open across a redeploy — a failed old
 *   hashed-chunk import then never triggers recovery. The root manifest
 *   version changes with every release, which is the granularity real
 *   redeploys happen at; the git-less flows that reach the fallback
 *   (publication export tree, Docker without SOURCE_COMMIT) are exactly
 *   the versioned-release flows.
 *
 * If none of env, git, or the root manifest can supply an identity, the
 * build fails loudly instead of shipping a page that can never boot.
 *
 * Plain JS (not TS) because svelte.config.js imports it directly at
 * config-load time, outside any build transform.
 *
 * The exec and version seams are typed loosely on purpose: they exist so
 * tests can inject fakes; execSync's overload set is stricter than any
 * useful common signature.
 *
 * @param {{ env?: Record<string, string | undefined>, exec?: any, version?: () => string | null }} [deps]
 * @returns {string}
 */
export function resolveBuildRevision({
	env = process.env,
	exec = execSync,
	version = readRootManifestVersion
} = {}) {
	const fromEnv = env.PUBLIC_BUILD_REV && env.PUBLIC_BUILD_REV.trim();
	if (fromEnv) return fromEnv;
	try {
		return exec('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		// Building outside a git checkout with no explicit stamp.
		const rootVersion = version();
		if (rootVersion !== null) return `unstamped-${rootVersion}`;
		throw new Error(
			'Cannot resolve a build revision: no PUBLIC_BUILD_REV, no git metadata, ' +
				'and no readable root package.json version. Set PUBLIC_BUILD_REV.'
		);
	}
}

/**
 * The release version from the repository-root manifest — `ui/src/lib/`
 * sits exactly three levels below it in every tree layout this project
 * builds from (checkout, Docker stage, publication export tree).
 *
 * @returns {string | null}
 */
function readRootManifestVersion() {
	try {
		const manifestPath = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../../../package.json'
		);
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		return typeof manifest.version === 'string' && manifest.version.trim() !== ''
			? manifest.version.trim()
			: null;
	} catch {
		return null;
	}
}
