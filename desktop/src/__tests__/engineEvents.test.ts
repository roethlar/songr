import {
  parseNowPlayingEvent,
  parseZone,
  parseZoneRemovedEvent,
  parseZoneUpdatedEvent,
  parseZonesEvent,
} from '../engineEvents';

/** A zone payload shaped exactly like the backend's `Zone` on the wire. */
const wireZone = (overrides: Record<string, unknown> = {}): unknown => ({
  zone_id: '1601abc',
  display_name: 'Study',
  state: 'playing',
  is_play_allowed: false,
  is_pause_allowed: true,
  is_next_allowed: true,
  is_previous_allowed: true,
  ...overrides,
});

describe('parseZone', () => {
  it('maps the wire shape onto the tray model', () => {
    expect(parseZone(wireZone())).toEqual({
      zoneId: '1601abc',
      displayName: 'Study',
      state: 'playing',
      isPlayAllowed: false,
      isPauseAllowed: true,
      isNextAllowed: true,
      isPreviousAllowed: true,
    });
  });

  it('rejects anything without a zone id', () => {
    expect(parseZone(wireZone({ zone_id: '' }))).toBeNull();
    expect(parseZone(wireZone({ zone_id: 42 }))).toBeNull();
    expect(parseZone(null)).toBeNull();
    expect(parseZone('a zone')).toBeNull();
    expect(parseZone([])).toBeNull();
  });

  it('falls back to the zone id when there is no display name', () => {
    expect(parseZone(wireZone({ display_name: undefined }))?.displayName).toBe(
      '1601abc',
    );
  });

  it('reads an unknown playback state as stopped, never as playing', () => {
    expect(parseZone(wireZone({ state: 'buffering' }))?.state).toBe('stopped');
    expect(parseZone(wireZone({ state: undefined }))?.state).toBe('stopped');
  });

  it('treats missing permission flags as not allowed', () => {
    const parsed = parseZone({ zone_id: 'z', state: 'paused' });

    expect(parsed).toEqual({
      zoneId: 'z',
      displayName: 'z',
      state: 'paused',
      isPlayAllowed: false,
      isPauseAllowed: false,
      isNextAllowed: false,
      isPreviousAllowed: false,
    });
  });
});

describe('parseZonesEvent', () => {
  it('parses the snapshot the engine sends on connect', () => {
    const zones = parseZonesEvent({
      zones: [wireZone(), wireZone({ zone_id: 'kitchen' })],
    });

    expect(zones?.map((z) => z.zoneId)).toEqual(['1601abc', 'kitchen']);
  });

  it('parses the empty snapshot sent when the Core unpairs', () => {
    expect(parseZonesEvent({ zones: [] })).toEqual([]);
  });

  it('skips unusable entries instead of dropping the whole snapshot', () => {
    const zones = parseZonesEvent({ zones: [wireZone(), null, { nope: true }] });

    expect(zones).toHaveLength(1);
  });

  it('rejects a payload that is not a zone list', () => {
    expect(parseZonesEvent({ zones: 'none' })).toBeNull();
    expect(parseZonesEvent(undefined)).toBeNull();
  });
});

describe('parseZoneUpdatedEvent / parseZoneRemovedEvent', () => {
  it('unwraps the zone from a zone-updated payload', () => {
    expect(parseZoneUpdatedEvent({ zone: wireZone() })?.zoneId).toBe('1601abc');
  });

  it('rejects a zone-updated payload with no zone', () => {
    expect(parseZoneUpdatedEvent({})).toBeNull();
    expect(parseZoneUpdatedEvent(null)).toBeNull();
  });

  it('reads the zone id from a zone-removed payload', () => {
    expect(parseZoneRemovedEvent({ zone_id: 'kitchen' })).toBe('kitchen');
    expect(parseZoneRemovedEvent({})).toBeNull();
  });
});

describe('parseNowPlayingEvent', () => {
  it('keeps only the fields the tooltip shows', () => {
    expect(
      parseNowPlayingEvent({
        zone_id: 'study',
        now_playing: {
          zone_id: 'study',
          title: 'Cirrus',
          artist: 'Bonobo',
          album: 'The North Borders',
          image_key: 'abc',
          state: 'playing',
        },
      }),
    ).toEqual({ zoneId: 'study', track: { title: 'Cirrus', artist: 'Bonobo' } });
  });

  it('preserves a null now_playing as a cleared track', () => {
    // The engine sends this when a zone is removed; it is a real instruction,
    // not a malformed payload.
    expect(parseNowPlayingEvent({ zone_id: 'study', now_playing: null })).toEqual({
      zoneId: 'study',
      track: null,
    });
  });

  it('treats a track with neither title nor artist as no track', () => {
    expect(
      parseNowPlayingEvent({ zone_id: 'study', now_playing: { state: 'playing' } }),
    ).toEqual({ zoneId: 'study', track: null });
  });

  it('rejects a payload with no zone id', () => {
    expect(parseNowPlayingEvent({ now_playing: { title: 'Cirrus' } })).toBeNull();
  });
});
