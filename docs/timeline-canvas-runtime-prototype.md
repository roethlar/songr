# Timeline Canvas Runtime Prototype

Status: **SLICE 4 SYNTHETIC RUNTIME EVIDENCE PASSED 2026-07-14.** This closes
only the isolated synthetic runtime-prototype work in plan §11.3 and §12 slice
4. The owner can inspect the running interaction locally, but ultimate product
approval remains pending the owner's in-action review. The later-completed plan
§11.1b-final gate permitted production slices to proceed; this synthetic proof
still does not authorize Timeline exposure or close the Pi/release gates.
Final production acceptance is tracked separately in
`docs/timeline-canvas-release-acceptance.md`; this synthetic prototype record
is not rewritten as production runtime proof.

The canonical machine-readable capture is
`docs/fixtures/timeline-canvas/runtime-prototype-2026-07-14/metrics.v1.json`.
It retains both 10-second frame-interval traces, interaction evidence, the
20-cycle recovery result, browser profile, limits, and explicit limitations.

## Run it

From the repository root, build and serve the same standalone production
preview used for the measurements:

```sh
npm --prefix ui run prototype:timeline:build
npm --prefix ui run prototype:timeline:preview
```

Open `http://127.0.0.1:4174/`. The standalone Vite root binds only to
localhost, has no proxy or production aliases, and writes builds to the OS
temporary directory. The permanent banner identifies the surface as synthetic
and disconnected.

The harness is under `ui/prototypes/timeline-canvas`. Production server and UI
sources do not import it. Isolation tests reject production imports,
controller/API or Socket.IO paths, browser network calls, shared contracts,
and built-output production markers. It has no Roon connection, live keys,
production preference, production route, or selectable Timeline mode.

## Implemented falsification surface

- A real 512px spatial grid, bounded query, camera, CSS-transformed world,
  cursor-centered zoom, and semantic overview/navigation/detail tiers.
- Exact logical synthetic catalog cardinality of 1,671 artists and 3,896
  albums; active 1-, 11-, and 38-release discographies; and a separate
  4,541-release density fixture.
- Explicit synthetic original-release years and an honest Undated tail.
  Edition/reissue dates appear only as secondary detail metadata and never
  establish an anchor.
- One priority focus pin, selected-album detail, and no more than three
  branches with eight candidates each at depth two.
- Pointer pan, continuous album drag-follow, rendered-zone hit testing,
  rollback before an inert chooser, and local `sent: false` action records.
- Shift+F10 album actions and an inert equivalent list with no more than forty
  mounted rows.
- Hard limits of 72 rendered world objects and 40 mounted artwork images.
- Twelve local synthetic cover designs rasterized as representative 512px PNG
  fixtures (1.75MB total), with no external artwork or network dependency.

Browser interaction and independent review found and closed three real input/
rendering defects before this evidence was captured: the camera state changed
without updating the world transform, a dragged album visually followed only
its first pointer move, and nested controls could bubble into canvas pointer
capture. Each now has a load-bearing component regression plus browser proof.
The review also forced full-trace query retention, real abort-listener
accounting, representative raster artwork, and precise retained-heap evidence.

## Measured browser profile

Profile: standalone production preview on a local Mac, headless Chromium 149,
1480×1080 viewport, DPR 1, 16 reported logical processors, and 32 GiB reported
device memory. Chromium ran with precise-memory reporting; the recovery check
also exposed garbage collection so it could compare retained heap rather than
pending garbage. This is a desktop falsification profile, not Raspberry Pi 4
evidence.

| Capture | Result | Frame p95 / max | Spatial query p95 | Long tasks | DOM and images |
| --- | --- | --- | --- | --- | --- |
| 4,541-release stress pan/zoom, 10s | Pass, 1,199 frames / 1,201 queries | 8.8ms / 17.2ms | 1.1ms | 0 | 338 elements; 72 world objects; 0 overview images |
| 38-release artwork pan/zoom, 10s | Pass, 1,199 frames / 1,201 queries | 8.8ms / 16.8ms | 0.1ms | 0 | 309 elements; 27 world objects; 27 images |

The measured desktop gates were frame p95 ≤20ms, maximum frame ≤100ms,
spatial-query p95 ≤4ms, world objects ≤72, images ≤40, and incremental warm
heap ≤80 MiB. Both traces passed every applicable gate. The artwork trace
attempted and decoded 23 of 23 mounted 512px PNG covers with no failures and a
0.3ms decode p95. The stress overview intentionally mounted and decoded no
artwork. Precise peak-minus-baseline warm heap was 29,581,829 bytes for stress
and 12,619,788 bytes for artwork, both below the 80MiB gate.

The 20-reset recovery run passed with one harness subtree, the chooser closed,
the gesture cleared, and every listener/observer/animation-frame/pointer/
object-URL ledger count at zero. Its peaks were 337 elements, 72 world objects,
and zero overview images. After a 250ms settle and explicit collection before
both readings, precise retained heap moved from 6,180,845 to 6,545,137 bytes:
5.9% growth, within the 10% gate. The forced-collection method is recorded in
the fixture and measures retention, not ordinary browser GC scheduling; it
still cannot close later production mode-switch or Pi hardening.

## Interaction results

The browser run verified all of the following on rendered pixels and DOM state:

- field pan and Ctrl-wheel cursor-centered zoom changed the world transform;
- a card remained centered under the pointer through successive moves;
- the visible zone gained its hot state, the card rolled back on drop, and the
  world became inert while the chooser was open;
- a Play Now example recorded `sent: false`, with no console errors;
- album selection moved the single focus pin and opened its branch/detail;
- Shift+F10 opened and focused the equivalent album menu, ArrowDown moved
  between items, Escape restored album focus, and both dialogs focused inside;
- the medium list mounted 19 rows and the stress list mounted exactly 40;
- `?scenario=stress&autorun=1` selected the stress fixture and began the timed
  animation-frame trace without console errors;
- Export Metrics downloaded parseable schema-v1 synthetic JSON, still declared
  `roonConnection: false`, and released its object URL;
- 71 clusters represented all 1,100 intersecting stress entities; one separate
  outside-viewport priority pin brought the render total to exactly 72;
- the Undated axis and ordinal labels remained explicit.

## Verification and boundary

The standalone Svelte check, focused Vitest suite, and standalone Vite build all
pass. New guards were proved red for the metrics schema, camera transform,
continuous drag, interactive-control pointer isolation, coarse-heap
classification, full-trace query retention, and representative raster-asset
contract before their fixes passed. Full repository verification is recorded
with the slice commit.

This evidence does **not** establish live chronology truth, Roon action effects,
album-to-track semantic binding, timeout behavior, Raspberry Pi performance,
production mode switching, production accessibility/recovery, launch readiness,
or ultimate product approval. It authorizes no Timeline exposure. Those gates
remain exactly where the approved plan records them.
