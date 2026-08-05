import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInertActionSpy, createSyntheticZones, hitTestZone } from './zones';

describe('fixed-screen synthetic zones', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('hit-tests client coordinates against fixed zone rectangles', () => {
		const zones = createSyntheticZones();
		const first = zones[0];

		expect(
			hitTestZone(
				{ x: first.rect.x + first.rect.width / 2, y: first.rect.y + first.rect.height / 2 },
				zones
			)?.id
		).toBe(first.id);
		expect(hitTestZone({ x: first.rect.x, y: first.rect.y }, zones)?.id).toBe(first.id);
		expect(hitTestZone({ x: 400, y: 300 }, zones)).toBeNull();
	});

	it('records an explicit local choice while sending no network or live action', () => {
		const fetchSpy = vi.fn();
		const xhrSpy = vi.fn();
		const socketSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		vi.stubGlobal('XMLHttpRequest', xhrSpy);
		vi.stubGlobal('WebSocket', socketSpy);
		const spy = createInertActionSpy();

		const chooser = spy.open('synthetic-album', 'synthetic-zone');
		expect(chooser.open).toBe(true);
		expect(chooser.message).toContain('no command sent');
		expect(chooser.choices.map((choice) => choice.label)).toEqual(['Play Now', 'Add Next', 'Queue']);
		const record = spy.choose('synthetic-queue');

		expect(record).toEqual({
			albumId: 'synthetic-album',
			zoneId: 'synthetic-zone',
			choiceId: 'synthetic-queue',
			sent: false
		});
		expect(spy.getRecords()).toEqual([record]);
		expect(spy.getState().open).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(xhrSpy).not.toHaveBeenCalled();
		expect(socketSpy).not.toHaveBeenCalled();
	});

	it('cancels and resets without recording a choice', () => {
		const spy = createInertActionSpy();
		spy.open('synthetic-album', 'synthetic-zone');
		spy.cancel();

		expect(spy.getState().open).toBe(false);
		expect(spy.getRecords()).toEqual([]);
		expect(() => spy.choose('synthetic-play-now')).toThrow(/No inert chooser/);
		spy.reset();
		expect(spy.getRecords()).toEqual([]);
	});
});
