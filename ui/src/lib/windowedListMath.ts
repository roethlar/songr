/**
 * Pure viewport math for windowed rendering (plan §3.2 scale
 * independence). Components own the DOM; every number here is testable.
 */

export interface WindowOptions {
	/** Total entry count. */
	readonly total: number;
	/** Fixed row height in px (one grid row). */
	readonly rowHeight: number;
	/** Entries per row (1 for lists, N for grids). */
	readonly columns: number;
	readonly viewportHeight: number;
	readonly scrollTop: number;
	/** Extra rows rendered on each side. */
	readonly overscan: number;
}

export interface WindowSpec {
	/** First rendered entry index (inclusive). */
	readonly start: number;
	/** Last rendered entry index (exclusive). */
	readonly end: number;
	/** Spacer above the rendered slice, px. */
	readonly topPad: number;
	/** Spacer below the rendered slice, px. */
	readonly bottomPad: number;
	/** Full scroll height, px. */
	readonly totalHeight: number;
}

export function computeWindow(options: WindowOptions): WindowSpec {
	const { total, rowHeight, columns, viewportHeight, scrollTop, overscan } = options;
	if (
		!Number.isFinite(total) ||
		total <= 0 ||
		rowHeight <= 0 ||
		columns <= 0 ||
		!Number.isInteger(columns)
	) {
		return { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0 };
	}
	const rows = Math.ceil(total / columns);
	const totalHeight = rows * rowHeight;
	const clampedScroll = Math.min(Math.max(scrollTop, 0), Math.max(totalHeight - viewportHeight, 0));
	const firstVisibleRow = Math.floor(clampedScroll / rowHeight);
	const visibleRows = Math.max(Math.ceil(viewportHeight / rowHeight), 1);
	const startRow = Math.max(firstVisibleRow - overscan, 0);
	const endRow = Math.min(firstVisibleRow + visibleRows + overscan, rows);
	const start = startRow * columns;
	const end = Math.min(endRow * columns, total);
	return {
		start,
		end,
		topPad: startRow * rowHeight,
		bottomPad: (rows - endRow) * rowHeight,
		totalHeight
	};
}

/** Scroll offset that puts an entry's row at the top of the viewport. */
export function scrollTopForIndex(
	index: number,
	options: Pick<WindowOptions, 'rowHeight' | 'columns'>
): number {
	if (index <= 0 || options.rowHeight <= 0 || options.columns <= 0) return 0;
	return Math.floor(index / options.columns) * options.rowHeight;
}
