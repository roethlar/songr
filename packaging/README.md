# Packaging templates

Source of truth for every package-manager manifest Songr publishes. Each
registry keeps its manifest in its *own* repository — a Homebrew tap, a Scoop
bucket, `microsoft/winget-pkgs`, the AUR git remote — and those copies are
generated from these templates by the release procedure. Editing a published
manifest without updating its template will be overwritten by the next release.

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
node packaging/render.mjs --version "$VERSION" --sums SHA256SUMS --date "$RELEASE_DATE" --check
node packaging/render.mjs --version "$VERSION" --sums SHA256SUMS --date "$RELEASE_DATE" --out rendered
```

Set `VERSION` and `RELEASE_DATE` to the existing release being prepared. Both
commands validate every supported template before writing any output; a missing
file, checksum or substitution fails the operation. `--check` writes nothing.
The supported set is six manifests: Homebrew, Scoop, AUR and three WinGet files.
Flathub is not a supported publication target.

Both release workflows run the check before rendering. Canonical release
artifacts require signing verification; package credentials are reported
separately, and unavailable credentials do not turn invalid templates into
successful partial output. Publication remains disabled during withdrawal.

Run the local packaging regression checks without building or publishing:

```bash
node --test packaging/render.test.mjs packaging/release-workflow.test.mjs
```

These checks use the repository's installed development dependencies (`npm ci`).
They render temporary manifests and check workflow gates; they do not install,
sign or publish an application.
