# Timeline Canvas Visual Gate

Status: **VISUALLY APPROVED 2026-07-14.** The owner accepted the visual direction
while explicitly reserving ultimate approval until the Timeline can be seen in
action. This closes the plan §11.2 visual-review checkpoint only; it does not
authorize Timeline exposure. The later-completed §11.1b-final gate permitted
the approved production slices to proceed; Timeline remains unavailable until
the in-action, Pi-performance, accessibility/recovery, and release gates pass.
Final production acceptance is tracked separately in
`docs/timeline-canvas-release-acceptance.md`; this synthetic visual record is
not rewritten as runtime proof.

Code-evidence baseline: `ce2f9ea` (`docs/timeline-canvas-capability-ledger.md`).
Editable, dependency-free source:
`docs/mockups/timeline-canvas/index.html`. The source mirrors the current UI's
dark color, typography-stack, radius, and shadow token values with
browser-native HTML/CSS; Fira Mono falls back through the same stack when it is
not installed. Its review toolbar switches among the five states without
changing the 1400 by 900 `#mockup` product frame.

All artist, album, track, year, zone, and build values are synthetic review data.
They do not report live-Core evidence. In particular, the primary state uses
ordinal discography positions and an explicit Undated treatment because §11.1b
has not established trustworthy year coverage.

## Canonical review states

The canonical artifact is the rendered `#mockup` element in the source above.
The review toolbar or the `state` query parameter selects each directly. A PNG
capture is derivative, not the source of truth.

| State | Proposed requirement represented; not runtime proof |
| --- | --- |
| `?state=primary` | Plan §4.1-4.4 and §11.2; proposed `TN-ARTIST`, `TN-TIMELINE`, `TN-DETAIL`, and shared-shell presentation. Artist-first lens and origin, fitted ordinal axis, Undated handling, transparent-ground markers, one attached detail slab, explicit-provenance artist-search branch, two named dynamic zone ports, Manage grouping/power entry, zoom/Fit/Recenter, Queue, seek, metadata links, Now Playing opener, and compact transport are visible. The Send affordance illustrates the still-blocked `TN-ALBUM-ACTION` and makes no action-behavior claim. |
| `?state=settings` | Plan §5.1 and §11.2; proposed ledger `S-09`, `S-10`, `S-11`, and `OC-SWITCH` presentation. The open Controller settings surface separates Core status from a labeled Library view radio group, marks Timeline canvas as the current view, keeps Classic available, and exposes shared theme plus build revision. |
| `?state=fallback` | Plan §5.1 and proposed ledger `C-05`, `C-06`, `OC-WELCOME`, `OC-SWITCH` presentation. The specific action says the Library view changes and identifies `Library › Recently Played` as the destination. |
| `?state=disconnected` | Plan §5.6 and proposed ledger `TN-RECOVERY-A11Y`, `S-08` presentation. Keyless artist/timeline context remains visible while artist resolution, live detail, transport commands, metadata navigation, branch nodes, and zone ports are explicitly unavailable. One top-right reconnect status owns the connection message. |
| `?state=keyboard` | Plan §6.3 and proposed ledger `L-16`, `TN-RECOVERY-A11Y` presentation. A non-color-only focus treatment, pinned focus status, approved traversal keys, Shift+F10 action menu, non-immediate Send wording, and bounded list entry are visible without removing the primary branch. |

Every state uses the same exact 1400 by 900 product frame and base composition
so state differences can be compared directly.

## Exact Classic fallback shown

The third frame visualizes this approved keyless intent:

```ts
{
  kind: 'general',
  destination: 'welcome-section',
  section: 'recently-played'
}
```

Classic starts from its safe welcome root, resolves the stable Recently Played
section anchor added by §12 slice 9, and focuses the labeled list or its labeled
empty state. No Roon item key, action choice, level handle, or mutation crosses
the switch. The destination retains Classic's current cautious selected-zone
tile playback and revision-safe clear behavior.

## Corrections applied to the supplied concept

- The quiet dark field, fine horizontal axis, alternating small artwork, centered
  lens, and floating transport remain as the useful visual thesis.
- `Albums` search becomes an artist-first lens with a visible selected-artist
  origin. The canvas is a bounded working set on canonical `/library`, not an
  all-library or separately routed discovery surface.
- Anonymous thumbnails become compact, always-labeled album markers. This gate
  uses discography order and `Undated`; a later evidence-backed version may show
  a year only with explicit provenance.
- One album expands into an attached detail slab; other albums do not become a
  repeated card wall. The branch is explicitly `Artist search`, not fabricated
  Similar, Recommended, or less-listened data.
- Zone ports are dynamic named targets on one dock. Dropping opens the current
  Roon action chooser for that exact zone; it never plays automatically.
- Controller settings, current Library view, connection, Queue, zone context,
  volume, zoom/Fit, non-drag controls, disabled authority, and visible focus are
  no longer implied by anonymous glyphs.
- Surfaces are opaque and sparse. The frames use no repeated backdrop blur,
  WebGL, native HTML drag-and-drop, permanent split pane, full-width player, or
  predominantly monospace styling.

## Source-level checks

- HTML and CSS parse without errors; the JavaScript passes syntax checking.
- Each direct state query initializes the intended state. The review controls
  preserve one pressed state at a time.
- Disconnected mode disables every marked live-resolution/action control and
  restores them on return. Album and branch nodes are included in that guard.
- A Classic radio selection is represented as requested while Timeline remains
  explicitly current until activation commits; reopening the Settings review
  state resets to the committed Timeline view.
- The product frame is declared at exactly 1400 by 900 pixels, critical text has
  a 10px minimum, and source-level geometry/capability/plan reviews found no
  remaining blockers.

These checks do not replace the rendered owner-eyes review required below.

## Approval record

On 2026-07-14 the owner approved with the exact wording: "approved visually, but
I need to see it in action to approve ultimately. keep going."

This satisfies the visual approval required by plan §11.2 and §12 slice 3. It
does not satisfy the runtime prototype, live-evidence, performance,
accessibility, recovery, action, production-release, or ultimate product
approval gates.
