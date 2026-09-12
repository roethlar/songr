/** Action order is stable within each capability. Unknown Roon actions retain their order. */
export function orderSelectionActions<T extends { id: string }>(actions: readonly T[]): T[] {
 const priority = (id: string): number => {
  if (['play', 'play-now', 'play-from-here'].includes(id)) return 0;
  if (['next', 'add-next'].includes(id)) return 1;
  if (id === 'queue') return 2;
  if (id === 'bookmark') return 3;
  return 4;
 };
 return actions.map((action, index) => ({ action, index }))
  .sort((a, b) => priority(a.action.id) - priority(b.action.id) || a.index - b.index)
  .map(({ action }) => action);
}

export interface SelectionToolbarFit {
 visibleCount: number;
 showMore: boolean;
 width: number;
}

/** Fits complete actions; mandatory All/Clear stay direct and More reserves its own width. */
export function fitSelectionToolbar({ availableWidth, toolsWidth, actionWidths, moreWidth, gap = 12, hasMore = false }: {
 availableWidth: number;
 toolsWidth: number;
 actionWidths: readonly number[];
 moreWidth: number;
 gap?: number;
 hasMore?: boolean;
}): SelectionToolbarFit {
 const available = Math.max(0, availableWidth);
 const widths = actionWidths.map(width => Math.max(0, width));
 const total = widths.reduce((sum, width) => sum + width, 0);
 const directWidth = toolsWidth + (widths.length ? gap : 0) + total;
 if (!hasMore && directWidth <= available) {
  return { visibleCount: widths.length, showMore: false, width: directWidth };
 }
 let width = toolsWidth + gap + moreWidth;
 let visibleCount = 0;
 for (const itemWidth of widths) {
  if (width + itemWidth > available) break;
  width += itemWidth;
  visibleCount++;
 }
 return { visibleCount, showMore: true, width };
}

/** A disappearing toolbar returns focus to its selected visible row, then a visible row. */
export function chooseSelectionFocusTarget<T>(candidates: readonly {
 target: T; selected: boolean; visible: boolean; disabled: boolean;
}[]): T | null {
 const reachable = candidates.filter(candidate => candidate.visible && !candidate.disabled);
 return (reachable.find(candidate => candidate.selected) ?? reachable[0])?.target ?? null;
}
