import { describe, expect, it } from 'vitest';
import { chooseSelectionFocusTarget, fitSelectionToolbar, orderSelectionActions } from '../selectionToolbar';

describe('selection toolbar fitting', () => {
 const fit = (availableWidth: number, actionWidths = [31, 46, 53], hasMore = false) =>
  fitSelectionToolbar({ availableWidth, toolsWidth: 70, actionWidths, moreWidth: 35, gap: 11, hasMore });
 it('keeps every action direct when the complete row fits exactly', () => {
  expect(fit(211)).toEqual({ visibleCount: 3, showMore: false, width: 211 });
 });
 it('reserves room for More before choosing which actions remain direct', () => {
  expect(fit(190)).toEqual({ visibleCount: 1, showMore: true, width: 147 });
 });
 it('keeps remote actions under the same More control even if local actions all fit', () => {
  expect(fit(246, undefined, true)).toEqual({ visibleCount: 3, showMore: true, width: 246 });
 });
 it('refits heterogeneous text widths without assuming square icon buttons', () => {
  expect(fit(220, [95, 132, 48])).toEqual({ visibleCount: 1, showMore: true, width: 211 });
 });
 it('moves all actions to More when only mandatory controls fit', () => {
  expect(fit(116)).toEqual({ visibleCount: 0, showMore: true, width: 116 });
 });
 it('preserves action order instead of backfilling short secondary actions', () => {
  expect(fit(200, [90, 10])).toEqual({ visibleCount: 2, showMore: false, width: 181 });
  expect(fit(200, [90, 10], true)).toEqual({ visibleCount: 0, showMore: true, width: 116 });
 });
 it('removes More on resize once the complete row fits', () => {
  expect(fit(150).showMore).toBe(true);
  expect(fit(250).showMore).toBe(false);
 });
 it('never invents More for an empty action list that fits', () => {
  expect(fit(70, [])).toEqual({ visibleCount: 0, showMore: false, width: 70 });
 });
 it('fits against fractional measured widths without rounding into overflow', () => {
  const actual = fitSelectionToolbar({ availableWidth: 110.4, toolsWidth: 40.2, actionWidths: [30.2, 30.2], moreWidth: 20.1, gap: 10 });
  expect(actual.visibleCount).toBe(1);
  expect(actual.showMore).toBe(true);
  expect(actual.width).toBeCloseTo(100.5);
 });
});

describe('selection action provenance and order', () => {
 it('normalizes known actions without replacing their identities or capabilities', () => {
  const actions = [
   { id: 'find', token: {} }, { id: 'queue', token: {} }, { id: 'play-now', token: {} },
   { id: 'remove', token: {} }, { id: 'bookmark', token: {} }, { id: 'add-next', token: {} }
  ];
  const ordered = orderSelectionActions(actions);
  expect(ordered.map(action => action.id)).toEqual(['play-now', 'add-next', 'queue', 'bookmark', 'find', 'remove']);
  expect(ordered[0]).toBe(actions[2]);
  expect(actions[0].id).toBe('find');
 });
 it('preserves order among unknown server-advertised operations', () => {
  const actions = [{ id: 'roon-a' }, { id: 'roon-b' }, { id: 'roon-c' }];
  expect(orderSelectionActions(actions)).toEqual(actions);
 });
});

describe('focus after the selection toolbar disappears', () => {
 it('returns to the selected visible row rather than the first row', () => {
  expect(chooseSelectionFocusTarget([
   { target: 'first', selected: false, visible: true, disabled: false },
   { target: 'selected', selected: true, visible: true, disabled: false }
  ])).toBe('selected');
 });
 it('skips selected rows hidden by filtering and inactive retained panels', () => {
  expect(chooseSelectionFocusTarget([
   { target: 'hidden', selected: true, visible: false, disabled: false },
   { target: 'available', selected: false, visible: true, disabled: false }
  ])).toBe('available');
 });
 it('skips disabled rows when a data refresh invalidates the selected target', () => {
  expect(chooseSelectionFocusTarget([
   { target: 'stale', selected: true, visible: true, disabled: true },
   { target: 'available', selected: false, visible: true, disabled: false }
  ])).toBe('available');
 });
 it('returns no target when the entire list was removed', () => {
  expect(chooseSelectionFocusTarget([])).toBeNull();
 });
});
