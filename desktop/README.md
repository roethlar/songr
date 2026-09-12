# Desktop shell

An Electron wrapper that runs the controller's own backend as a child process
and shows it in a window, so the machine in front of you needs no browser tab
and no separately installed server. The appliance install (Raspberry Pi, NAS,
Docker) is untouched by this workspace and never pulls Electron in.

This workspace has its own `package.json`, `node_modules` and TypeScript build.
Nothing here is added to the repository-root or `ui/` toolchains.

## How it works

- **Engine** — the compiled backend (`dist/index.js` at the repository root),
  forked with `child_process.fork` so it runs as a plain Node child with an IPC
  channel. It is started with `PORT=0`, so the operating system picks a free
  port and the child reports it back over IPC once it is bound
  (`{ type: 'listening', port }`).
- **Data** — the child's `CONFIG_DIR` and `DATA_DIR` point at subdirectories of
  Electron's per-user `userData` directory, so the desktop app never writes
  into the checkout it was launched from.
- **Window** — one `BrowserWindow`. It opens immediately on a local "starting"
  page, switches to `http://127.0.0.1:<port>` when the engine reports its port,
  and falls back to a local error page with a retry button if the engine never
  gets there. (A second, small window holds the advanced settings page.)
- **Lifecycle** — `src/engineLifecycle.ts` holds the state machine (spawn →
  wait for the handshake → running → relaunch with capped backoff → stopped).
  It imports nothing from Electron, which is what makes it unit-testable.
- **One instance** — a second launch focuses the window that already exists
  instead of starting a second engine.
- **Tray** — the app lives in the tray (the menu bar on macOS). Its menu is
  Show/Hide Window, Play/Pause, Next, Previous, Advanced Settings…, Quit, and
  its tooltip is the current "Artist — Title" or "Nothing playing". Closing the
  window hides it; only Quit ends the app, and Quit still waits for the engine
  to be gone.
- **Shutdown** — three layers, because an orphaned engine holds its port and
  stays registered with the Roon Core. Quit asks the child to stop and kills it
  after a grace period; if the shell itself is killed outright, the child sees
  its IPC channel close and shuts itself down
  (`src/server/parentDisconnectWatchdog.ts` in the repository root, a strict
  no-op for the appliance install, which has no IPC channel).

## Advanced settings

Advanced settings are available from the main Settings menu and the tray's
**Advanced Settings…** item. Both options are off by default. They live in
`shell-settings.json` in
Electron's per-user `userData` directory, a versioned JSON document read once at
startup. A file that is missing, unreadable, not JSON, or stamped with a version
this build does not know produces the defaults and a logged warning; the app
always starts. Changes take effect on the next launch, and the page says so.

- **Use another server** (`serverUrl`) — point the window at a controller
  running elsewhere instead of spawning one here. Only `http:`/`https:` URLs are
  accepted; anything else is logged and treated as unset. In this mode the shell
  spawns **no engine at all**, the tray socket connects to that origin, and the
  navigation policy's allowed origin becomes that origin. If the server does not
  answer, the window shows the same error page with a retry button, and retry
  re-attempts *that server* — it never silently starts a local engine, because a
  machine running two engines has two Roon extensions and
  two sets of settings, with nothing on screen to say which one you are looking
  at.
- **Serve on the local network** (`serveOnNetwork`, `networkPort`, default
  3333) — bind the spawned engine to `0.0.0.0` on a fixed port instead of an
  ephemeral loopback one, so other devices can open it in a browser. It changes
  the engine's `HOST`/`PORT` environment and nothing else. The page states the
  trusted-LAN/no-auth caveat the moment the toggle goes on: this is the same
  posture as the appliance install, and there is no password on it.

The decision logic is pure and unit-tested: `src/shellSettings.ts` (load,
validate, save — never throws) and `src/shellMode.ts` (local vs remote, which
origin the window may load, and which load failures deserve the error page).

## How the tray talks to the engine

The tray is an ordinary Socket.IO client on the same loopback origin the window
loads, using the surface the browser UI already uses. No endpoint exists for
the tray and none was added.

- Reads: `zones` (snapshot on connect), `zone-updated`, `zone-removed`,
  `now-playing-updated`.
- Writes: `transport:play-pause`, `transport:next`, `transport:previous`.

**Which zone?** A Roon setup has many zones and the tray has one Play button.
It controls the zone that is playing; if several are, the one that started
playing most recently; if none is playing, the one that played most recently
during this connection, so pressing Pause from the tray does not disable the
tray. If nothing has played at all, the transport items are disabled. The rule
lives in `src/trayModel.ts` and is unit-tested there.

Linux tray implementations may omit tooltips. The tray glyph and application
icons are rendered from committed SVG sources by
`node desktop/scripts/render-icons.mjs`; macOS uses the template image and its
`@2x` companion. Desktops without a tray can reopen the existing window by
launching Songr again and reach advanced settings from the main Settings menu.

## Dev run

From the repository root, build the backend and the UI once, then start the
shell:

```bash
npm ci                         # repository root, once
npm run build                  # backend -> dist/
npm --prefix ui ci             # once
npm --prefix ui run build      # UI -> ui/build/

npm --prefix desktop ci        # once
npm --prefix desktop start     # compiles desktop/src and runs Electron
```

`npm start` in desktop rebuilds the shell and then starts Electron, so it runs
the current shell sources.
The backend and UI are *not* rebuilt for you — rerun their builds after
changing `src/` or `ui/`.

To point the shell at an engine somewhere else — a different checkout, or an
installed app's payload — set the entry file explicitly:

```bash
ROON_CONTROLLER_ENGINE_ENTRY=/path/to/dist/index.js npm --prefix desktop start
```

## Packaging

```bash
npm --prefix desktop run package              # host platform, installers
npm --prefix desktop run package -- --dir     # unpacked app, no installer
npm --prefix desktop run package -- --linux   # cross-build the Linux set
npm --prefix desktop run package:stage        # build the engine payload only
```

One command, because the artifact needs two programs. `scripts/package-app.mjs`
builds the backend, the UI and the shell; assembles the **engine payload**; and
hands the result to `electron-builder` (`electron-builder.yml`). Output lands in
`release/`, which is git-ignored: `release/payload/engine` is the staged
payload, `release/artifacts` the installers.

**The engine payload** is a directory shaped exactly like a checkout —
`dist/`, `ui/build/`, a production-only `node_modules/` and `package.json` —
copied into the app's resources *outside* the asar archive, because the shell
forks it as a plain Node program and Node cannot read an asar. Three things
about it are easy to get wrong and are therefore checked by the script itself,
which fails rather than producing an app that installs and then does not work:

- **`dist/` and `ui/build/` must be siblings.** The engine resolves its static
  assets from its own compiled location, so a payload with the UI anywhere else
  produces an app that launches, answers the API and shows a blank window. The
  rule lives once, in `src/packaging.ts`, and the staging step asserts its own
  output against it.
- **The vendored `node-roon-api*` packages are `file:` dependencies**, which npm
  installs as symlinks into `vendor/`. A link is useless in an installer, so
  after `npm ci --omit=dev` the script replaces every symlink under the staged
  `node_modules` with a real copy and then refuses to continue if one remains.
- **The payload is copied from its parent directory**, not from itself.
  electron-builder rejects a directory whose path relative to the copy root is
  exactly `node_modules`, before any filter is consulted — so a payload named
  directly in `extraResources` ships without its dependencies and dies on its
  first `require`.

The packaged app runs the engine with `NODE_ENV=production`. That is not
cosmetic either: the engine's logger reaches for a pretty-printing transport
that is a devDependency, and a production-pruned payload does not have it.

### Signing and targets

Local macOS packaging uses the Developer ID identity in the current keychain.
Require signing explicitly when preparing a Mac candidate:

```bash
npm --prefix desktop run package -- --mac -- --arm64 --config.forceCodeSigning=true --config.mac.notarize=false
```

The second `--` sends architecture and electron-builder options through the
wrapper. This command creates a signed local candidate without notarization;
public Mac releases require signing, notarization and verification of both the
application and DMG. The canonical release workflow fails when signing inputs
are missing. Windows releases use Azure Trusted Signing and must pass
Authenticode verification before upload.

| Target | Build host |
|---|---|
| macOS DMG, arm64 and x64 | macOS with Developer ID credentials |
| Linux AppImage/deb, arm64 and x64 | Linux, or supported cross-build tooling on macOS |
| Linux RPM, arm64 and x64 | Linux with `rpmbuild`; installing macOS `rpm` does not provide a Linux RPM build host |
| Windows NSIS, x64 | Windows in release CI, with signing credentials |
| Server tarball | `npm --prefix desktop run package -- --stage-only --server-tar` |

The release matrix is defined in `../.github/workflows/release.yml`. Packaging
does not publish by itself. Release workflows remain disabled during the current
withdrawal; no local build authorizes publication.

### Naming and saved data

Every packaged build uses application id `app.songr.desktop`, product name
`Songr` and runtime name `songr`. The same constants feed the shell manifest and
Linux package names. There is no private-build identity or governance-directory
switch. Preserve these values when preparing updates so existing desktop
settings and pairing data stay associated with the application.

## Tests

```bash
npm --prefix desktop test      # jest: lifecycle, launch plan, tray, wire parsing,
                               #       settings, local/remote mode, packaged layout
npm --prefix desktop run build # tsc
```

The lifecycle tests inject a fake clock and a fake child process, so they cover
the handshake, the handshake timeout, backoff limits and shutdown ordering
without launching Electron or binding a port. The tray tests do the same with a
fake socket: the zone heuristic, the menu derivation and the wire parsing are
all pure, and the Electron `Tray` glue in `src/tray.ts` decides nothing.

The parent-death watchdog is tested on the backend side, in
`src/server/__tests__/parentDisconnectWatchdog.test.ts` at the repository root.

## Updates

The desktop app checks its installed Songr app version against the latest public
GitHub release once at startup, without delaying the window or server startup.
When a newer release is available, choose **View release** to open it in your
browser, or **Later** to keep using the current version. This check is independent
of any remote Songr server and does not compare Electron framework versions.

**About → Check for updates** checks the connected Songr server.
Install updates using your existing package manager or installation method;
Songr does not download or install them automatically. Signing, notarization, platform icons, media controls and first-run
setup already have current implementations; their build and verification steps
are documented above and in the root README.
