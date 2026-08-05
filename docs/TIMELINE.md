# Timeline Canvas

Timeline Canvas is an alternate Library view for exploring one artist's
discography on a pannable chronology. It complements the complete Classic
Library rather than replacing it.

## Current release state

The Timeline implementation and its catalog service are present, but the
current production UI keeps Timeline behind a release availability gate while
live acceptance is completed. Until a release opens that gate, Controller
settings shows only **Classic**.

Timeline availability is not an environment setting. In particular,
`TIMELINE_CATALOG_PATH` only selects where the backend stores catalog snapshots;
setting it does not expose Timeline in the UI. The rest of this guide describes
the behavior after a release enables the view.

## Switch between Library views

1. Open the gear-shaped **Controller settings** button.
2. Under **Library view**, select **Timeline canvas** or **Classic**.
3. Select **Done** to close settings.

The same control is available throughout the UI. A request made from another
page takes you to `/library`. The preference is saved in that browser only
after the requested view activates successfully. If Timeline is unavailable or
cannot activate, the controller keeps a safe Classic view instead.
An unavailable saved Timeline preference is not rewritten merely because this
build can open only Classic, so a later enabled build can honor that preference.

Switching views does not itself start playback or alter a Roon queue. Browser
Back and Forward retain semantic Timeline entries such as the selected artist
and open album detail when those entries can still be resolved.

## Start with an artist

Timeline is deliberately artist-first:

1. Pair the controller with a Roon Core and wait for the connection to settle.
2. If prompted, choose **Scan library**. The backend builds a Core-specific,
   keyless catalog snapshot at `TIMELINE_CATALOG_PATH`.
3. Enter an artist in **Search artists**, choose a matching candidate, and wait
   for that artist's discography to load.

The Timeline search lens searches cataloged artists, not every Roon browse and
search category. Use **Search everything in Classic** for a full-library
search. A stale catalog offers **Refresh catalog**; a first-run or unavailable
catalog offers **Scan library**.

## Move around the canvas

- Drag empty canvas space to pan. Middle-drag or hold Space while dragging to
  force a pan when starting over an album.
- A wheel or two-finger scroll pans. Hold Control (or Command on macOS) while
  scrolling to zoom around the pointer. The **−**, **+**, **Fit**, and
  **Recenter** controls provide explicit alternatives.
- Select an album to open its detail slab and track list. Track-level browsing
  and playback continue in Classic through **Open in Classic**.
- With keyboard focus on an album, use the arrow keys to move, Home or End to
  reach an edge, Enter to open detail, and Shift+F10 to open album actions.
- **Browse as list** opens a text-only equivalent of the active base
  discography and attached branches, paged at 40 rows.

Timeline renders only the currently useful world objects and loads artwork
lazily. Zooming changes the amount of album information shown without changing
the underlying discography.

## Place albums and send actions to zones

Drag an album to move it away from its canonical anchor. Its action menu also
offers **Float from timeline**, **Return to timeline**, and visual **Move
before** / **Move after** commands. These are workspace changes only: they do
not rewrite release dates or Roon ordering.

Named, currently available Roon zones appear in the zone dock. Drag an album
onto a zone, or choose **Send to _zone_** from album actions, to resolve the
actions Roon currently exposes for that album and zone. The drop alone sends no
playback or queue command. A second chooser presents the live choices (for
example Play Now, Add Next, or Queue); only selecting one sends it to Roon.

If the chooser reports **Outcome unknown**, inspect that zone in Roon before
trying another action. The controller deliberately does not retry a possibly
accepted command automatically.

## Attach artist branches

Open an album's actions and choose **Attach artist branch…** to search for and
attach another artist's releases at that album. Branches are explicit artist
searches, not automatically generated recommendations.

The active workspace allows at most three open branches, two attachment levels,
eight search candidates per branch search, and eight releases per attached
artist. A branch reports when its catalog result was truncated. Close a branch
from its canvas header; closing a parent also removes its dependent branch.

## What stays in Classic

Classic remains the complete Roon Library interface. Timeline offers explicit
handoffs for:

- full-library and category searches;
- Favorites and Recently Played;
- the current artist or a selected album;
- individual tracks and browse paths that Timeline does not model.

An **Open in Classic** confirmation explains what will be re-resolved. The
controller transfers a safe semantic description, not a stale live Roon item
key. If Roon's hierarchy has changed, Classic stops at a useful surface rather
than guessing.

## Chronology and persistence limits

- An album appears on a calendar year only when its exact edition is resolved
  and Roon supplies proven **original release date** evidence.
- Edition or reissue dates are shown in detail when available but never used as
  substitutes for original chronology.
- Unresolved albums and albums without proven original-release evidence remain
  explicitly **Undated**. Timeline does not infer a year from titles, order, or
  third-party metadata.
- Manual album placements and attached branches are kept only in memory for the
  current browser tab. Compatible state can survive an in-tab view switch, but
  it is not saved across a full reload, browser restart, Core change, artist
  change, or incompatible catalog revision.
- The selected Library view is a browser-local preference. The catalog itself
  is backend data persisted separately at `TIMELINE_CATALOG_PATH`.

## Recovery

- **Connection unavailable / Waiting for Roon Core:** wait for Socket.IO and
  the paired Core to reconnect. Timeline disables live detail, branch, and zone
  actions while their authority is stale, then re-resolves the current semantic
  state after reconnection.
- **Timeline needs re-resolution:** return to artist search or use browser Back
  to choose a catalog entry that still exists. Classic remains available from
  Controller settings.
- **Catalog stale or unavailable:** use **Refresh catalog** or **Scan library**.
  If catalog storage is degraded, check that `TIMELINE_CATALOG_PATH` exists on a
  writable, persistent filesystem, correct the storage problem, and reload the
  catalog status.
- **Artist, discography, or branch load failed:** use the visible retry control
  where offered, close a failed branch and attach it again, or continue in
  Classic.
- **Zone disappeared or changed:** dismiss the action flow, wait for the zone
  dock to update, and resolve a fresh action against a currently available
  zone. Never assume a timed-out command failed; verify it in Roon first.
