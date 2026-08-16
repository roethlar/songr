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

- `manifest io.github.roethlar.songr.yml` → clean, zero findings.
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

## App ID

`io.github.roethlar.songr` — Flathub's `io.github.*` prefix requires at
least 4 dot-separated components and computes an expected repository URL
from the ID (`io.github.<user>.<repo>` → `github.com/<user>/<repo>`) that
must be reachable; `io.github.roethlar.songr` → `github.com/roethlar/songr`,
an exact match, so no manual ownership-verification exception is needed.
Manifest filename must equal the app ID exactly (already true here).

## Submission is not the same shape as the other four targets

Unlike Homebrew/Scoop/WinGet/AUR, there is no "render and push to our own
release automation on every tag" path here. Flathub's process (per
`docs.flathub.org`, verified 2026-08-08) is a **one-time PR** against
`flathub/flathub`'s `new-pr` branch (not `master`); once merged, reviewers
create a **new, separate repository** under the `flathub` GitHub org that
owns all future builds, and the submitter gets an invited-collaborator role
on it. Future version bumps push to *that* repo, not to
`product/.github/workflows/release.yml` — out of scope for this templating
until the initial PR is merged and that repo exists.

## Rendering

`render.mjs` substitutes `@VERSION@`, `@RELEASE_DATE@`, and
`@SHA256_APPIMAGE_X64@` the same way as every other target. The rendered
output is what actually gets committed to the PR branch — never hand-edit a
rendered copy.
