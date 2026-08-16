# npm: `songr-server`

The headless engine, published as a global npm package. Unlike the other
`packaging/*` targets, this one is not a small manifest pointing at a URL —
`npm pack`/`npm publish` need the actual built payload inside the tarball, so
`patch-and-publish.mjs` operates on a real extracted
`songr-server-<version>.tar.gz` (the same asset the release workflow already
produces via `--server-tar`) rather than a static template.

## Why `bundledDependencies`, not ordinary `dependencies`

Four of this project's runtime dependencies — `node-roon-api`,
`node-roon-api-browse`, `node-roon-api-image`, `node-roon-api-transport` —
are not published to the public npm registry (`npm view node-roon-api` 404s);
the private tree vendors them under `vendor/` and depends on them via
`file:` paths, which only resolve inside this repository's own checkout.
`npm pack`/`npm publish` also strip `node_modules` by default regardless of
`.npmignore` — confirmed empirically, not assumed.

`bundledDependencies` is npm's own mechanism for exactly this: every package
named there has its `node_modules` directory embedded in the published
tarball as-is, verbatim, instead of being re-resolved from the registry at
install time. Confirmed for real, not just read about: patching the actual
`v1.1.3` server payload's `package.json` with `bundledDependencies` set to
all 102 top-level `node_modules` entries, `npm pack --dry-run` reported
`bundled deps: 102` (all of them — nothing dropped), and a real
`npm install -g` from the resulting tarball produced a working
`songr-server` command that booted the real server (logged its real startup
sequence, including SOOD discovery) before being killed.

One caveat found empirically: `bundledDependencies` only bundles a name if
npm's own dependency graph can also resolve it (as a `dependencies` entry or
a real transitive dependency of one) — a name listed with no matching graph
edge is silently dropped, not an error. This is a non-issue for a
`npm ci`-produced `node_modules`, since every top-level entry there already
has a real edge into the graph; it would matter if this script's directory
listing were ever hand-edited.

## What `patch-and-publish.mjs` does

Given an extracted `songr-server-<version>` directory:

1. Renames the package `songr` → `songr-server` (the payload's own
   `package.json` ships as `songr`, matching `product/package.json` — correct
   for the desktop/web build, wrong as an npm package name, since it would
   claim the top-level name for what is only the headless component).
2. Sets `bundledDependencies` to every top-level `node_modules` entry,
   derived from the directory listing at publish time (never hand-maintained
   — a dependency bump changes this list for free).
3. Adds `bin.songr-server` → `bin/songr-server.js`, a two-line wrapper with a
   shebang (the payload's own `dist/index.js` has none, and can't be
   hand-edited in place without every rebuild reintroducing the omission).
4. Drops `devDependencies` and the dev-only `scripts` (`build`, `dev`,
   `lint`, `test*`) — none of the tools they reference (`tsc`, `eslint`,
   `jest`, `playwright`) exist in this bundle, and none of them mean anything
   for a published runtime artifact.
5. Runs `npm publish` (or `npm pack` under `--dry-run`, for local proof
   without touching the registry).

## Publishing

Requires `NPM_TOKEN` — an npm automation token, owner-created at
npmjs.com (Access Tokens → Generate New Token → Automation) and added as a
`roethlar/songr` repo secret. Nothing here can create that token or an npm
account; both are npmjs.com identity, the same category as the AUR account
and the WinGet PAT.
