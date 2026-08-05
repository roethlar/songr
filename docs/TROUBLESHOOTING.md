# Troubleshooting Guide

## Initial Pairing with Roon Core

### First-Time Setup

When you first start the Roon Controller, it will show status: `discovering`. This means the backend is searching for your Roon Core on the network.

**To complete pairing**:

1. **Start the backend**:
   ```bash
   npm run dev
   # or
   npm start
   ```

2. **Open your Roon application** (desktop or mobile)

3. **Navigate to Settings**:
   - Click Settings icon
   - Go to **Extensions** section

4. **Authorize the controller**:
   - Look for "Roon Web Controller" in the list (installs paired
     before mid-2026 may still show the older name "Custom Roon
     Controller")
   - Click **Enable** to authorize
   - The backend will immediately receive the pairing token

5. **Verify connection**:
   - Backend logs should show: "Paired with Roon core"
   - Frontend status changes from `discovering` to `paired`
   - Token saved to `config/roon-token.json`

**Subsequent Starts**: The saved token auto-reconnects - no manual authorization needed.

---

## Common Issues

### "Status stuck on discovering"

**Possible causes**:
- Roon Core not running on network
- Firewall blocking mDNS/network discovery
- Different network subnet

**Solutions**:
1. Verify Roon Core is running (check Roon app)
2. Ensure backend and Roon Core on same network
3. Check firewall settings allow node.js network access
4. Review backend logs: `npm run dev` shows discovery attempts

### "Status shows unpaired after working"

**Cause**: Roon Core disconnected or extension was disabled

**Solutions**:
1. Check Roon Core is still running
2. Go to Roon → Settings → Extensions
3. Re-enable "Roon Web Controller" if disabled
4. Check network connectivity

### "Controls not working / No zones shown"

**Possible causes**:
- Frontend not connected to backend
- WebSocket connection failed
- No active zones in Roon

**Solutions**:
1. Check connection indicator in nav bar (should show "Connected")
2. Open browser console, look for WebSocket errors
3. Verify backend is running on port 3333
4. Ensure at least one zone is playing in Roon
5. Check backend logs for zone subscription errors

### "Images not loading"

**Possible causes**:
- Image service not available from Core
- Invalid image keys
- CORS issues

**Solutions**:
1. Check backend logs for image service errors
2. Verify Core connection status is `paired`
3. Test direct image URL: `/api/image/{key}` in browser
4. Check browser console for CORS errors

### "Volume control not responding"

**Possible causes**:
- The zone output has fixed volume and therefore exposes no volume control
- A `number` or `db` output uses the slider, while an `incremental` output uses
  the **− / +** buttons
- A multi-output zone targets the first output that Roon reports as
  controllable
- The browser has lost its Socket.IO connection or the selected zone changed

**Checks**:
1. Confirm the selected zone and connection indicator are current
2. Look for a slider for `number` / `db`, or **− / +** for `incremental`
3. If no control is shown, verify in Roon whether that output is fixed-volume
4. For a multi-output zone, use Roon directly if a different output must be
   adjusted

---

## Timeline Canvas Diagnostics

These checks apply to development or acceptance builds in which Timeline has
been explicitly enabled. The production build currently keeps Timeline behind
its release gate.

### "Timeline canvas" is not listed in Controller settings

This is expected in the current production build. Controller settings lists
only production-available Library views, so **Classic** is the only choice while
the Timeline release gate is closed.

The catalog REST routes and Timeline Socket.IO handlers may still be present.
They are backend capabilities, not feature flags, and calling them does not
enable the Timeline UI. A saved Timeline preference also resolves safely to
Classic while the gate is closed.

### "The artist catalog is not ready yet"

Timeline uses a controller-owned catalog scoped to the currently paired Core.
Check its state without caching the result:

```bash
curl http://localhost:3333/api/catalog/status
```

- `available: false` with `freshness: "empty"`: use **Scan library** in an
  enabled Timeline build, or start the same background scan with
  `curl -X POST http://localhost:3333/api/catalog/refresh`.
- `refresh: "running"`: the scan is asynchronous. Wait and poll `/status`;
  repeated refresh requests join the same scan.
- `freshness: "stale"` with `available: true`: a prior complete snapshot is
  still available, but use **Refresh catalog** before relying on current
  library membership.
- `persistence: "degraded"`: artist loading and refresh are intentionally
  blocked. Check backend logs and make sure the service account can read and
  write `TIMELINE_CATALOG_PATH` (default `./data/catalog`), then restart after
  correcting the filesystem problem.

A Core change creates a different catalog scope. Wait for the new Core to pair,
then scan or search again rather than expecting identifiers from the previous
Core to carry over.

### Album action is unavailable, rejected, or has an unknown outcome

Timeline resolves the actions Roon currently offers for one resolved album and
one current zone. The Core connection, Timeline session, album resolution, and
zone must remain current while that happens.

- Dropping an album on a zone or choosing **Send to…** opens a chooser; it does
  not start playback or alter the queue by itself.
- Canceling while actions are resolving or being chosen sends no playback or
  queue action.
- After an action is selected and the chooser says it is sending, execution is
  server-owned. The controller does not cancel or retry it automatically.
- If the result is **Outcome unknown**, inspect that zone and its queue in Roon
  before trying again. Retrying blindly can duplicate a queue addition or
  repeat a playback command.
- If the album, Core, session, or target zone changed, settle the connection and
  reopen the album's action menu to resolve a fresh set of actions.

### Timeline offers to open something in Classic

This is a deliberate fallback for Library workflows that remain in Classic,
including broad search, Favorites, Recently Played, and some album/track
drill-downs. Confirming the dialog changes the Library view; it does not send a
playback command. In a build where Timeline is available, use browser **Back**
or Controller settings to return.

### An album appears under "Undated"

Timeline puts a resolved album on the calendar axis only when the catalog has
proven original-release-date evidence. An edition or reissue date is not used
as a substitute. Unresolved albums and albums without that evidence remain
explicitly **Undated** rather than receiving a guessed year.

Refresh the catalog if the library metadata changed. If the album remains
Undated after a successful refresh, that is the expected fail-closed placement.

### A moved album returned to the timeline or its placement is unavailable

Manual placement is visual and held only in the current browser tab; it never
changes release order or catalog chronology. A reload, a different Core or
artist scope, or a changed catalog model can clear or prune offsets.

- Use the album action menu's **Return to timeline** command to restore its
  canonical anchor. Dropping it close to that anchor also snaps it back.
- **Fit** and **Recenter** change the camera, not album placement.
- If placement is temporarily unavailable, wait for Timeline reconnection or
  re-resolution to settle, then retry. Reloading the page clears the tab's
  remaining manual placements.

---

## Development Issues

### "npm run build fails"

**Check**:
1. All dependencies installed: `npm install`
2. TypeScript version compatible: `npm list typescript`
3. Review build errors for missing types

### "Tests failing"

**Solutions**:
1. Clear Jest cache: `npx jest --clearCache`
2. Reinstall test dependencies: `npm install --save-dev jest ts-jest @types/jest`
3. Check test file imports match source structure

### "Frontend not connecting to backend"

**Check Vite proxy**:
1. Backend running on port 3333
2. Frontend started with: `cd ui && npm run dev`
3. Check `ui/vite.config.ts` proxy configuration

**Verify**:
```bash
# Test backend directly
curl http://localhost:3333/api/core

# Check Socket.IO
curl http://localhost:3333/socket.io/
```

---

## Docker Issues

### "Container won't start"

**Check**:
1. Port 3333 not already in use: `lsof -i :3333`
2. Volume mounts exist and have correct permissions
3. Review container logs: `docker logs roon-controller`

### "Can't connect to Roon Core from container"

**Solution**: The repo's `docker-compose.yml` already sets `network_mode: host`
(required on Linux). For plain `docker run`, pass the flag yourself:
```bash
docker run --network=host roon-controller
```

**Reason**: Roon discovery uses mDNS which requires host network access.
With host networking, the app listens on PORT (default 3333) directly on
the host — no `-p` port mapping applies. On Docker Desktop for
macOS/Windows, `network_mode: host` is a no-op unless its "host
networking" feature is enabled; run natively there instead.

---

## Configuration Errors

### "ConfigError: PORT must be an integer"

**Fix**: Ensure PORT in .env is a valid number 1-65535

### "ConfigError: LOG_LEVEL must be one of..."

**Fix**: Use valid Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`

### "ROON_TOKEN_PATH cannot be empty"

**Fix**: Either:
- Set valid path in .env: `ROON_TOKEN_PATH=./config/roon-token.json`
- Or remove variable to use default location

---

## Performance Issues

### "Slow image loading"

The first request for an artwork size may still have to fetch from Roon. Repeat
requests can be served by the controller's byte-bounded in-memory cache, its
disk LRU, and the browser's 24-hour immutable cache header.

**Checks / optimization**:
- Use smaller dimensions: `?scale=fit&width=200&height=200`
- Confirm `IMAGE_CACHE_PATH` (default `./data/image-cache`) is writable and the
  disk has space
- The disk LRU defaults to a 10 GB cap (`IMAGE_CACHE_MAX_BYTES`) and evicts old
  entries when over the cap; a cache miss after eviction is normal
- The controller's hot in-memory artwork cache is capped at 32 MB; the disk
  cache is not held entirely in memory
- Consider a same-origin reverse-proxy cache only if the built-in layers are
  insufficient

### "High memory usage"

**Check**:
- Number of zones being tracked
- WebSocket connection count
- Whether another process, rather than this controller, owns the memory
- Review logs for memory leaks

Artwork files live under `IMAGE_CACHE_PATH`; they are not all held in RAM. The
controller's artwork hot cache is byte-bounded to 32 MB.

---

## Getting Help

**Logs Location**:
- Development: Console output from `npm run dev`
- Docker: `docker logs roon-controller`
- Systemd: `journalctl -u roon-controller -f`
- macOS launchd: `/Library/Logs/RoonController/`

**Debug Mode**:
```bash
LOG_LEVEL=debug npm run dev
```

**Check Backend Health**:
```bash
curl http://localhost:3333/api/health
curl http://localhost:3333/api/core
```

**Useful Log Patterns**:
- "Paired with Roon core" - Successful pairing
- "Subscribed to zone updates" - Transport service active
- "Transport service not available" - Core not paired yet
- "WebSocket client connected" - Frontend connected

---

## Known Limitations

1. **Timeline availability**: Timeline code and protocols are present, but the
   current production UI release gate remains closed; Classic is the selectable
   Library view.
2. **Queue editing**: Roon's public transport API does not expose remove or
   reorder operations. Queue subscription, play-from-here, shuffle, loop, and
   auto-radio controls are implemented.
3. **Multi-output volume**: The UI controls the first controllable output in a
   zone. Fixed-volume outputs expose no control; `number`, `db`, and
   `incremental` controls are supported.
4. **Timeline placement**: Manual album positions are visual, tab-local, and
   non-authoritative. They do not rewrite catalog chronology and are not durable
   across a page reload.
