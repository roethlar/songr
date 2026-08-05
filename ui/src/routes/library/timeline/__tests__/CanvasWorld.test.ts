import { render } from '@testing-library/svelte';
import { CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT } from '@shared/timelineCatalogContracts';
import { describe, expect, it } from 'vitest';
import {
	createTimelineCanvasModel,
	TimelineRenderPlanner,
	type Camera,
	type ScreenViewport
} from '$lib/timeline';
import type { TimelineAlbumDetailViewModel } from '$lib/timeline/detailView';
import {
	createTimelineBranchLayout,
	createTimelineBranchRenderPlan
} from '$lib/timeline/branchModel';
import CanvasWorld from '../CanvasWorld.svelte';

const viewport: ScreenViewport = { x: 0, y: 0, width: 1_400, height: 900 };
const camera: Camera = { centerX: 80, centerY: 0, scale: 1.5 };

describe('CanvasWorld drag preview', () => {
	it('projects every dragged visual together without mutating the canvas model', async () => {
		const model = createTimelineCanvasModel([
			{
				localId: 'dragged',
				title: 'Dragged album',
				artist: 'Test artist',
				placement: {
					kind: 'calendar',
					ordinal: 0,
					year: 2000,
					evidence: {
						sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
						field: 'original-release-date',
						date: '2000'
					}
				}
			},
			{
				localId: 'settled',
				title: 'Settled album',
				artist: 'Test artist',
				placement: {
					kind: 'calendar',
					ordinal: 1,
					year: 2001,
					evidence: {
						sourceContract: CATALOG_RELEASE_EVIDENCE_SOURCE_CONTRACT,
						field: 'original-release-date',
						date: '2001'
					}
				}
			}
		]);
		const plan = new TimelineRenderPlanner(model).createPlan(camera, viewport);
		const branchLayout = createTimelineBranchLayout(model, []);
		const branchPlan = createTimelineBranchRenderPlan(
			branchLayout,
			camera,
			viewport,
			{ reservedWorldObjects: 1 }
		);
		const canonical = model.entityById.get('dragged')!;
		const canonicalPosition = { x: canonical.x, y: canonical.y };
		const detailView: TimelineAlbumDetailViewModel = {
			album: {
				localId: 'dragged',
				coreId: 'core-a',
				artistLocalId: 'artist-a',
				exactTitle: 'Dragged album',
				exactArtist: 'Test artist',
				normalizedTitle: 'dragged album',
				normalizedArtist: 'test artist',
				editionText: '',
				firstSeenAt: '2026-07-15T00:00:00.000Z',
				lastSeenAt: '2026-07-15T00:00:00.000Z',
				resolutionStatus: 'resolved'
			},
			detail: null,
			phase: 'loading',
			message: null
		};
		const baseProps = {
			model,
			plan,
			branchLayout,
			branchPlan,
			camera,
			viewport,
			detailView,
			activeAlbumId: 'dragged',
			albumActivationEnabled: true
		};
		const view = render(CanvasWorld, {
			props: {
				...baseProps,
				dragPreview: { albumLocalId: 'dragged', offset: { dx: 0, dy: 0 } }
			}
		});

		const dragged = view.container.querySelector<HTMLElement>('[data-album-id="dragged"]')!;
		const settled = view.container.querySelector<HTMLElement>('[data-album-id="settled"]')!;
		expect(dragged).toHaveClass('dragging');
		expect(settled).not.toHaveClass('dragging');
		expect(view.container.querySelector('[data-timeline-tether="dragged"]')).toBeInTheDocument();

		const offset = { dx: 137, dy: -91 };
		await view.rerender({
			...baseProps,
			dragPreview: { albumLocalId: 'dragged', offset }
		});

		const expectedX = canonical.anchorX + offset.dx;
		const expectedY = canonical.anchorY + offset.dy;
		const tether = view.container.querySelector('[data-timeline-tether="dragged"]')!;
		const detail = view.container.querySelector<HTMLElement>('[data-album-detail-id="dragged"]')!;
		expect(dragged).toHaveStyle({ left: `${expectedX}px`, top: `${expectedY}px` });
		expect(dragged).toHaveAttribute('data-manual-offset-x', String(offset.dx));
		expect(dragged).toHaveAttribute('data-manual-offset-y', String(offset.dy));
		expect(dragged).toHaveClass('floating', 'dragging');
		expect(tether).toHaveAttribute('x2', String(expectedX));
		expect(tether).toHaveAttribute('y2', String(expectedY));
		expect(detail).toHaveStyle({
			left: `${expectedX + canonical.width / 2 + 64}px`,
			top: `${expectedY}px`
		});
		expect({ x: canonical.x, y: canonical.y }).toEqual(canonicalPosition);
		expect(plan.objects.find((object) => object.id === 'dragged')).toMatchObject({
			entity: canonical
		});
	});
});
