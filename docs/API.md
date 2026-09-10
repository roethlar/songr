# Songr API Reference

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

#### GET /core/discovery

Returns pre-authorization observations independently of the paired-Core
lifecycle. `Cache-Control: no-store`. The `core-discovery` Socket.IO event
publishes the same snapshot, including initial hydration on each connection.

```json
{
  "cores": [{
    "id": "discovery-id",
    "displayName": "Studio Core",
    "host": "192.0.2.10",
    "phase": "awaiting-approval"
  }]
}
```

Phases: `connecting`, `registering` (reading Core identity), `awaiting-approval`
(registry info answered and registration submitted), `registered`, `failed`.
A failed entry may include `detail`; a local discovery socket failure may add
top-level `error`. No registry bodies or authorization tokens are included.
An empty `cores` list means no Core has been observed in this discovery run;
it does not establish that a firewall is blocking traffic. Failed observations
remain identifiable until a later discovery retries them or a Core switch
clears the run.

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

The Library uses the live root/open reads below for discovery. Songr does not
keep a separate library catalog or expose private-protocol playlist, DSP or
Most Played APIs.

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

### Live library

These routes read the connected Core through Roon's public Browse API. Root
snapshots and opaque row references belong to the current in-memory generation;
they are not stored library records or stable playback identifiers.

| Route | Request | Result |
|---|---|---|
| `GET /library/roots` | Optional `generation` query | Current Artists/Albums snapshot, confirmation that the held generation is current, or an unavailable result |
| `POST /library/roots/refresh` | No body required | Explicitly refresh the live roots |
| `POST /library/open` | `{ "ref": { "generation": "…", "token": "…" } }` | Open that exact current row |
| `POST /library/open` | `{ "root": "genres" }` or `{ "root": "composers" }` | Open an on-demand root |
| `POST /library/preview` | `{ "ref": { "generation": "…", "token": "…" }, "limit": 8 }` | A bounded preview; limit is 1–100 |

A stale generation returns **409**. Unavailable Core/session/read results use
**503**; malformed inputs use **400**. Responses carry their contract and
result kind rather than pretending a failed read is an empty library. The
complete schemas are `libraryRootsContracts.ts`, `libraryOpenContracts.ts` and
`libraryPreviewContracts.ts` under `src/shared/`.

`/api/catalog/*` and the earlier REST Browse mutation routes are removed and
return the generic JSON API **404**. No catalog refresh or index-rebuild command
is required for the current Library.

### Navigation settings

`GET /settings/navigation` reads the server's complete committed navigation
snapshot. `PUT /settings/navigation` updates it with the version/revision and
preferences defined in `src/shared/navigationSettings.ts`. A conflicting write
returns **409** with the current snapshot; invalid input returns **400** and
unavailable persistence returns **503**. Both routes disable HTTP caching.

The `navigation-settings-updated` Socket.IO event broadcasts the complete saved
snapshot to connected clients. Settings belong to the Songr server, including
an embedded desktop server; they are not per-browser local preferences.

### Recently played and setup

- `GET /recently-played` returns the history observed by this Songr server.
- `DELETE /recently-played` clears that history. It does not alter Roon history.
- `GET /onboarding` returns current first-run setup status.
- `POST /core/switch` starts switching the paired Core; see the request handling
  in `src/server/http/routes/core.ts` before constructing a client.
- `GET /health` is available under `/api` and also at `/health`.

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
`classic-browse`, `classic-search`, `classic-explore`, or `classic-composition`; the hierarchy and
operation must be valid for that role. `options` is the bounded operation-specific
object and cannot contain `multiSessionKey`. Browse results use opaque item tokens
bound to the exact session generation and role. Coordinated search responses are
keyless. The mandatory acknowledgment echoes the `requestId` and session reference
and contains either `result`, or a bounded error code and message. The exact wire
schema and limits are defined in `src/shared/classicBrowseContracts.ts`.

---

### Retained album reads and search

`library-album:open`, `library-album:select` and `library-album:cancel` use
acknowledgments and the `library-album:versions`, `:resolved`, `:version-failed`
and `:failed` follow-up events. A retained page is opened from a public
collection locator and has opaque operation/version identity. It is not a
catalog record. See `src/shared/libraryAlbumContracts.ts`.

The search palette uses `unified-search:search`, `unified-search:clear` and
`unified-search:action`, with the schemas in `src/shared/unifiedSearchContracts.ts`.
Current selected-result/action authority is required; a display title alone does
not authorize playback.

### Album Actions

Album actions use a separate two-phase protocol. Resolving current Roon choices
does not itself execute a transport or queue command.

| Client → server | Request type | Acknowledgment type | Server follow-up event |
|---|---|---|---|
| `album-action:begin` | `AlbumActionBeginRequest` | `AlbumActionBeginAck` | `album-action:resolved` or `album-action:failed` |
| `album-action:cancel` | `AlbumActionCancelRequest` | `AlbumActionCancelAck` | none |
| `album-action:execute` | `AlbumActionExecuteRequest` | `AlbumActionExecuteAck` | none |

All three client commands require acknowledgment callbacks. `begin` binds the
current zone, tab and generation to either an exact live row `ref` or a retained
album `pageId` and `versionId` (optionally one validated track selector). A
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

Generic HTTP errors use an `ErrorResponse`. `details` may identify a typed Roon
error; validation, rate-limit and not-found responses may omit it. Live-library
routes use the contract-specific response shapes described above:

```json
{
  "error": "Error message",
  "details": "OPTIONAL_ERROR_CODE"
}
```

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (invalid parameters)
- `404` - Not Found (route or image not found)
- `409` - Stale library reference or navigation-settings revision conflict
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
- `src/shared/libraryRootsContracts.ts`, `libraryOpenContracts.ts` and
  `libraryPreviewContracts.ts` — live library reads and exact row references
- `src/shared/libraryAlbumContracts.ts` — retained live album-page reads
- `src/shared/navigationSettings.ts` — persisted navigation preferences
- `src/shared/albumActionContracts.ts` — album-action wire contract

Frontend code imports these modules through the `@shared/<module>` alias.
