# Timeline Canvas Release Acceptance

Status: **IN PROGRESS — PRODUCTION AVAILABILITY REMAINS FALSE.** This is the
canonical record for `.agents/plans/timeline-canvas.md` Slice 28 and its §13
manual/live matrix. Automated or synthetic evidence is recorded as support,
not substituted for a required rendered or live check.

## Acceptance boundary

- Production implementation boundary: `cff7885`. Later commits through
  `ced41da` change documentation only.
- Release-gate source:
  `ui/src/lib/stores/libraryViewStore.ts` retains
  `TIMELINE_LIBRARY_VIEW_AVAILABLE = false`.
- The disposable acceptance frontend uses production UI source from
  `fe59b86` plus one local-only availability flip. Comparing that source with
  `ced41da` under `ui/src` finds test-file changes only, so the rendered
  production UI bytes are otherwise unchanged. The tracked branch is not
  enabled.
- The acceptance backend uses the current production implementation with an
  isolated token, catalog, image-cache, favorites, and recently-played path.
- On 2026-07-16, the ordinary protected verification matrix passed: all 37
  backend suites / 608 tests, backend build and lint, Svelte check, the full UI
  test suite, and the production UI build. Four evidence-artifact suites that
  read the owner-restricted fixture tree were excluded from this rerun; their
  committed provenance and prior verification remain recorded in
  `docs/timeline-canvas-live-evidence-2026-07-13.md`.

The current acceptance browser and hardware profile is not yet recorded; the
owner browser is unnamed.

The Pi question is settled as of 2026-07-21: the desktop browser is the primary
target, and the Pi 7-inch touchscreen is a nice-to-have, never a release gate.
See `.agents/repo-guidance.md` (Mission Detail). Row 13 below is therefore
desktop-only for release purposes.

Superseding status (2026-07-22): the owner rejected the shipped Timeline UI in
action. This matrix is suspended, not in progress — see `.agents/state.md` and the
2026-07-22 design-constraints decision in `.agents/decisions.md`. Do not resume it
without an owner decision on Timeline's disposition.

## Existing live evidence

- The repaired native browse sequencing completed a fresh isolated live-Core
  catalog refresh and published a complete healthy catalog. This proves the
  live read path, not rendered Timeline behavior; see
  `.agents/review/findings/timeline-28a.md`.
- The consumed single-use backend campaign proved descriptor re-resolution,
  one pre-execute timeout, and one explicit Add Next, Queue, and Play Now
  action. It did not exercise the production Timeline UI and cannot be reused;
  see `docs/timeline-canvas-live-evidence-2026-07-13.md`.
- The owner approved the static 1400 by 900 visual direction while explicitly
  reserving ultimate approval until seeing it in action; see
  `docs/timeline-canvas-visual-gate.md`.

## Plan §13 manual/live matrix

`Pass` means the exact manual/live journey ran on the named acceptance
boundary. `Partial` means real supporting evidence exists but the required
journey has not passed. `Not run` is not a failure, but it keeps the release
gate closed.

| # | Required manual/live check | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| 1 | Settings: Timeline → Classic → Timeline restores both semantic states with one mounted view | **Not run** | Host automation covers retained mode state, one subtree, and repeated switching. Run the rendered journey and inspect both restored states. |
| 2 | Timeline artist → detail → Settings Classic → browser Back/Forward crosses modes in one step with the correct displayed and stored preference | **Not run** | History and preference transitions are guard-covered separately. Run the complete rendered journey from its artist origin. |
| 3 | Playback, selected zone, Queue, volume, and feedback remain continuous through repeated switches without duplicate commands/subscriptions | **Not run** | The `9303773` guard preserves shared identities across 20 round trips. Run with real playback, queue subscription, volume, and feedback. |
| 4 | A Timeline fallback reaches the named Classic destination or an honest selection-required search, then returns to Timeline | **Not run** | Keyless intent, confirmation, safe-root, failure, and history paths are automated. Exercise at least one named destination and one ambiguous entity path. |
| 5 | A cold Timeline chunk failure offers Retry and Use Classic without silently changing preference | **Not run** | Loader/host failure behavior is automated. Run a deliberate cold-chunk failure in the acceptance browser. |
| 6 | Search artist → timeline → album → Back → sibling album remains clickable | **Not run** | Search, detail history, sibling navigation, and focus recovery are automated in pieces. Run the complete rendered journey. |
| 7 | Place a real album; restart/re-resolve; drop on a non-default zone and prove drop plus cancel send no action; then repeat and explicitly choose returned Play and Queue actions | **Partial** | Live descriptor restart/re-resolution and the consumed backend action campaign passed. Synthetic drag rollback and production placement/action guards pass. The exact production-UI journey needs a fresh mutation authorization and an independent non-default test zone. |
| 8 | After choices appear, change selected zone; then separately remove and regroup the original target; no flow retargets or executes against changed topology, and every rejected flow cleans up | **Not run** | Service/UI guards reject changed targets and `cff7885` closes selected-zone persistence/fallback coverage. Run all three live topology cases and confirm terminal cleanup. |
| 9 | Queue route → browser Back restores coherent canvas state | **Not run** | Queue shell ownership and Timeline restoration are automated separately. Run the exact rendered journey. |
| 10 | Disconnect during branch resolution and during action resolution | **Not run** | Store/service/controller guards cover disconnect, late results, cancellation, and claimed execution ownership. Run both live disconnect timings. |
| 11 | Target zone disappears during drag and before choices appear | **Not run** | Production tests cover vanished ports and action-time topology changes. Run both live disappearance timings. |
| 12 | Owner visual review at about 1400 CSS pixels | **Partial** | The exact static frame passed owner review. The production in-action review remains explicitly pending. |
| 13 | Desktop and applicable Pi performance gates | **Not run** | The synthetic Mac Chromium prototype passed its isolated gates, but is not production or Pi proof. Measure production in the actual desktop browser; if Pi is backend-only, measure backend CPU, memory, catalog crawl, image work, and browse latency there; if it drives Chromium, run the Pi browser gates too. |
| 14 | Keyboard-only and screen-reader bounded-list flow | **Not run** | Production automation covers focus, Shift+F10/menu parity, inert bounded list, ARIA labels, and restoration; the synthetic prototype exercised keyboard controls. Run keyboard-only and an actual screen reader. |
| 15 | Every capability-ledger row passes its named acceptance check; every removal cites a separate owner decision | **Not run** | The refresh committed at `ced41da` inventories production state at `daefc94`; no capability is removed, album-action automation is complete, and the former selected-zone test gap is closed. Any future removal still requires its own owner decision. The manual rows above prevent closing the ledger release check. |

## Current blockers and residual risk

- The owner must complete the production in-action review in the actual target
  browser and record the browser, viewport, DPR, and result.
- The Pi's display-versus-backend role must be stated, then the applicable
  production performance measurements must pass.
- Live rows 7, 8, and 11 require at least two independent zones. A 2026-07-16
  recheck after restarting the isolated backend showed one visible zone; a
  disposable second test zone must be online before those checks.
- The earlier mutation campaign is consumed. Production-UI Play and Queue need
  a fresh, exact authorization envelope before execution.
- Keyboard-only and real screen-reader results are absent.
- The fixed final boundary still needs the owner-designated Fable openreview
  after the manual/live evidence is complete.

## Owner in-action acceptance

Pending. The durable static approval remains: visual direction approved, final
approval reserved until the owner sees the production Timeline operate.

## Final availability decision

**CLOSED.** Do not change `TIMELINE_LIBRARY_VIEW_AVAILABLE`, merge this release
branch to `main`, or push an enabled Timeline until every applicable row above
passes, the final review is accepted, and the owner explicitly approves
exposure.
