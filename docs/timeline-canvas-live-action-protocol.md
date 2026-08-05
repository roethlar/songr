# Timeline canvas live action and cleanup protocol

Status: **PROTOCOL ONLY — NOT ITSELF MUTATION AUTHORITY.** This document is the
redacted run contract required by plan §11.1b-harness. It does not authorize
`Play Now`, `Add Next`, `Queue`, a controlled timeout, grouping, ungrouping,
transport cleanup, or queue cleanup. Each mutation campaign requires a later,
explicit owner authorization that names its command and cleanup budget.
The completed live-action campaign for §11.1b-final cited by the
[canonical live-evidence report](timeline-canvas-live-evidence-2026-07-13.md#authorized-live-campaign--2026-07-14)
used a separate single-use claim; that claim grants no authority to any future
run.

The existing `scripts/capture-timeline-evidence.mjs` tool remains permanently
read-only. A future live run must use a separately named runner and versioned
schema; it must never add an execute switch to that capture tool or weaken its
action-key refusal.

## Evidence boundary

The run covers only the action, topology, timeout, and semantic-binding portion
of plan §11.1b-final. The separate ground-truthed-year requirement remains
mandatory, so this campaign cannot close §11.1b-final by itself. It must
establish:

- album-bound action choices resolved independently for two simultaneous,
  independent real zones with disjoint output membership, unless the owner
  separately approves a replacement criterion;
- one explicitly selected invocation each for the exact labels `Play Now`,
  `Add Next`, and `Queue`, within the later authorization budget;
- before/after playback and queue effects on the target zone and proof that the
  non-target zone did not change;
- honest cleanup results and every remaining side effect;
- if separately authorized, one controlled timeout observation classified as
  either zero action before the irreversible boundary or outcome unknown after
  it.

The test-only harness under `src/tooling/__tests__/` proves contract behavior
against injected fakes. It is not production AlbumActionService or live-Core
evidence and cannot substitute for any item above.

## Authorization envelope

Before any mutation, record an owner-approved envelope containing all of:

1. the exact paired-Core alias, safe Core version/fingerprint, and selected
   album descriptor alias with artist, edition, and track-sequence fingerprint;
2. for each action, the exact allowed label chosen only from `Play Now`, `Add
   Next`, and `Queue`, its target-zone alias/fingerprint, and maximum invocation
   count;
3. whether a controlled timeout is authorized, the named fault mechanism, and
   whether the experiment may cross the irreversible execute boundary;
4. every separately allowed cleanup command, its target-zone alias, and maximum
   invocation count;
5. whether residual media side effects are allowed;
6. the call-timeout and quarantine-reap values, using the planned 15 seconds
   and 5 minutes unless the envelope explicitly approves recorded replacements;
7. the bounded observation window and campaign stop conditions.

Persist the complete redacted authorization envelope in the evidence bundle, or
point to one canonical tracked record and retain its digest. A digest without
the redacted terms is insufficient to prove authority. A post-execute timeout
consumes both the timeout-experiment budget and the selected action label's
invocation budget.

Anything absent from the envelope is forbidden. Labels are descriptive data,
not authority: the submitted action key must be the fresh leaf returned by the
same target-zone session. Never substitute `Start Radio`, an approximate label,
another zone, another session, or a previously captured key. Never retry an
unknown outcome.

If residual effects are forbidden, abort before execution unless the approved
commands can demonstrably restore every captured field. The current controller
cannot restore an arbitrary queue, current item, or seek position, so an
envelope that forbids all residual effects cannot presently authorize these
album-action trials.

## Preconditions and aborts

Dry-run enumeration is the default. Abort before execution when any condition
below is false:

- controller health is ready and the intended Core is paired;
- two independent real zone IDs exist simultaneously and their sorted output
  memberships are disjoint; a grouped zone with two outputs does not qualify;
- both zone fingerprints remain identical from initial enumeration through the
  immediate pre-execute check;
- a genuine queue-subscription snapshot has arrived for each zone and remained
  stable through the baseline window; an initially empty cache does not count,
  and the subscription's `max_item_count` plus reported coverage must include
  the complete queue or the entire potentially affected range;
- the selected album resolves uniquely by normalized title and artist plus
  edition and track-sequence evidence where needed;
- the exact expected action appears once in a newly resolved album-bound action
  list for the target zone;
- no unaccounted external playback, queue, grouping, power, or source-control
  change occurs during the observation window.

Also abort on a Core reconnect, timeout before the authorized experiment,
missing or duplicate action, ambiguous album edition, stale queue, target-zone
disappearance, topology change, or redaction-validator failure. Do not group,
ungroup, power, or wake outputs to manufacture qualifying topology. The fault
mechanism may not restart or disrupt the Core, network, controller, zones, or
outputs unless that exact disruption receives separate approval. Permit only
one live action invocation in flight at a time.

## Redacted baseline

Capture a fresh baseline immediately before every action. Do not reuse one
baseline across the campaign because a prior action contaminates later trials.
For both target and non-target zones retain only:

- a fixture-local zone alias and a topology fingerprint made from aliased,
  sorted output membership;
- playback state, allowed-command booleans, queue-remaining values, and safe
  playback settings;
- seek position and current-item semantic alias/fingerprint;
- a real queue snapshot's count, `max_item_count`, reported range/coverage, and
  ordered fixture-local per-instance aliases derived from raw `queue_item_id`
  alongside semantic aliases/fingerprints;
- an observation timestamp, stabilization window, and revision/update count.

Duplicate semantic rows remain distinct through their per-instance aliases.
Abort or mark the trial inconclusive unless the stable subscription covers the
entire affected range; `Queue` evidence cannot infer an append outside a
truncated window.

Do not persist a controller URL, filesystem path, selector, Core/zone/output/
session/item/action/queue/image/control identifier, entity name, raw payload,
trace log, alias mapping, token, email address, or network address.

## Fresh resolution and execution

For each authorized action:

1. create a fresh, random, isolated Browse session scoped to the target zone;
2. resolve the album again from a safe root and prove the unique semantic
   binding; the earlier album-header-like/no-subtitle heuristic is insufficient;
3. enumerate the action path without submitting an action leaf;
4. capture a second topology fingerprint and reject any membership change;
5. atomically claim exactly one fresh leaf whose exact label is authorized;
6. atomically set `executeIssued` and increment the invocation counter with the
   actual synchronous handoff to the Roon execute adapter; a counter increment
   alone is not evidence that a command was sent;
7. submit that leaf once, record acknowledgement/callback class and latency,
   and invalidate every sibling choice;
8. observe both zones until the bounded stabilization condition or timeout;
9. capture and validate the evidence after-state before any cleanup command;
10. re-root/release on a deterministic result, or quarantine the session after
    uncertainty until late settlement or the bounded reap rule completes.

Acknowledgement success is not semantic proof. The observed playback and queue
delta must corroborate the action, and any unexplained non-target-zone change
makes the trial inconclusive.

## Per-action observations

`Play Now` records the resulting current-item alias, playback state, seek
behavior, complete ordered queue delta, and whether the selected album's aliased
track sequence is present. Do not assume the action replaces the queue.

`Add Next` records insertion count, exact ordered insertion location, current-
item/playback changes, and correlation to the album's aliased track sequence.
Do not assume the action inserts one track or a complete album.

`Queue` records insertion count, exact ordered insertion location, current-item/
playback changes, and the same track-sequence correlation. Do not assume it
always appends or has semantics distinct from `Add Next` on every Core/content
combination.

After each action, the non-target zone's topology, current item, playback state,
settings, and ordered queue must match its own fresh baseline. A concurrent
external change is reported as inconclusive; it is never silently attributed to
or corrected by the test.

## Timeout classification

The irreversible boundary is the actual synchronous handoff to the Roon execute
adapter. `executeIssued` and command count change atomically with that handoff.

- A timeout before that increment records `PRE_EXECUTE_TIMEOUT`, command count
  zero, invalid choices, and a quarantined session. A late resolver is observed
  only for cleanup and may never execute the returned leaf.
- A timeout after that increment records `OUTCOME_UNKNOWN`, command count one,
  invalid choices, and quarantine. A late callback may complete cleanup but may
  never replace the published classification or trigger a retry; the live
  result remains `OUTCOME_UNKNOWN` permanently.
- If callback settlement and the deadline become observable in the same event-
  loop turn, classify the result fail-closed as `OUTCOME_UNKNOWN`.

An unknown outcome immediately stops the mutation campaign. Observe the late
session and both zones for the authorized window, then report the residual
state. Do not infer failure from a missing acknowledgement. Record the approved
fault mechanism and the effective call-timeout/reap values with the result.

## Cleanup and residual effects

Boundary cleanup and media cleanup are separate:

- boundary cleanup re-roots/releases a deterministically settled session or
  quarantines and discards an uncertain one;
- media cleanup changes playback or queue state and therefore requires its own
  explicit authorization and command budget.

The current controller can stop playback but cannot restore an arbitrary queue
snapshot, prior current item, or seek position. Stop is not restoration. Queue
insertions, a `Play Now` queue change, current-item/seek changes, Recently Played
persistence, Roon listening/history/scrobble effects, and retained queue
subscriptions may remain.

Always capture the evidence after-state before cleanup. Then record each cleanup
command, capture a final state, and use `restored` only when every observed
field matches the action's own baseline. Otherwise enumerate each remaining
delta. If cleanup is not authorized or exact restoration is unavailable, leave
the state untouched and report it instead of improvising. Prefer a disposable
queue; if several trials must share one zone, run the most disruptive approved
action last.

## Durable output and validation

A future mutation runner must publish a no-overwrite, versioned bundle beneath
`docs/fixtures/timeline-canvas/` with source commit, tool/schema version,
capture time, safe Core version, authorization-envelope digest, command counts,
and `SUPPORTED` / `DISPROVED` / `INCONCLUSIVE` / `PENDING` conclusions.

The bundle must also contain the complete redacted authorization envelope or a
canonical tracked pointer to it; the digest verifies that record but never
replaces it.

Reuse the read-only capture's in-memory alias and validator discipline. Persist
exact raw labels only for `Play Now`, `Add Next`, and `Queue`; all entity text
and live identifiers use fixture-local aliases without a stored reverse map.
Before commit, reconcile every count and delta, scan the entire bundle and
report for raw values, and verify that no trace or transient job log is included.

This protocol remains the reusable run contract. A completed campaign does not
carry its single-use mutation authority forward; every future campaign must
repeat the authorization and precondition checks above.
