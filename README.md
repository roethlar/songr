# Songr

Web-based controller for a local Roon Core, built with Node.js + SvelteKit.

Published desktop and headless server downloads are on
[GitHub Releases](https://github.com/roethlar/songr/releases).
Current release: **1.4.3**. See the [release notes](docs/releases/1.4.3.md).

## Screenshots

Songr 1.4.3 with a real Roon library, in light and dark themes.
| | Light | Dark |
|---|---|---|
| **Album artists** | [![Album artists — Light](product/screenshots/1.4.3/light/artists-album.png)](product/screenshots/1.4.3/light/artists-album.png) | [![Album artists — Dark](product/screenshots/1.4.3/dark/artists-album.png)](product/screenshots/1.4.3/dark/artists-album.png) |
| **Albums** | [![Albums — Light](product/screenshots/1.4.3/light/albums.png)](product/screenshots/1.4.3/light/albums.png) | [![Albums — Dark](product/screenshots/1.4.3/dark/albums.png)](product/screenshots/1.4.3/dark/albums.png) |
| **Track selection** | [![Track selection — Light](product/screenshots/1.4.3/light/tracks-selection.png)](product/screenshots/1.4.3/light/tracks-selection.png) | [![Track selection — Dark](product/screenshots/1.4.3/dark/tracks-selection.png)](product/screenshots/1.4.3/dark/tracks-selection.png) |

[View the full screenshot gallery](product/screenshots/1.4.3/README.md) — Library pages, selection, About and settings in both themes.

## What Works

- Browse and search the library with alphabetic jump lists, filtering, sorting and artwork caching
- Select tracks and recordings for shared Play, Queue and More controls; actions follow the current list order
- Search result drill-down uses an isolated Roon browse session and remaps fresh result keys after re-seeding
- Real-time zone and now-playing updates via Socket.IO (hydrated on page load)
- Transport controls: play/pause, previous/next, seek, volume
- Queue: per-zone subscription, track listing with artwork, play-from-here, shuffle/loop/auto-radio
- Global zone switching, persistent play bar with track/artist deep-links
- System media controls and hardware media keys via the Media Session API (see below)

## Updates

Use **About → Check for updates** to check the connected Songr
server against the latest public GitHub release. If a newer version is
available, Songr recommends updating and links to the release. Install it using
your existing package manager or installation method.

The desktop app also checks its own installed Songr version when it starts,
independently of the server it connects to. A newer desktop release offers
**View release** or **Later**. Checks do not install updates automatically.

## System media controls and media keys

The selected zone's now-playing state is published to the browser's Media
Session API: title, artist, album, artwork and position, with play, pause,
next, previous and seek handlers that send the same socket commands the
on-screen transport buttons send. In Chromium that feeds the OS media surface —
MPRIS on Linux, System Media Transport Controls on Windows, Now Playing on
macOS — so hardware media keys can drive Roon playback.

**Why the page plays a silent audio clip.** A controller plays no audio of its
own, and metadata alone does not get a page onto the OS media surface. The
Media Session spec is explicit that `playbackState` "MUST not affect media
session routing", and the routing itself is the user agent's choice: Chromium
selects the page holding audio focus, based on media elements that are
potentially playing and *not muted*. So while a track is loaded in the selected
zone, the page loops a generated clip of digital silence through one detached
`<audio>` element. It is left unmuted at full volume on purpose — muting it
would remove the player from the media session and defeat the point — and it
carries no signal, so there is nothing to hear. The clip is 20 seconds long
because Chromium treats very short media as a transient sound effect rather
than as media worth a session. Browsers may refuse to start it until the page
has seen a user gesture; it retries on the next click or keypress.

**What is and is not verified.** The repository's Playwright suite proves in
the pinned Chromium that the clip decodes and plays unmuted, that the metadata,
artwork and position payloads are accepted, and that every action handler
registers. Whether a given desktop actually routes its hardware media keys to
the browser is a property of the browser build and the desktop environment, and
no automated test can press a hardware key: MPRIS behaviour on Linux and the
macOS Now Playing panel have not been verified in this repository.

## Library

The Library includes Artists, Albums, Genres, Tracks, Composers, Tags,
Live radio (experimental), Recently played, Bookmarks and Surprise me. Collection
pages support search, sorting, filtering and density control. Long collections and albums use
continuous lists without manual page buttons. Artist, album, genre, composer and
track pages carry durable `/library/...` addresses that survive a reload, a fresh
tab, and Back/Forward.

Open **Settings → Library navigation** to choose the pages on the main row and
their order; **More** contains the rest. Choices are saved by the current Songr
server and shared with its desktop and browser clients. The file is
`DATA_DIR/navigation-preferences.json` (`./data/navigation-preferences.json` by
default). Docker uses the existing `/app/data` volume; an embedded desktop engine
uses Electron's userData/data directory. A desktop connected to a remote server
uses that server's saved choices.

Track lists use selection and shared controls. Select individual tracks, use
Shift for a range, or select all matching the current filter. Play, Queue and
More act on selected tracks in the current list order. Sorting and filtering
preserve valid selections, including selected tracks hidden by the filter. Selecting a row does not start playback.

Artists open grouped by letter; albums and tracks open without letter headings.
To change grouping where available, open Sort and choose Group by letter. The
choice is remembered separately for each collection view.

Tap or click a track to add it to the selection; tap it again to remove it.
Selected titles turn Songr gold. Playback controls, Select all and Clear appear
when something is selected, within the existing page header. Selection is temporary.
Under **Settings → Appearance**, choose Icons, Text or Both for library actions.
Under **Settings → Accessibility**, control smooth scrolling and interface
animations. These preferences persist on the connected Songr server in
`DATA_DIR/presentation-preferences.json` and update its connected clients.
System reduced-motion preferences take precedence. Theme and density remain
local to each client.

Play an entire album from its artwork: hover or focus to reveal Play, or tap the
artwork and then tap Play on a touchscreen. The album's More menu contains Queue
and other available album actions.

**Recently played** records tracks observed while the connected Songr server
was running and connected to Roon; it does not import Roon's earlier history.
Desktop and browser clients of that server share this list. Select one card,
then use **Find in Library** to search its recorded title (or artist when the
title is missing) and choose the current result. Selection does not start playback.

**Bookmarks save tracks, albums and artists in Songr.** Select tracks and use the
Bookmark action in the shared controls, or use Bookmark beside the album or
artist name on its page. Existing Songr favorites appear in **Bookmarks** automatically.

Select a saved entry and choose **Open**. Albums and artists open when there is
one matching current library entry; otherwise Songr shows search results for you
to choose from. **Remove selected** deletes bookmarks. There is no item limit.
Bookmarks are stored on the connected Songr server and shared by its desktop and
browser clients; reload another open client to see changes. They do not change
Roon's hearted favorites or tags.

**Live radio is experimental.** It exposes Roon's My Live Radio list, but playback
has not been tested. Roon returned **No Results** for the library used in the
screenshots. If you use My Live Radio, please
[share feedback or report a problem](https://github.com/roethlar/songr/issues), including the station and whether browsing and starting playback work.

The Artists tab has a compact **Album / All** switch. Album
artists is the default and groups albums by the exact credit Roon supplies;
single-album artists stay included, collaboration credits stay together, and
albums without a credit have their own Unknown album artist group. All artists
shows Roon's full Artists list, including contributors. Songr remembers your
choice, while an explicit page address always wins. Credit groups and their
album/track page addresses can also be saved in browser bookmarks or opened in
a new tab.

The list heading, count, artist-view switch, and Sort controls stay visible
below the scope tabs while the list scrolls.

Songr reads the current library through Roon's public Browse API and does
not retain a separate library catalog. Recently played and Bookmarks are
stored by Songr.

## Upgrading

```bash
git pull && sudo ./scripts/install.sh --reinstall
```

That is the whole upgrade. The install rebuilds the backend and frontend,
preserves pairing/config/data, and restarts the service. Dependencies are
vendored in the repository, so a plain `npm ci` works everywhere — no git
sourcing, no flags.

## Queue API Limitation

Roon's public transport API (`node-roon-api-transport`) does not expose remove/reorder endpoints. All currently available queue controls are implemented.

## Tech Stack

- **Backend**: Node.js, TypeScript, Express, Socket.IO
- **Roon**: `node-roon-api`, `node-roon-api-transport`, `node-roon-api-browse`, `node-roon-api-image`
- **Frontend**: SvelteKit (static adapter — no SSR required)
- **Logging**: Pino

## Repository Layout

```
src/       Backend TypeScript source
ui/        SvelteKit frontend (built to ui/build/)
vendor/    Vendored Roon dependencies (node-roon-api*, pinned commits)
scripts/   Installer scripts (Linux, macOS, Windows)
deploy/    Systemd service template
config/    Roon pairing token (gitignored)
Dockerfile Multi-stage build: backend + frontend → single image/port
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Description | Default |
|---|---|---|
| `HOST` | Bind address. `0.0.0.0` makes the UI reachable on the LAN; set `127.0.0.1` for localhost-only (recommended behind a reverse proxy) | `0.0.0.0` |
| `PORT` | HTTP port (serves API + UI) | `3333` |
| `LOG_LEVEL` | Pino log level. `trace` enables raw Roon payload dumps for debugging | `info` |
| `ROON_TOKEN_PATH` | Roon pairing-state file (paired_core_id + per-core tokens) | `./config/roon-token.json` |
| `IMAGE_CACHE_PATH` | Artwork disk cache | `./data/image-cache` |
| `IMAGE_CACHE_MAX_BYTES` | Disk cache cap (bytes); LRU eviction when exceeded | `10737418240` (10 GB) |
| `RECENTLY_PLAYED_PATH` | JSON file for "Recently played on this controller" persistence | `./data/recently-played.json` |
| `RECENTLY_PLAYED_CAP` | Max entries kept in the rolling list (1-1000) | `50` |
| `FAVORITES_PATH` | JSON file for Songr bookmarks (tracks/albums/artists; existing variable name retained) | `./data/favorites.json` |
| `CLIENT_ORIGIN` | Comma-separated Socket.IO CORS allowlist, or `*` for any | `*` |
| `TRUST_PROXY` | Set to `true` when fronted by a reverse proxy so rate limits identify the real client IP | unset |

### Security notes

- The default `HOST=0.0.0.0` exposes the controller on every interface. There is **no built-in authentication** — anyone reachable on the network can browse, search, and control playback. For a single-purpose home appliance on a trusted LAN this is intentional. For anything broader, bind to `127.0.0.1` and front with a reverse proxy that adds auth, or set `CLIENT_ORIGIN` to your specific frontend origin(s).
- HTTP responses include Helmet defaults (CSP, `X-Content-Type-Options`, etc.). The `/api/*` surface is rate-limited to 600 requests/minute per IP.
- The Roon pairing token is written with file mode `0o600` under a directory created with mode `0o700`.

## Install

Each installer builds from source, deploys to a system directory, and registers a service that starts on boot. Run from the repository root.

### Linux

```bash
sudo ./scripts/install.sh
```

Options: `--port PORT`, `--install-dir DIR` (default: `/opt/roon-controller`), `--user USER` (default: `roon`), `--reinstall`, `--no-start`

### macOS

```bash
sudo ./scripts/install-macos.sh
```

Options: `--port PORT`, `--install-dir DIR` (default: `/opt/roon-controller`), `--reinstall`, `--no-start`

Installs as a launchd daemon. Logs at `/Library/Logs/RoonController/`.

### Windows

Requires [NSSM](https://nssm.cc/) (`winget install nssm` or `choco install nssm`). Run in an elevated PowerShell:

```powershell
.\scripts\install-windows.ps1
```

Options: `-Port`, `-InstallDir` (default: `C:\Program Files\RoonController`), `-Reinstall`, `-NoStart`

### Docker

```bash
cp .env.example .env   # optional — only to override defaults
docker compose build
docker compose up -d
```

With the default paths, the `./config/` and `./data/` volumes persist the Roon
pairing token, artwork cache, Recently played history, Bookmarks, and the
navigation preferences across container restarts. If you
override any persistence path to a location outside those directories, mount
that location separately.

## Local Development

```bash
./scripts/run-local.sh        # installs deps and starts both servers
```

Or manually:

```bash
npm install && npm run dev                        # backend on :3333
cd ui && npm install && npm run dev -- --host     # frontend on :5173 (proxies /api → :3333)
```

## Validation

```bash
npm run build
npm test -- --runInBand
npm run lint
npm --prefix ui run check
npm --prefix ui test
npm --prefix ui run build
```

## Pairing

On first run, Songr searches for your Core and shows its name and connection
progress. Once it requests approval: Roon → Settings → Extensions → enable **Songr (your machine's name)**
(installs paired before mid-2026 may still show the older name "Custom Roon
Controller").

If no Core responds after 15 seconds, the guide shows network/firewall checks
and keeps searching. A discovery timeout does not identify the cause by itself.
Pairing finishes setup immediately. Roon Bridge is optional: install it only
if you want audio playback on this computer, then enable the output in
Roon → Settings → Audio. The final Bridge note does not block the library.

Roon's pairing state — `paired_core_id` plus a per-core token map — is persisted to `ROON_TOKEN_PATH` (mode `0o600`, atomic write). Reconnect is automatic on subsequent starts.

Older builds accidentally let `node-roon-api` write `config.json` in the working directory. On first run, an existing `config.json` in the cwd is migrated to `ROON_TOKEN_PATH` and the cwd copy removed. No action required from you.
