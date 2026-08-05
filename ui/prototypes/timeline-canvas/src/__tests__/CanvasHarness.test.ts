import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.svelte';
import CanvasHarness from '../CanvasHarness.svelte';

afterEach(() => cleanup());

function renderHarness() {
	return render(CanvasHarness, {
		props: {
			scenario: 'primary',
			catalogSize: 'medium',
			command: null,
			onExportSummary: () => {}
		}
	});
}

describe('synthetic Timeline canvas shell', () => {
	it('keeps the permanent isolation banner outside an exact product frame', () => {
		render(App);

		expect(screen.getByText('SYNTHETIC PROTOTYPE — NO ROON CONNECTION')).toBeInTheDocument();
		expect(screen.getByRole('application', { name: 'Synthetic draggable Timeline canvas' })).toHaveAttribute(
			'data-product-frame',
			'1400x900'
		);
		expect(screen.getByLabelText('Prototype metrics and hard caps')).toHaveTextContent('72');
		expect(screen.getByLabelText('Prototype metrics and hard caps')).toHaveTextContent('40');
		expect(window.__timelineHarness).toBeDefined();
		expect(window.__timelineHarness?.getMetrics()).toMatchObject({
			schema: 'roon-controller.timeline-runtime-prototype',
			schemaVersion: 1,
			synthetic: true,
			roonConnection: false
		});
	});

	it('switches to the honest Undated review scenario without losing the canvas', async () => {
		render(App);

		await fireEvent.click(screen.getByRole('button', { name: 'Undated' }));

		expect(screen.getByText('Undated tail')).toBeInTheDocument();
		expect(screen.getByText(/UNDATED · MEDIUM FIXTURE/)).toBeInTheDocument();
		expect(screen.getByRole('application', { name: 'Synthetic draggable Timeline canvas' })).toBeInTheDocument();
	});

	it('pages the equivalent list at no more than forty mounted rows and inerts the world', async () => {
		renderHarness();
		const world = document.querySelector<HTMLElement>('.world-viewport');
		expect(world).not.toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: /Browse active set as list/ }));

		const dialog = screen.getByRole('dialog', { name: 'Browse active set as list' });
		expect(within(dialog).getAllByRole('listitem').length).toBeLessThanOrEqual(40);
		expect((world as HTMLElement & { inert: boolean }).inert).toBe(true);
		expect(world).toHaveAttribute('aria-hidden', 'true');

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog', { name: 'Browse active set as list' })).not.toBeInTheDocument();
	});

	it('opens an inert local chooser and records sent false', async () => {
		renderHarness();

		await fireEvent.click(screen.getByRole('button', { name: 'Open inert action chooser for Reading Room' }));
		const chooser = screen.getByRole('dialog', { name: /Reading Room/ });
		expect(chooser).toHaveTextContent('Prototype only — no command sent');
		expect(within(chooser).getByRole('button', { name: /Play Now/ })).toHaveFocus();

		await fireEvent.click(within(chooser).getByRole('button', { name: /Play Now/ }));
		expect(screen.queryByRole('dialog', { name: /Reading Room/ })).not.toBeInTheDocument();
		expect(screen.getByText(/sent: false/)).toBeInTheDocument();
	});

	it('uses the visible fixed-screen zone rect for drag hit testing and rolls the album back', async () => {
		renderHarness();
		const frame = screen.getByRole('application', { name: 'Synthetic draggable Timeline canvas' });
		const viewport = document.querySelector<HTMLElement>('.world-viewport');
		const album = screen.getAllByRole('button', { name: /original release|Undated/ })[0];
		const marker = album.closest<HTMLElement>('[data-world-object]');
		const zone = screen.getByRole('button', { name: 'Open inert action chooser for Reading Room' });
		expect(viewport).not.toBeNull();
		expect(marker).not.toBeNull();
		expect(zone).toHaveStyle({ left: '20px', top: '42px', width: '148px', height: '64px' });
		vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
			x: 100,
			y: 50,
			left: 100,
			top: 50,
			right: 1500,
			bottom: 950,
			width: 1400,
			height: 900,
			toJSON: () => ({})
		});
		vi.spyOn(zone, 'getBoundingClientRect').mockReturnValue({
			x: 1000,
			y: 400,
			left: 1000,
			top: 400,
			right: 1148,
			bottom: 464,
			width: 148,
			height: 64,
			toJSON: () => ({})
		});
		const originalLeft = marker?.style.left;
		const originalTop = marker?.style.top;

		await fireEvent.pointerDown(album, { pointerId: 7, button: 0, clientX: 500, clientY: 420 });
		await fireEvent.pointerMove(viewport!, { pointerId: 7, clientX: 1010, clientY: 410 });
		await fireEvent.pointerUp(viewport!, { pointerId: 7, clientX: 1010, clientY: 410 });

		expect(screen.getByRole('dialog', { name: /Reading Room/ })).toBeInTheDocument();
		expect(marker?.style.left).toBe(originalLeft);
		expect(marker?.style.top).toBe(originalTop);
	});

	it('updates the rendered world transform while the field is panned', async () => {
		renderHarness();
		const viewport = document.querySelector<HTMLElement>('.world-viewport');
		const world = document.querySelector<HTMLElement>('.world-layer');
		expect(viewport).not.toBeNull();
		expect(world).not.toBeNull();
		const before = world?.style.transform;

		await fireEvent.pointerDown(viewport!, { pointerId: 11, button: 0, clientX: 600, clientY: 620 });
		await fireEvent.pointerMove(viewport!, { pointerId: 11, buttons: 1, clientX: 680, clientY: 655 });
		await fireEvent.pointerUp(viewport!, { pointerId: 11, clientX: 680, clientY: 655 });

		expect(world?.style.transform).not.toBe(before);
	});

	it('keeps a dragged album visually attached across successive pointer moves', async () => {
		renderHarness();
		const viewport = document.querySelector<HTMLElement>('.world-viewport');
		const album = screen.getAllByRole('button', { name: /original release|Undated/ })[0];
		const marker = album.closest<HTMLElement>('[data-world-object]');
		expect(viewport).not.toBeNull();
		expect(marker).not.toBeNull();

		await fireEvent.pointerDown(album, { pointerId: 12, button: 0, clientX: 500, clientY: 420 });
		await fireEvent.pointerMove(viewport!, { pointerId: 12, buttons: 1, clientX: 570, clientY: 460 });
		const firstMove = marker?.getAttribute('style');
		await fireEvent.pointerMove(viewport!, { pointerId: 12, buttons: 1, clientX: 760, clientY: 560 });

		expect(marker?.getAttribute('style')).not.toBe(firstMove);
	});

	it('does not turn detail-control pointerdown into a canvas pan gesture', async () => {
		renderHarness();
		const viewport = document.querySelector<HTMLElement>('.world-viewport');
		const actionButton = screen.getByRole('button', { name: 'Album actions' });
		expect(viewport).not.toBeNull();

		await fireEvent.pointerDown(actionButton, { pointerId: 13, button: 0, clientX: 900, clientY: 500 });

		expect(viewport).not.toHaveClass('panning');
	});

	it('offers keyboard-equivalent album actions with Shift+F10', async () => {
		renderHarness();
		const album = screen.getAllByRole('button', { name: /original release|Undated/ })[0];

		album.focus();
		await fireEvent.keyDown(album, { key: 'F10', shiftKey: true });

		const menu = screen.getByRole('menu', { name: /actions/ });
		const items = within(menu).getAllByRole('menuitem');
		expect(items[0]).toHaveFocus();
		await fireEvent.keyDown(menu, { key: 'ArrowDown' });
		expect(items[1]).toHaveFocus();
		expect(screen.getByRole('menuitem', { name: /Float from timeline/ })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: /Return to timeline/ })).toBeInTheDocument();
	});
});
