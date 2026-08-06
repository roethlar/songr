import {
  NOTHING_PLAYING,
  TrayZoneTracker,
  deriveTrayMenuState,
} from '../trayModel';
import type { TrayPlaybackState, TrayZone } from '../trayModel';

const zone = (
  zoneId: string,
  state: TrayPlaybackState,
  overrides: Partial<TrayZone> = {},
): TrayZone => ({
  zoneId,
  displayName: zoneId,
  state,
  isPlayAllowed: state !== 'playing',
  isPauseAllowed: state === 'playing',
  isNextAllowed: true,
  isPreviousAllowed: true,
  ...overrides,
});

describe('TrayZoneTracker zone heuristic', () => {
  it('has no target before anything has played', () => {
    const tracker = new TrayZoneTracker();
    tracker.replaceZones([zone('kitchen', 'stopped'), zone('study', 'paused')]);

    expect(tracker.target).toBeNull();
    expect(tracker.targetZoneId).toBeNull();
  });

  it('targets the only zone that is playing', () => {
    const tracker = new TrayZoneTracker();
    tracker.replaceZones([
      zone('kitchen', 'stopped'),
      zone('study', 'playing'),
      zone('attic', 'paused'),
    ]);

    expect(tracker.targetZoneId).toBe('study');
  });

  it('prefers the zone that started playing most recently', () => {
    const tracker = new TrayZoneTracker();
    tracker.replaceZones([zone('kitchen', 'stopped'), zone('study', 'stopped')]);

    tracker.upsertZone(zone('kitchen', 'playing'));
    expect(tracker.targetZoneId).toBe('kitchen');

    tracker.upsertZone(zone('study', 'playing'));
    expect(tracker.targetZoneId).toBe('study');
  });

  it('does not let seek ticks on an older zone steal the selection', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('kitchen', 'playing'));
    tracker.upsertZone(zone('study', 'playing'));
    expect(tracker.targetZoneId).toBe('study');

    // Roon re-emits a playing zone constantly (seek position, volume). Those
    // updates are not a new "started playing", so the target must not move.
    tracker.upsertZone(zone('kitchen', 'playing'));
    tracker.upsertZone(zone('kitchen', 'playing'));

    expect(tracker.targetZoneId).toBe('study');
  });

  it('keeps the paused zone selected so play can resume it', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('study', 'playing'));
    tracker.upsertZone(zone('study', 'paused'));

    // Without this the tray would disable its own Play item the instant the
    // user pressed Pause from it.
    expect(tracker.targetZoneId).toBe('study');
  });

  it('hands the selection back to a zone that is actually playing', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('kitchen', 'playing'));
    tracker.upsertZone(zone('study', 'playing'));
    tracker.upsertZone(zone('study', 'paused'));

    // Kitchen is the only one still playing, even though study started later.
    expect(tracker.targetZoneId).toBe('kitchen');
  });

  it('drops a removed zone, including as a fallback target', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('study', 'playing'));
    tracker.setTrack('study', { title: 'Cirrus', artist: 'Bonobo' });
    tracker.upsertZone(zone('study', 'paused'));

    tracker.removeZone('study');

    expect(tracker.target).toBeNull();
  });

  it('drops zones missing from a fresh snapshot', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('study', 'playing'));
    expect(tracker.targetZoneId).toBe('study');

    tracker.replaceZones([zone('kitchen', 'stopped')]);

    expect(tracker.target).toBeNull();
  });

  it('forgets everything on clear', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('study', 'playing'));
    tracker.setTrack('study', { title: 'Cirrus' });

    tracker.clear();

    expect(tracker.target).toBeNull();
  });

  it('carries the track of the selected zone', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('study', 'playing'));
    tracker.setTrack('kitchen', { title: 'Wrong', artist: 'Wrong' });
    tracker.setTrack('study', { title: 'Cirrus', artist: 'Bonobo' });

    expect(tracker.target?.track).toEqual({ title: 'Cirrus', artist: 'Bonobo' });
  });

  it('clears a track when the zone reports none', () => {
    const tracker = new TrayZoneTracker();
    tracker.upsertZone(zone('study', 'playing'));
    tracker.setTrack('study', { title: 'Cirrus', artist: 'Bonobo' });
    tracker.setTrack('study', null);

    expect(tracker.target?.track).toBeNull();
  });
});

describe('deriveTrayMenuState', () => {
  it('disables transport and says nothing is playing with no target', () => {
    const state = deriveTrayMenuState({ target: null, windowVisible: true });

    expect(state.tooltip).toBe(NOTHING_PLAYING);
    expect(state.targetZoneId).toBeNull();
    expect(state.playPause).toEqual({ label: 'Play', enabled: false });
    expect(state.next.enabled).toBe(false);
    expect(state.previous.enabled).toBe(false);
  });

  it('shows artist and title for a playing zone', () => {
    const state = deriveTrayMenuState({
      target: {
        zone: zone('study', 'playing'),
        track: { title: 'Cirrus', artist: 'Bonobo' },
      },
      windowVisible: false,
    });

    expect(state.tooltip).toBe('Bonobo — Cirrus');
    expect(state.targetZoneId).toBe('study');
  });

  it('degrades the tooltip when half the metadata is missing', () => {
    const titleOnly = deriveTrayMenuState({
      target: { zone: zone('study', 'playing'), track: { title: 'Cirrus' } },
      windowVisible: false,
    });
    const artistOnly = deriveTrayMenuState({
      target: { zone: zone('study', 'playing'), track: { artist: 'Bonobo' } },
      windowVisible: false,
    });
    const neither = deriveTrayMenuState({
      target: { zone: zone('study', 'playing'), track: null },
      windowVisible: false,
    });

    expect(titleOnly.tooltip).toBe('Cirrus');
    expect(artistOnly.tooltip).toBe('Bonobo');
    expect(neither.tooltip).toBe(NOTHING_PLAYING);
  });

  it('offers Pause while playing and Play while paused', () => {
    const playing = deriveTrayMenuState({
      target: { zone: zone('study', 'playing'), track: null },
      windowVisible: true,
    });
    const paused = deriveTrayMenuState({
      target: { zone: zone('study', 'paused'), track: null },
      windowVisible: true,
    });

    expect(playing.playPause).toEqual({ label: 'Pause', enabled: true });
    expect(paused.playPause).toEqual({ label: 'Play', enabled: true });
  });

  it('follows the zone permission flags', () => {
    const state = deriveTrayMenuState({
      target: {
        zone: zone('study', 'playing', {
          isPauseAllowed: false,
          isNextAllowed: false,
          isPreviousAllowed: true,
        }),
        track: null,
      },
      windowVisible: true,
    });

    expect(state.playPause.enabled).toBe(false);
    expect(state.next.enabled).toBe(false);
    expect(state.previous.enabled).toBe(true);
  });

  it('labels the window item for what the click will do', () => {
    expect(
      deriveTrayMenuState({ target: null, windowVisible: true }).windowItem.label,
    ).toBe('Hide Window');
    expect(
      deriveTrayMenuState({ target: null, windowVisible: false }).windowItem.label,
    ).toBe('Show Window');
  });
});
