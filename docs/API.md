# Roon Controller API Reference

## REST Endpoints

Base URL: `http://localhost:3333/api`

### Core Status

#### GET /core
Get Roon core connection status

**Response**:
```json
{
  "status": "paired",
  "core": {
    "id": "core-id",
    "displayName": "Roon Core",
    "displayVersion": "1.8"
  }
}
```

**Status Values**: `discovering`, `paired`, `unpaired`

---

### Zones

#### GET /zones
List all available zones

**Response**:
```json
{
  "zones": [
    {
      "zone_id": "zone-1",
      "display_name": "Living Room",
      "state": "playing",
      "is_play_allowed": true,
      "is_pause_allowed": true,
      "is_next_allowed": true,
      "is_previous_allowed": true,
      "outputs": [...]
    }
  ]
}
```

#### GET /zones/:id
Get specific zone by ID

**Response**:
```json
{
  "zone": { /* Zone object or null */ }
}
```

---

### Transport Controls

All transport endpoints are POST requests with JSON bodies.

#### POST /transport/play-pause
Toggle play/pause

**Request**:
```json
{
  "zone_id": "zone-1"
}
```

**Response**:
```json
{
  "success": true
}
```

#### POST /transport/next
Skip to next track

**Request**: `{ "zone_id": "zone-1" }`

#### POST /transport/previous
Skip to previous track

**Request**: `{ "zone_id": "zone-1" }`

#### POST /transport/stop
Stop playback

**Request**: `{ "zone_id": "zone-1" }`

#### POST /transport/seek
Seek to position

**Request**:
```json
{
  "zone_id": "zone-1",
  "seconds": 120
}
```

#### POST /transport/volume
Set volume

**Request**:
```json
{
  "output_id": "output-1",
  "value": 50
}
```

For `number` and `db` outputs, `value` is an absolute level. For an
`incremental` output, it is a relative step delta; the backend chooses the Roon
volume mode from the current output type.

---

### Browse & Search

Browse navigation and search are not exposed as REST mutations. The Library's
live Browse and search clients use the correlated `classic-session:*` and
`browse:*` Socket.IO commands with an opaque server-owned session generation.
The `classic-*` names are retained wire-protocol identifiers, not a separate UI.
Requests to the retired
`POST /api/browse*` routes return JSON `404 Not Found`.

The Library's Unified view uses the catalog REST reads below for keyless
discovery.

---

### Favorites

User-curated favorites (tracks / albums / artists). Entries store
display metadata only — no Roon item keys; the UI re-resolves a
favorite against Roon search when clicked. Persisted to
`FAVORITES_PATH`. All endpoints return the full current list.

#### GET /favorites

**Response**:
```json
{
  "entries": [
    {
      "id": "uuid",
      "type": "track",
      "title": "Hey Jude",
      "artist": "The Beatles",
      "album": "1",
      "image_key": "abc",
      "added_at": "2026-06-10T00:00:00.000Z"
    }
  ]
}
```

#### POST /favorites
Add a favorite. Idempotent on `(type, title, artist, album)`.

**Request**:
```json
{ "type": "track | album | artist", "title": "required", "artist": "optional", "album": "optional", "image_key": "optional" }
```

**Response**: `{ "entries": [...] }` (400 on invalid payload)

#### DELETE /favorites/:id
Remove a favorite by id. Idempotent.

**Response**: `{ "entries": [...] }`

All three return **503** when favorites persistence is degraded
(unreadable favorites file — fix or remove the file and restart).

---

### Catalog

The catalog is a controller-owned, Core-scoped read model. The server always
derives the active Core from the paired Roon connection; clients must not send
or select a `coreId`. Responses contain only durable catalog descriptors, never
Roon browse-session keys or actions.

All catalog responses set `Cache-Control: no-store`.

#### GET /catalog/status

Returns freshness, persistence, refresh, completeness, revision, and item-count
status for the paired Core.

#### POST /catalog/refresh

Starts or joins the paired Core's background catalog scan. The request body and
query must be empty. A successful request returns **202** with the accepted
status only:

```json
{
  "status": {
    "coreId": "core-id",
    "freshness": "fresh",
    "persistence": "healthy",
    "refresh": "running",
    "available": true,
    "complete": true,
    "revision": 3,
    "artistCount": 250,
    "albumCount": 1800,
    "updatedAt": "2026-07-15T12:00:00.000Z",
    "lastCompleteScanAt": "2026-07-15T11:30:00.000Z"
  }
}
```

The response does not wait for, or include, the completed scan snapshot.
Concurrent refresh requests coalesce onto the same scan. On an initial scan the
accepted status may still be empty and unavailable; with an older complete
snapshot it may remain available while `refresh` is `running`. A background
failure is reported by a later `/status` response rather than by changing the
already-returned **202** response.

#### GET /catalog/index

Returns the bulk library index for the paired Core: status plus artists and
albums with their durable descriptors. Empty catalog → **409**
`{ "error": "catalog empty" }`; degraded → **503**. Albums may carry native
(native-protocol) fields when a native snapshot is available:
`originalReleaseDate`, `releaseDate`, `importDate`, `playCount`,
`lastPlayedAt`, and native identity bindings. The response may also carry a
`native` capability block (`dateFeaturesAvailable`,
`playFeaturesAvailable`, and `playlistFeaturesAvailable`, with feature-local
reasons when unavailable).

#### GET /catalog/most-played

Returns one all-time, selected-profile native snapshot; the route takes no
query parameters. The response contains:

- `status` and the canonical `pulledAt` instant;
- `topPerformers`, ordered by exact Core-reported listening `minutes`;
- `topReleases`, ordered by exact Core-reported listening `minutes`; and
- `topTracks`, ordered by selected-profile `playCount`.

Performer and release rows carry opaque `selectionId` values for their native
drill routes. Release and track rows may also carry `albumLocalId` and
`imageKeyHint` accelerators when one unique public-catalog album is known, but
native identity remains authoritative. Track rows carry resolver authority for
Play Now, Add Next, and Queue; unavailable native rows carry an explicit
non-actionable authority instead. Aggregate performer labels (`Various
Artists`, `Various Performers`, `Unknown Artist`, and `Unknown Artists`) are
excluded. Raw native IDs and public Browse item keys are never returned.

Returns **409** with `details: "MOST_PLAYED_UNAVAILABLE"` when the
Most Played-specific capability is unavailable. A compatible retained
snapshot is not served through that gate.

#### GET /catalog/most-played/performers/:selectionId

Revalidates the opaque, snapshot-scoped performer selection, then returns every
bounded native library track attributed to that exact performer identity,
grouped by release in native disc/track order. This includes tracks on releases
whose album artist is `Various Artists`; it does not depend on a matching public
Library artist row. The response carries `snapshotPulledAt`, the performer
`name`, release metadata, and resolver authority for each available track.

#### GET /catalog/most-played/releases/:selectionId

Revalidates the opaque, snapshot-scoped release selection, then returns the
tracks belonging to that exact native album identity in disc/track order. The
response carries `snapshotPulledAt`, release metadata, optional catalog
accelerators, and resolver authority for each available track.

Both drill routes take no query parameters. An expired, wrong-kind, wrong-Core,
or replaced-snapshot selection fails closed; native capability loss and bounded
result/decoder failures are returned with their stable error detail rather than
falling back to title/artist guessing.

#### Playlist reads and management

`GET /catalog/playlists` returns the native playlist list, global write
availability, and per-playlist action eligibility. `GET
/catalog/playlists/:playlistId/contents` returns the Core-evaluated contents.
`GET /catalog/playlists/:playlistId/manage` refreshes live eligibility; for a
smart playlist it also returns the Focus scope, a plain summary, editability,
and track/album editor capability. The list and manage requests require
`X-Roon-Controller-Playlist-Actions: 2`; a stale browser receives **409**
`PLAYLIST_ACTIONS_RELOAD_REQUIRED`.

Complete Track Focus and Album Focus editing uses an opaque, process-local
editor lease:

- `POST /catalog/playlists/focus/bootstrap` with `{ "scope": "tracks" }` or
  `{ "scope": "albums" }` opens a create editor.
- `POST /catalog/playlists/:playlistId/focus/bootstrap` with `{}` opens the
  existing smart playlist without changing its scope.
- `POST /catalog/playlists/focus/document`, `/retry`, and `/heartbeat` take
  `{ "state": <editor-state> }`; the document operation advances its
  generation and returns a fresh advisory match count.
- `POST /catalog/playlists/focus/pick` takes the editor state plus one
  generation-bound picker request. `POST /catalog/playlists/focus/adopt`
  exchanges returned candidate IDs for editor-bound selection IDs.
- `POST /catalog/playlists/focus/close` explicitly releases the lease.
- `POST /catalog/playlists/focus` creates from `{ "name", "state" }`.
  `PUT /catalog/playlists/:playlistId/focus` updates from `{ "state" }`.

Bootstrap/document responses contain `status`, the opaque editor state,
`previewCount`, and selected display labels. Native IDs, query object IDs, and
raw criteria bytes never cross HTTP. One editor owns a Core at a time; a
second opener receives **409** `EDITOR_BUSY` unless it explicitly confirms
takeover. Update uses an opaque composite baseline and returns **409**
`EDITOR_CONFLICT` instead of overwriting a concurrent Roon edit.

Every successful create/update response is based on a fresh native read and
contains `playlistId`, `operationId`, and `detail`. `OUTCOME_UNKNOWN`,
`VERIFICATION_FAILED`, and `WRITE_FAILED_RETIRED` are terminal for that editor:
the browser must reopen from Roon before saving again. A `WRITE_FAILED` proven
before native invoke preserves the logical editor and its unsaved document.

Manual management remains available through `POST /catalog/playlists/manual`
and the target-specific `/rename`, `/description`, `/items`,
`/items/remove`, and `/items/move` routes. There is deliberately no public
whole-playlist `DELETE` route; deletion exists only in guarded local tooling.

#### GET /catalog/artists?query=:query&limit=:limit

Searches artists using deterministic exact, prefix, then substring ordering.
An empty query returns an empty result rather than dumping the catalog. `limit`
defaults to 20 and may not exceed 40.

#### GET /catalog/artists/:artistLocalId/albums?limit=:limit

Returns albums bound to the exact durable artist identifier. `limit` defaults
to 200 and may not exceed 500. In an available, complete catalog, a well-formed
but unknown artist identifier returns **404**; an unavailable catalog returns
**503** instead.

#### POST /catalog/artists/:artistLocalId/albums/load?revision=:revision&limit=:limit

Returns an existing resolved discography or uses a bounded, server-owned catalog
session to resolve one unresolved catalog artist, with the same artist-albums
response shape. The body must be empty.
`revision` is required and is the caller's catalog commit precondition; `limit`
has the same default and maximum as the read route. A revision mismatch returns
**409** with `details: "REVISION_CONFLICT"`, so the caller must reload
catalog state rather than retrying with the stale revision.

`GET /catalog/status` can return **200** with an empty, stale, or degraded status
so clients can diagnose it. Other catalog operations return **400** for
malformed or unsupported input, **404** for an unknown artist in an available
complete catalog, **409** for a revision conflict, and **503** when no Core is
paired or the requested operation cannot be served safely. `/api/health`
exposes catalog readiness and degradation as a non-critical diagnostic; it
never changes controller readiness.

---

### Image

#### GET /image/:key
Stream artwork by image key

**Query Parameters**:
- `scale` (optional): `fit`, `fill`, or `stretch`
- `width` (optional): Width in pixels
- `height` (optional): Height in pixels

**Note**: When `scale` is provided, both `width` and `height` are required.

**Example**:
```
GET /api/image/abc123?scale=fit&width=300&height=300
```

**Response**: Image stream with appropriate Content-Type and cache headers

---

## WebSocket Events

Connect to: `ws://localhost:3333/socket.io`

### Server → Client Events

#### core-status
Core connection status changed

**Payload**:
```json
{
  "coreStatus": "paired",
  "coreInfo": {
    "id": "core-id",
    "displayName": "Roon Core",
    "displayVersion": "1.8"
  }
}
```

#### zones
Complete zones snapshot

**Payload**:
```json
{
  "zones": [/* Array of Zone objects */]
}
```

#### zone-updated
Single zone update

**Payload**:
```json
{
  "zone": {/* Zone object */}
}
```

#### now-playing-updated
Now playing track changed

**Payload**:
```json
{
  "zone_id": "zone-1",
  "now_playing": {
    "title": "Track Title",
    "artist": "Artist Name",
    "album": "Album Name",
    "image_key": "img-key",
    "duration": 240,
    "seek_position": 30,
    "state": "playing"
  }
}
```

#### transport:error
Transport command failed

**Payload**:
```json
{
  "command": "transport:play-pause",
  "error": "Error message"
}
```

---

### Client → Server Commands

Transport commands support optional acknowledgment callbacks. Browse-session
commands require acknowledgments: their correlated response is returned only in
the acknowledgment, never as a `browse-result` or `search-result` broadcast.

#### transport:play-pause
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:next
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:previous
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:stop
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:seek
**Payload**: `{ "zone_id": "zone-1", "seconds": 120 }`

#### transport:volume
**Payload**: `{ "output_id": "output-1", "value": 50 }`

#### classic-session:acquire
**Payload**: `{ "requestId": "request-id", "tabId": "tab-id" }`

Returns an opaque `{ handleId, generation }` session reference in its mandatory
acknowledgment. A client must acquire a session before issuing browse-session
commands.

#### classic-session:release
**Payload**:
```json
{
  "requestId": "request-id",
  "tabId": "tab-id",
  "session": { "handleId": "opaque-handle", "generation": 1 }
}
```

Release is best-effort, but still uses an acknowledgment. Releasing, replacing,
or disconnecting a session invalidates its item tokens.

#### browse:browse, browse:load, browse:pop, browse:search
**Payload**:
```json
{
  "requestId": "request-id",
  "tabId": "tab-id",
  "session": { "handleId": "opaque-handle", "generation": 1 },
  "role": "classic-browse",
  "operation": "browse",
  "options": { "hierarchy": "browse", "popAll": true }
}
```

The event name and `operation` must match. `role` is one of
`classic-browse`, `classic-search`, or `classic-explore`; the hierarchy and
operation must be valid for that role. `options` is the bounded operation-specific
object and cannot contain `multiSessionKey`. Browse results use opaque item tokens
bound to the exact session generation and role. Coordinated search responses are
keyless. The mandatory acknowledgment echoes the `requestId` and session reference
and contains either `result`, or a bounded error code and message. The exact wire
schema and limits are defined in `src/shared/classicBrowseContracts.ts`.

---

### Album Actions

Album actions use a separate two-phase protocol. Resolving current Roon choices
does not itself execute a transport or queue command.

| Client → server | Request type | Acknowledgment type | Server follow-up event |
|---|---|---|---|
| `album-action:begin` | `AlbumActionBeginRequest` | `AlbumActionBeginAck` | `album-action:resolved` or `album-action:failed` |
| `album-action:cancel` | `AlbumActionCancelRequest` | `AlbumActionCancelAck` | none |
| `album-action:execute` | `AlbumActionExecuteRequest` | `AlbumActionExecuteAck` | none |

All three client commands require acknowledgment callbacks. `begin` binds a
catalog `albumLocalId`, current `zoneId`, tab, and browse-session generation; a
successful resolution event returns bounded choices with opaque `actionId`
values. `execute` accepts only one such `actionId`—display labels and semantic
names grant no execution authority. Its acknowledgment distinguishes not
claimed, executed, rejected, and outcome-unknown results. A client must not
automatically retry an outcome-unknown execution.

The exact request, acknowledgment, event, choice, semantic, failure, and
execution-result schemas are defined in `src/shared/albumActionContracts.ts`
and imported in the frontend as `@shared/albumActionContracts`.

---

## Error Handling

HTTP errors use an `ErrorResponse`. `details` is present for typed Roon and
catalog errors, but is optional for validation, rate-limit, generic, and
not-found responses:

```json
{
  "error": "Error message",
  "details": "OPTIONAL_ERROR_CODE"
}
```

### HTTP Status Codes

- `200` - Success
- `202` - Background catalog refresh accepted
- `400` - Bad Request (invalid parameters)
- `404` - Not Found (route, image, or catalog artist not found)
- `409` - Catalog revision conflict; reload catalog state
- `429` - API rate limit exceeded
- `500` - Internal Server Error
- `503` - Service Unavailable (core not paired)
- `504` - Roon Core did not complete an accepted operation in time

### Representative `details` Codes

- `CORE_UNPAIRED` - Roon core not connected
- `SERVICE_UNAVAILABLE` - Required Roon service unavailable
- `IMAGE_NOT_FOUND` - Image key invalid
- `OPERATION_FAILED` - Roon operation failed
- `OPERATION_TIMEOUT` - Roon Core completion callback timed out
- `INVALID_QUERY` - Catalog query, limit, identifier, or revision is invalid
- `REVISION_CONFLICT` - Catalog changed since the caller's revision
- `CATALOG_ARTIST_NOT_FOUND` - Artist is absent from an available complete catalog
- `PERSISTENCE_DEGRADED` - Catalog persistence cannot safely accept the operation

---

## Type Definitions

Shared TypeScript contracts are organized by boundary rather than collected in
one file:

- `src/shared/types.ts` — common Core, zone, transport, queue, health,
  favorites, and recently-played API types
- `src/shared/classicBrowseContracts.ts` — browse-session wire contract (the
  legacy filename matches the retained `classic-*` protocol identifiers)
- `src/shared/browseHierarchies.ts` — accepted public browse hierarchy values
- `src/shared/searchTypes.ts` — shared Roon-to-controller search type mapping
- `src/shared/recentlyPlayed.ts` — shared recently-played identity and deduplication
  helpers
- `src/shared/catalogContracts.ts` — catalog REST descriptors, responses,
  placement evidence, parsers, and bounds
- `src/shared/albumActionContracts.ts` — album-action wire contract

Frontend code imports these modules through the `@shared/<module>` alias.
