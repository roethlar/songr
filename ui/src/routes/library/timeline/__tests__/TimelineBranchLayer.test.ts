import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import TimelineBranchLayer from '../TimelineBranchLayer.svelte';

function node(index: number, overrides: Record<string, unknown> = {}) {
	return {
		id: `branch-1::album-${index}`,
		albumLocalId: `album-${index}`,
		title: `Album ${index}`,
		artistName: 'Thom Yorke',
		chronologyLabel: index === 1 ? '2006' : 'Undated',
		x: 300 + index * 150,
		y: -220,
		width: 180,
		height: 88,
		imageKeyHint: `image-${index}`,
		artworkAllowed: index === 1,
		activationEnabled: true,
		...overrides
	};
}

function branch(index = 1, overrides: Record<string, unknown> = {}) {
	return {
		branchId: `branch-${index}`,
		artistName: index === 1 ? 'Thom Yorke' : `Artist ${index}`,
		depth: 1 as const,
		sourceX: 120,
		sourceY: 0,
		headerX: 260,
		headerY: -340 - index * 20,
		status: 'ready' as const,
		candidateCount: 10,
		nodes: Array.from({ length: 10 }, (_, nodeIndex) =>
			node(nodeIndex + 1, {
				id: `branch-${index}::album-${nodeIndex + 1}`,
				y: -220 - index * 20
			})
		),
		...overrides
	};
}

describe('TimelineBranchLayer', () => {
	it('renders only the bounded visible working set with honest provenance and exact instrumentation', () => {
		const view = render(TimelineBranchLayer, {
			props: {
				branches: [branch(1), branch(2), branch(3), branch(4)]
			}
		});

		expect(view.container.querySelectorAll('[data-timeline-branch-id]')).toHaveLength(3);
		expect(view.container.querySelectorAll('[data-timeline-node-id]')).toHaveLength(24);
		expect(view.container.querySelectorAll('[data-world-object]')).toHaveLength(30);
		expect(view.container.querySelectorAll('[data-timeline-artwork]')).toHaveLength(3);
		expect(screen.getByText('Artist search · Thom Yorke')).toBeInTheDocument();
		expect(screen.getAllByText('User-attached branch')).toHaveLength(3);
		expect(screen.getAllByText('8 of 10 shown')).toHaveLength(3);
		expect(view.container).not.toHaveTextContent(/Similar|Recommended/i);
	});

	it('keeps connectors inert and routes node interaction through composite IDs', async () => {
		const onNodeActivate = vi.fn();
		const onNodeFocus = vi.fn();
		const onNodeKeydown = vi.fn();
		const onNodeActions = vi.fn();
		const escapedPointerDown = vi.fn();
		window.addEventListener('pointerdown', escapedPointerDown);
		const view = render(TimelineBranchLayer, {
			props: {
				branches: [branch(1, { nodes: [node(1)] })],
				activeNodeId: 'branch-1::album-1',
				onNodeActivate,
				onNodeFocus,
				onNodeKeydown,
				onNodeActions
			}
		});

		const connector = view.container.querySelector('[data-timeline-branch-connector="branch-1"]');
		expect(connector).not.toBeNull();
		expect(connector?.closest('svg')).toHaveAttribute('aria-hidden', 'true');
		expect(connector).not.toHaveAttribute('tabindex');

		const marker = screen.getByRole('button', { name: /Album 1, 2006/ });
		expect(marker).toHaveAttribute('data-timeline-node-id', 'branch-1::album-1');
		expect(marker).not.toHaveAttribute('data-album-id');
		expect(marker).toHaveAttribute('tabindex', '0');
		await fireEvent.pointerDown(marker);
		expect(escapedPointerDown).not.toHaveBeenCalled();
		await fireEvent.focus(marker);
		await fireEvent.keyDown(marker, { key: 'ArrowRight' });
		await fireEvent.contextMenu(marker);
		await fireEvent.click(marker);

		expect(onNodeFocus).toHaveBeenCalledWith('branch-1::album-1');
		expect(onNodeKeydown).toHaveBeenCalledWith('branch-1::album-1', expect.any(KeyboardEvent));
		expect(onNodeActions).toHaveBeenCalledWith('branch-1::album-1', marker);
		expect(onNodeActivate).toHaveBeenCalledWith('branch-1::album-1');
		window.removeEventListener('pointerdown', escapedPointerDown);
	});

	it('does not mount a connector when culling marks only the pinned branch node visible', () => {
		const view = render(TimelineBranchLayer, {
			props: {
				branches: [branch(1, { connectorVisible: false, nodes: [node(1)] })]
			}
		});

		expect(view.container.querySelector('[data-timeline-branch-connector]')).toBeNull();
		expect(view.container.querySelector('[data-timeline-node-id]')).not.toBeNull();
	});

	it('keeps branch-local failure authority limited to Retry and Close', async () => {
		const onRetry = vi.fn();
		const onClose = vi.fn();
		render(TimelineBranchLayer, {
			props: {
				branches: [
					branch(1, {
						status: 'error',
						message: 'Artist albums could not be loaded.',
						nodes: []
					})
				],
				onRetry,
				onClose
			}
		});

		const header = screen.getByRole('group', { name: 'Artist branch for Thom Yorke' });
		expect(within(header).getByRole('alert')).toHaveTextContent(
			'Artist albums could not be loaded.'
		);
		expect(within(header).getAllByRole('button')).toHaveLength(2);
		await fireEvent.click(within(header).getByRole('button', { name: 'Retry artist branch' }));
		await fireEvent.click(within(header).getByRole('button', { name: 'Close artist branch' }));
		expect(onRetry).toHaveBeenCalledWith('branch-1');
		expect(onClose).toHaveBeenCalledWith('branch-1');
	});

	it('uses modeled header bounds and disables only dead offline Retry authority', () => {
		render(TimelineBranchLayer, {
			props: {
				branches: [branch(1, {
					status: 'error',
					message: 'A deliberately long catalog failure remains inside the modeled branch header.',
					headerHeight: 132,
					retryEnabled: false,
					nodes: []
				})],
				onRetry: vi.fn(),
				onClose: vi.fn()
			}
		});

		const header = screen.getByRole('group', { name: 'Artist branch for Thom Yorke' });
		expect(header).toHaveStyle({ height: '132px' });
		expect(within(header).getByRole('button', { name: 'Retry artist branch' })).toBeDisabled();
		expect(within(header).getByRole('button', { name: 'Close artist branch' })).toBeEnabled();
	});
});
