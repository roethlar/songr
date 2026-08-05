import { execSync } from 'node:child_process';

/**
 * Resolve the UI build revision stamped into kit.version.name.
 *
 * Precedence: PUBLIC_BUILD_REV env (set by the Docker build arg) →
 * git short SHA → a unique per-build fallback.
 *
 * The fallback must NEVER be a constant: SvelteKit uses version.name
 * to detect stale deployments, and a constant value (rev-1: 'unknown'
 * on the git-less Docker build path) makes every release look
 * identical to a client left open across a redeploy — a failed old
 * hashed-chunk import then never triggers recovery.
 *
 * Plain JS (not TS) because svelte.config.js imports it directly at
 * config-load time, outside any build transform.
 *
 * The exec seam is typed loosely on purpose: it exists so tests can
 * inject a fake; execSync's overload set is stricter than any useful
 * common signature.
 *
 * @param {{ env?: Record<string, string | undefined>, exec?: any, now?: () => number }} [deps]
 * @returns {string}
 */
export function resolveBuildRevision({ env = process.env, exec = execSync, now = Date.now } = {}) {
	const fromEnv = env.PUBLIC_BUILD_REV && env.PUBLIC_BUILD_REV.trim();
	if (fromEnv) return fromEnv;
	try {
		return exec('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		// Building outside a git checkout with no explicit stamp.
		return `unstamped-${now().toString(36)}`;
	}
}
