import { describe, expect, it } from 'vitest';
import { trackPlaybackOrder } from '../trackPlaybackOrder';

const top = Object.freeze({ title: 'Same title', token: 'first-exact' });
const middle = Object.freeze({ title: 'Middle', token: 'middle-exact' });
const bottom = Object.freeze({ title: 'Same title', token: 'last-exact' });
const displayed = Object.freeze([top, middle, bottom]);

describe('selected track playback order', () => {
	it('appends Queue in current list order and preserves exact duplicate objects', () => {
		const result = trackPlaybackOrder(displayed, 'queue');
		expect(result.map(step => step.semantic)).toEqual(['queue', 'queue', 'queue']);
		expect(result[0].item).toBe(top);
		expect(result[1].item).toBe(middle);
		expect(result[2].item).toBe(bottom);
	});
	it('plays the first selected row once and queues the rest, never resetting for each row', () => {
		const result = trackPlaybackOrder(displayed, 'play-now');
		expect(result.map(step => [step.item, step.semantic])).toEqual([
			[top, 'play-now'], [middle, 'queue'], [bottom, 'queue']
		]);
	});
	it('inserts Add Next in reverse execution order so final queue order is top-to-bottom', () => {
		const result = trackPlaybackOrder(displayed, 'add-next');
		expect(result.map(step => step.item)).toEqual([bottom, middle, top]);
		const queue = [{ title: 'Existing next', token: 'prior' }];
		for (const step of result) queue.unshift(step.item);
		expect(queue.slice(0, 3)).toEqual(displayed);
		expect(displayed).toEqual([top, middle, bottom]);
	});
	it.each(['queue', 'play-now', 'add-next'] as const)('handles empty and single %s selections', (semantic) => {
		expect(trackPlaybackOrder([], semantic)).toEqual([]);
		expect(trackPlaybackOrder([top], semantic)).toEqual([{ item: top, semantic }]);
	});
});
