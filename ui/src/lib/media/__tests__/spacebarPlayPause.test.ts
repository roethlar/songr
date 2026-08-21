import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeSocket } from '../../../test/fixtures/socket';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { clearCommandFeedback } from '$lib/stores/commandFeedbackStore';
import { startSpacebarPlayPause } from '../spacebarPlayPause';

const socket = createFakeSocket();

vi.mock('$lib/socket/client', () => ({
	getSocket: () => socket
}));

let stop: (() => void) | null = null;

/**
 * Dispatch a keydown that bubbles from `from` (default: the body) up to the
 * window listener, so the handler sees the real event target the way it would
 * in the browser.
 */
function pressSpace(
	from: Element = document.body,
	init: KeyboardEventInit = {}
): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {
		key: ' ',
		bubbles: true,
		cancelable: true,
		...init
	});
	from.dispatchEvent(event);
	return event;
}

function mount<T extends HTMLElement>(element: T): T {
	document.body.appendChild(element);
	return element;
}

function playPauseCalls(): unknown[][] {
	return socket.emit.mock.calls
		.filter((call) => call[0] === 'transport:play-pause')
		.map((call) => [call[0], call[1]]);
}

describe('startSpacebarPlayPause', () => {
	beforeEach(() => {
		socket.connected = true;
		socket.emit.mockReset();
		clearCommandFeedback();
		document.body.innerHTML = '';
		setSelectedZone('zone-1');
		stop = startSpacebarPlayPause();
	});

	afterEach(() => {
		stop?.();
		stop = null;
		setSelectedZone('');
	});

	it('toggles the selected zone down the same command as the transport button', () => {
		const event = pressSpace();

		expect(playPauseCalls()).toEqual([['transport:play-pause', { zone_id: 'zone-1' }]]);
		expect(event.defaultPrevented).toBe(true);
	});

	it('acts on the zone selected at press time, not the one at start time', () => {
		setSelectedZone('zone-2');

		pressSpace();

		expect(playPauseCalls()).toEqual([['transport:play-pause', { zone_id: 'zone-2' }]]);
	});

	it('ignores keys other than Space', () => {
		const event = pressSpace(document.body, { key: 'k' });

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it.each([
		['input', () => mount(document.createElement('input'))],
		['textarea', () => mount(document.createElement('textarea'))],
		['select', () => mount(document.createElement('select'))]
	])('ignores Space typed into a %s, and leaves the key alone', (_label, create) => {
		const field = create();

		const event = pressSpace(field);

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('ignores Space typed into a contenteditable surface', () => {
		const editable = mount(document.createElement('div'));
		editable.setAttribute('contenteditable', 'true');
		const caret = document.createElement('span');
		editable.appendChild(caret);

		// From a node inside the editable region, as a real caret press would be.
		const event = pressSpace(caret);

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('leaves Space to a focused control that already activates on it', () => {
		const button = mount(document.createElement('button'));

		const event = pressSpace(button);

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('stays out of the way while a modal or menu is open', () => {
		const dialog = mount(document.createElement('div'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');

		const event = pressSpace();

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);

		dialog.remove();
		pressSpace();
		expect(playPauseCalls()).toHaveLength(1);
	});

	it('ignores auto-repeat from a held Space', () => {
		pressSpace(document.body, { repeat: true });

		expect(socket.emit).not.toHaveBeenCalled();
	});

	it('ignores a press something nearer the user already handled', () => {
		const host = mount(document.createElement('div'));
		host.addEventListener('keydown', (event) => event.preventDefault());

		pressSpace(host);

		expect(socket.emit).not.toHaveBeenCalled();
	});

	it.each([
		['ctrlKey' as const],
		['metaKey' as const],
		['altKey' as const],
		['shiftKey' as const]
	])('ignores Space held with %s', (modifier) => {
		const event = pressSpace(document.body, { [modifier]: true });

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('does nothing, and takes no key, when no zone is selected', () => {
		setSelectedZone('');

		const event = pressSpace();

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('stops listening after teardown', () => {
		stop?.();
		stop = null;

		const event = pressSpace();

		expect(socket.emit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});
});
