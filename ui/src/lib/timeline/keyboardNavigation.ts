import { compareTimelineChronology } from './renderPlan';
import type { TimelineAlbumEntity } from './types';

export type TimelineKeyboardDirection =
	| 'left'
	| 'right'
	| 'up'
	| 'down'
	| 'home'
	| 'end';

export const TIMELINE_LIST_PAGE_SIZE = 40;

export interface TimelineBranchFocusNode {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	/** Stable topology identity used to keep Left/Right inside one branch lane. */
	readonly branchId?: string;
	/** Base or branch album that owns this branch lane. */
	readonly sourceId?: string;
	/** Deterministic lane order. Falls back to x then id when absent. */
	readonly siblingOrder?: number;
}

export interface TimelineKeyboardTargetOptions {
	readonly albums: readonly TimelineAlbumEntity[];
	readonly currentId: string | null;
	readonly direction: TimelineKeyboardDirection;
	readonly branchNodes?: readonly TimelineBranchFocusNode[];
}

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function orderedTimelineAlbums(
	albums: readonly TimelineAlbumEntity[]
): readonly TimelineAlbumEntity[] {
	return Object.freeze([...albums].sort(compareTimelineChronology));
}

export function timelineListPageCount(albums: readonly TimelineAlbumEntity[]): number {
	return Math.max(1, Math.ceil(albums.length / TIMELINE_LIST_PAGE_SIZE));
}

export function timelineListPageForId(
	albums: readonly TimelineAlbumEntity[],
	albumId: string | null
): number {
	const ordered = orderedTimelineAlbums(albums);
	const index = albumId ? ordered.findIndex((album) => album.id === albumId) : -1;
	return Math.floor(Math.max(0, index) / TIMELINE_LIST_PAGE_SIZE);
}

export function boundedTimelineListPage(
	albums: readonly TimelineAlbumEntity[],
	page: number
): readonly TimelineAlbumEntity[] {
	if (!Number.isSafeInteger(page) || page < 0) {
		throw new RangeError('Timeline list page must be a non-negative safe integer');
	}
	const ordered = orderedTimelineAlbums(albums);
	const start = page * TIMELINE_LIST_PAGE_SIZE;
	return Object.freeze(ordered.slice(start, start + TIMELINE_LIST_PAGE_SIZE));
}

export function resolveTimelineRovingId(
	albums: readonly TimelineAlbumEntity[],
	requestedId: string | null,
	selectedId: string | null = null
): string | null {
	const albumIds = new Set(albums.map((album) => album.id));
	if (requestedId && albumIds.has(requestedId)) return requestedId;
	if (selectedId && albumIds.has(selectedId)) return selectedId;
	return orderedTimelineAlbums(albums)[0]?.id ?? null;
}

function nearestBranchNode(
	current: Pick<TimelineAlbumEntity, 'x' | 'y'>,
	direction: 'up' | 'down',
	branchNodes: readonly TimelineBranchFocusNode[]
): TimelineBranchFocusNode | null {
	const candidates = branchNodes
		.filter((candidate) =>
			direction === 'up' ? candidate.y < current.y : candidate.y > current.y
		)
		.sort((left, right) => {
			const leftDeltaX = left.x - current.x;
			const leftDeltaY = left.y - current.y;
			const rightDeltaX = right.x - current.x;
			const rightDeltaY = right.y - current.y;
			return (
				leftDeltaX * leftDeltaX + leftDeltaY * leftDeltaY -
					(rightDeltaX * rightDeltaX + rightDeltaY * rightDeltaY) ||
				Math.abs(leftDeltaX) - Math.abs(rightDeltaX) ||
				Math.abs(leftDeltaY) - Math.abs(rightDeltaY) ||
				compareIds(left.id, right.id)
			);
		});
	return candidates[0] ?? null;
}

function compareBranchSiblings(
	left: TimelineBranchFocusNode,
	right: TimelineBranchFocusNode
): number {
	const leftOrder = left.siblingOrder;
	const rightOrder = right.siblingOrder;
	if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
		return leftOrder - rightOrder;
	}
	if (leftOrder !== undefined && rightOrder === undefined) return -1;
	if (leftOrder === undefined && rightOrder !== undefined) return 1;
	return left.x - right.x || compareIds(left.id, right.id);
}

function branchSiblings(
	current: TimelineBranchFocusNode,
	branchNodes: readonly TimelineBranchFocusNode[]
): readonly TimelineBranchFocusNode[] {
	const siblings = current.branchId
		? branchNodes.filter((candidate) => candidate.branchId === current.branchId)
		: branchNodes.filter((candidate) =>
			candidate.sourceId === current.sourceId && candidate.y === current.y
		);
	return [...siblings].sort(compareBranchSiblings);
}

function branchVerticalTarget(
	current: TimelineBranchFocusNode,
	direction: 'up' | 'down',
	albums: readonly TimelineAlbumEntity[],
	branchNodes: readonly TimelineBranchFocusNode[]
): string {
	const source =
		albums.find((album) => album.id === current.sourceId) ??
		branchNodes.find((node) => node.id === current.sourceId);
	if (source) {
		const towardSource = source.y < current.y ? 'up' : source.y > current.y ? 'down' : null;
		if (direction === towardSource) return source.id;
	}

	const children = branchNodes.filter((candidate) => candidate.sourceId === current.id);
	return nearestBranchNode(current, direction, children)?.id ?? current.id;
}

/**
 * Resolve one deterministic keyboard move without depending on mounted DOM.
 * Base-album Left/Right order stays chronological even when rendering is
 * clustered, while Up/Down is reserved for eligible branch nodes.
 */
export function timelineKeyboardTarget({
	albums,
	currentId,
	direction,
	branchNodes = []
}: TimelineKeyboardTargetOptions): string | null {
	const ordered = orderedTimelineAlbums(albums);
	if (direction === 'home') return ordered[0]?.id ?? null;
	if (direction === 'end') return ordered.at(-1)?.id ?? null;

	const currentBranch = branchNodes.find((node) => node.id === currentId);
	if (currentBranch) {
		if (direction === 'left' || direction === 'right') {
			const siblings = branchSiblings(currentBranch, branchNodes);
			const currentIndex = siblings.findIndex((node) => node.id === currentBranch.id);
			if (currentIndex < 0) return currentBranch.id;
			const nextIndex = direction === 'left'
				? Math.max(0, currentIndex - 1)
				: Math.min(siblings.length - 1, currentIndex + 1);
			return siblings[nextIndex]?.id ?? currentBranch.id;
		}
		return branchVerticalTarget(currentBranch, direction, ordered, branchNodes);
	}

	if (ordered.length === 0) return null;

	const currentIndex = ordered.findIndex((album) => album.id === currentId);
	if (currentIndex < 0) {
		return direction === 'left' ? (ordered.at(-1)?.id ?? null) : ordered[0].id;
	}
	const current = ordered[currentIndex];

	if (direction === 'left') {
		return ordered[Math.max(0, currentIndex - 1)].id;
	}
	if (direction === 'right') {
		return ordered[Math.min(ordered.length - 1, currentIndex + 1)].id;
	}
	return nearestBranchNode(current, direction, branchNodes)?.id ?? current.id;
}
