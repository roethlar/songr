# Flathub: `io.github.roethlar.songr`

Embeds the published Linux AppImage from GitHub Releases, built at Flatpak
build time — not a from-source npm/electron-builder build inside the
sandbox. Same shape as this owner's prior Flathub app
(`io.github.roethlar.AMConfigurator`, from a sibling repo's
`build_tools/package_managers/flatpak.py`), adapted for Songr's own
`finish-args` and app id.

## Why AppImage-embedding, not building Electron from source

Flathub's own sample Electron app (`flathub/org.flathub.electron-sample-app`)
builds from npm source using `org.electronjs.Electron2.BaseApp` and
`zypak-wrapper.sh` to handle Chromium's sandbox under Flatpak's own
bubblewrap sandbox. Embedding the pre-built AppImage instead is far less
work — no `flatpak-node-generator` dependency-locking pass over
`package-lock.json`, no from-source build inside the sandbox — and was
**proven not to need the BaseApp/zypak machinery at all**, for a real,
non-obvious reason:

electron-builder's own `AppRun` script (inside the AppImage, not anything
this repo wrote) already probes `unshare -Ur true` as a heuristic for
whether unprivileged user namespaces are available, and self-adds
`--no-sandbox` to the real Electron binary's argv if they aren't. Flatpak's
own bubblewrap sandbox denies that from inside, so the AppImage disables
Chromium's own (redundant, and normally conflicting) sandbox on its own,
before Electron ever tries to set one up — which is exactly the problem
`zypak-wrapper.sh` exists to solve from the other side. **Confirmed by a
real build, install, and run** on `gabrielle` (an Arch Linux box with
`flatpak`/`flatpak-builder` already present, and the `flathub` remote
already configured) 2026-08-08:

```
flatpak-builder --force-clean --user --install-deps-from=flathub --repo=repo build io.github.roethlar.songr.yml
flatpak remote-add --user --no-gpg-verify --if-not-exists songr-local-test file://$(pwd)/repo
flatpak install --user --noninteractive songr-local-test io.github.roethlar.songr
flatpak run io.github.roethlar.songr --help
```

Full build and install succeeded; the run reached Chromium's own ozone/X11
platform init and failed **only** with "Missing X server or $DISPLAY" — no
sandbox-setup crash, no bwrap nesting failure, no "SUID sandbox helper"
error. That is the expected, harmless failure mode for a headless SSH
session with no display server, and it is meaningfully different from a
sandbox-conflict crash: getting that far means the Electron binary's own
process bring-up, including its internal (self-disabled) sandbox
initialization, completed cleanly inside Flatpak's sandbox. **Not yet
proven: an actual windowed launch** — `Xvfb`/`xvfb-run` aren't installed on
`gabrielle` and installing them needs sudo, not requested.

## The one real build failure hit, and why it isn't cosmetic

The icon **must be exactly 512×512** — `desktop/build/icon.png` is 1024×1024
(the size electron-builder wants for its own icon target), and
`flatpak build-export`'s icon validator hard-rejects an oversized file at
export time with `Image too large (1024x1024). Max. size 512x512`, after the
build itself had already fully succeeded. `io.github.roethlar.songr.png` in
this directory is `desktop/build/icon.png` resized to exactly 512×512
(`sips -z 512 512`) — regenerate it the same way if the source icon ever
changes, rather than assuming any square PNG will do.

## Verified with Flathub's own linter, not just a build

`flatpak-builder-lint` (the tool Flathub's own CI runs — installed via
`flatpak install --user flathub org.flatpak.Builder`) was run against the
real rendered manifest and the real build output on `gabrielle`
2026-08-08, not skipped:

- `manifest io.github.roethlar.songr.yml` → clean, zero findings. Briefly not
  clean on 2026-08-21, when tray permissions were added; they were removed
  again on 2026-08-22 and the manifest lints clean. See "No tray icon,
  deliberately" below.
- First run flagged `runtime-update-available-to-org.freedesktop.Platform-25.08`
  — fixed by moving off `runtime-version: '24.08'` (present already on
  `gabrielle`) onto `'25.08'`, re-verified clean after installing that
  runtime/SDK and rebuilding.
- `repo` → **one real, hard finding, fixed**: `metainfo-missing-screenshots`.
  Flathub requires at least one `<screenshots>` entry; none of the AUR/npm
  precedent had needed one. Fixed with the three already-public, already-vetted
  screenshots from `product/screenshots/` (raw.githubusercontent.com URLs,
  reachability confirmed with a live `curl -I` before committing to them —
  these are not new exposure, the public README already ships them).
- Two remaining `repo`-lint findings — `appstream-external-screenshot-url`,
  `appstream-screenshots-not-mirrored-in-ostree` — are **not local defects**.
  Read from the linter's own source
  (`flatpak_builder_lint/checks/screenshots.py`): the ostree-mirror check is
  explicitly skipped when `config.is_flathub_pipeline()` is false, and an
  external (non-`dl.flathub.org`) screenshot URL is exactly what a submission
  is expected to carry — Flathub's own build pipeline fetches and mirrors it
  to their CDN as part of publishing, which only happens inside their real
  CI. Do not "fix" this by trying to pre-host screenshots on
  `dl.flathub.org` — that isn't something a submitter can do.

## No tray icon, deliberately

The Flatpak ships without a tray icon. Owner ruling 2026-08-22: the tray is not
a wanted feature, so the manifest grants no D-Bus session access at all. **Do
not file this as a bug or "fix" it by adding permissions.**

It is also the only lint-clean option. Measured on KDE Plasma on `gabrielle`
2026-08-21, every configuration that produces a working tray is a
`flatpak-builder-lint` error:

| `finish-args` | linter | tray |
| --- | --- | --- |
| nothing (what ships) | clean | none |
| `--talk-name=org.kde.StatusNotifierWatcher` alone | clean | none |
| `--own-name=org.freedesktop.StatusNotifierItem-2-1` | error | works |
| `--own-name=org.kde.StatusNotifierItem-2-1` | error | n/a |
| `--socket=session-bus` | error | works |

Talk-name alone registers nothing: Electron does not fall back to its unique
bus name. `org.freedesktop.StatusNotifierItem-2-1` is the name this Electron
actually owns — verified with `busctl --user list` and by reading the watcher's
`RegisteredStatusNotifierItems` with the app running. Shipping none of these
keeps the manifest lint-clean, so the submission needs no Flathub exception.

Closing the window hides it rather than quitting, and without a tray there is
no tray menu to bring it back — but nothing is stranded. Relaunching from the
desktop entry takes Electron's single-instance path, which calls
`focusExistingWindow()` → `show()`.

The AppImage/deb/rpm/AUR builds are unsandboxed and still create their tray.
