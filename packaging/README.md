# Packaging templates

Source of truth for every package-manager manifest Songr publishes. Each
registry keeps its manifest in its *own* repository — a Homebrew tap, a Scoop
bucket, `microsoft/winget-pkgs`, the AUR git remote — and those copies are
written by CI, never by hand. Editing a published manifest directly will be
overwritten by the next release.

## Layout

| Path | Published to | As |
| :--- | :--- | :--- |
| `homebrew/songr.rb` | `roethlar/homebrew-tap` | `Casks/songr.rb` |
| `scoop/songr.json` | `roethlar/scoop-bucket` | `bucket/songr.json` |
| `winget/*.yaml` | `microsoft/winget-pkgs` | `manifests/r/roethlar/Songr/<version>/` |
| `aur/PKGBUILD` | `aur.archlinux.org/songr-bin.git` | `PKGBUILD` (+ generated `.SRCINFO`) |

## Placeholders

Templates are *not* valid manifests as they sit here: they carry placeholders so
that no stale version or checksum can masquerade as current. `render.mjs`
substitutes them from a release's own assets.

| Placeholder | Source |
| :--- | :--- |
| `@VERSION@` | the release tag, minus its leading `v` |
| `@RELEASE_DATE@` | the release's publication date, `YYYY-MM-DD` |
| `@SHA256_<ASSET>@` | that asset's SHA256, read from the release |

Checksums are never typed by a human. `render.mjs` takes them from the
`SHA256SUMS` asset the release workflow attaches, which is itself computed from
the uploaded artifacts.

## Rendering

```bash
node packaging/render.mjs --version 1.1.4 --sums SHA256SUMS --date 2026-08-08 --out rendered
```

`--check` renders to memory and fails if any placeholder is left unsubstituted,
which is what CI runs before it pushes anything.
