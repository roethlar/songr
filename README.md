<p align="center">
  <img src="brand/songr-wordmark.svg" alt="Sǫngr" width="300">
</p>

<h1 align="center">Songr</h1>

<p align="center">A browser controller for your Roon Core.</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security">Security</a> ·
  <a href="LICENSE">MIT</a>
</p>

---

Roon ships desktop and mobile control apps, but none for Linux. Songr is a
self-hosted web controller you point a browser at: it pairs with your Core as a
Roon extension, then gives you your library, search, transport, queue, and zones
from any device on the network — including the Linux desktop that otherwise has
no client at all.

It runs as a small Node service on the machine of your choice and serves a static
SvelteKit frontend from the same port. No cloud, no account, no telemetry.

## Screenshots

<p align="center">
  <img src="screenshots/library-artists.png" alt="Artists scope with alphabetic jump rail" width="49%">
  <img src="screenshots/library-albums.png" alt="Albums scope" width="49%">
</p>
<p align="center">
  <img src="screenshots/search-palette.png" alt="Instant search palette" width="80%">
</p>

## Features

**Library.** Artists, Albums, and Genres scopes with alphabetic jump rails and
per-scope sorting, a Recently played scope, and a Surprise me shuffle. Album
sheets show full track listings with artwork. Density control switches between
Compact and Normal, plus a layout tuned for a Raspberry Pi touchscreen.

**Search.** An instant palette — start typing anywhere — with drill-down into
results. Search runs in an isolated browse session, so exploring a result never
disturbs the page you came from.

**Playback.** Play, pause, previous, next, seek, and volume, with a persistent
play bar carrying deep links to the current track and artist. Zone switching is
global, and now-playing state streams over Socket.IO so every open browser stays
in sync.

**Queue.** Per-zone queue with artwork, play-from-here, shuffle, loop, and auto
radio.

**Presentation.** Light and dark themes with a persisted preference, and artwork
cached to disk so browsing a large library stays quick.

## Install

Each installer builds from source, deploys to a system directory, and registers
a service that starts on boot. Run from the repository root.

### Linux

```bash
sudo ./scripts/install.sh
```

Options: `--port PORT`, `--install-dir DIR` (default: `/opt/songr`),
`--user USER` (default: `songr`), `--reinstall`, `--no-start`

### macOS

```bash
sudo ./scripts/install-macos.sh
```

Options: `--port PORT`, `--install-dir DIR` (default: `/opt/songr`),
`--reinstall`, `--no-start`

Installs as a launchd daemon. Logs at `/Library/Logs/Songr/`.

### Windows

Requires [NSSM](https://nssm.cc/) (`winget install nssm` or
`choco install nssm`). Run in an elevated PowerShell:

```powershell
.\scripts\install-windows.ps1
```

Options: `-Port`, `-InstallDir` (default: `C:\Program Files\Songr`),
`-Reinstall`, `-NoStart`

### Docker

```bash
docker compose build
docker compose up -d
```

The `./config/` and `./data/` volumes persist the pairing token, artwork cache,
and Recently played history across restarts. If you override a persistence path
to somewhere outside those directories, mount that location separately.

## Pairing

On first run, open Roon → Settings → Extensions and enable **Songr**.

Roon's pairing state — the paired core id plus its per-core token map — is
written to `ROON_TOKEN_PATH` with file mode `0o600`, under a directory created
with mode `0o700`. Reconnection is automatic on later starts.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Every value has a working
default; a stock install needs no configuration at all.

| Variable | Description | Default |
|---|---|---|
| `HOST` | Bind address. `0.0.0.0` reaches the LAN; `127.0.0.1` is localhost-only (recommended behind a reverse proxy) | `0.0.0.0` |
| `PORT` | HTTP port, serving both API and UI | `3333` |
| `LOG_LEVEL` | Pino log level | `info` |
| `ROON_TOKEN_PATH` | Pairing-state file | `./config/roon-token.json` |
| `IMAGE_CACHE_PATH` | Artwork disk cache | `./data/image-cache` |
| `IMAGE_CACHE_MAX_BYTES` | Cache cap in bytes; LRU eviction past it | `10737418240` (10 GB) |
| `RECENTLY_PLAYED_PATH` | Recently-played persistence file | `./data/recently-played.json` |
| `RECENTLY_PLAYED_CAP` | Entries kept in the rolling list (1–1000) | `50` |
| `FAVORITES_PATH` | Curated favorites file | `./data/favorites.json` |
| `CLIENT_ORIGIN` | Comma-separated Socket.IO CORS allowlist, or `*` for any | `*` |
| `TRUST_PROXY` | Set `true` behind a reverse proxy so rate limits see the real client IP | unset |

## Security

Read this before exposing Songr beyond your own network.

- **There is no built-in authentication.** The default `HOST=0.0.0.0` binds every
  interface, so anyone who can reach the port can browse the library and control
  playback. For a single-purpose appliance on a trusted home LAN that is the
  intended trade-off. For anything broader, bind `127.0.0.1` and front it with a
  reverse proxy that adds authentication, and set `CLIENT_ORIGIN` to your own
  origin instead of `*`.
- Responses carry Helmet defaults, including a content security policy. The
  `/api/*` surface is rate-limited to 600 requests per minute per IP.
- The pairing token is written `0o600` inside a `0o700` directory.

## Upgrading

```bash
git pull && sudo ./scripts/install.sh --reinstall
```

That is the whole upgrade. It rebuilds backend and frontend, preserves pairing,
configuration, and data, then restarts the service. Roon dependencies are
vendored at pinned commits, so a plain `npm ci` works without extra flags.

## Local development

```bash
./scripts/run-local.sh        # installs dependencies, starts both servers
```

Or by hand:

```bash
npm install && npm run dev                        # backend on :3333
cd ui && npm install && npm run dev -- --host     # frontend on :5173, proxies /api
```

Verification:

```bash
npm run build && npm test -- --runInBand && npm run lint
npm --prefix ui run check && npm --prefix ui test -- --run && npm --prefix ui run build
```

## Tech stack

Node.js, TypeScript, Express, Socket.IO, and Pino on the backend. SvelteKit with
the static adapter on the frontend — no SSR. Roon integration uses the official
extension APIs (`node-roon-api` with its transport, browse, and image modules),
vendored at pinned commits.

## Known limitations

- Roon's public transport API exposes no queue remove or reorder operation, so
  Songr implements every queue control that API offers and no more.
- Playback is controlled through your Core; Songr is a controller, not an
  endpoint, and does not output audio itself.

## About the name

*Sǫngr* is Old Norse for "song". The mark is the name in Younger Futhark runes,
ᛋᚬᚾᚴᚱ, drawn as original geometry rather than set in a runic font. The app styles
it `Sǫngr`; everything machine-facing uses the plain ASCII `songr`.

## License

[MIT](LICENSE).

Songr is an independent project and is not affiliated with, endorsed by, or
sponsored by Roon Labs LLC. "Roon" is a trademark of Roon Labs LLC, used here
only to describe what this software interoperates with.
