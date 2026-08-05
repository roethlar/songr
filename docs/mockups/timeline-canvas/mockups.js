const validStates = new Set(['primary', 'settings', 'fallback', 'disconnected', 'keyboard']);
const stateLabels = {
	primary: 'Primary Timeline canvas mockup',
	settings: 'Timeline canvas with Controller settings open',
	fallback: 'Timeline canvas with Recently Played Open in Classic fallback',
	disconnected: 'Disconnected Timeline canvas with preserved context',
	keyboard: 'Timeline canvas keyboard focus and action menu'
};

const stage = document.querySelector('#mockup');
const reviewButtons = [...document.querySelectorAll('[data-review-state]')];
const roonActions = [...document.querySelectorAll('[data-roon-action]')];
const settingsPanel = document.querySelector('.settings-panel');
const libraryViewRadios = [...document.querySelectorAll('input[name="library-view"]')];
const classicViewRadio = libraryViewRadios.find((radio) => radio.value === 'classic');
const timelineViewRadio = libraryViewRadios.find((radio) => radio.value === 'timeline');

function resetSettingsPreview() {
	settingsPanel.classList.remove('is-requesting');
	timelineViewRadio.checked = true;
}

function setState(nextState, updateAddress = true) {
	const state = validStates.has(nextState) ? nextState : 'primary';
	resetSettingsPreview();
	document.body.dataset.state = state;
	stage.setAttribute('aria-label', stateLabels[state]);
	document.title = `${stateLabels[state]} · visual gate`;

	for (const button of reviewButtons) {
		button.setAttribute('aria-pressed', String(button.dataset.reviewState === state));
	}

	for (const action of roonActions) {
		action.disabled = state === 'disconnected';
	}

	if (updateAddress) {
		const url = new URL(window.location.href);
		url.searchParams.set('state', state);
		window.history.replaceState(null, '', url);
	}
}

for (const button of reviewButtons) {
	button.addEventListener('click', () => setState(button.dataset.reviewState));
}

document.querySelector('.settings-trigger').addEventListener('click', () => setState('settings'));
document.querySelector('.close-settings').addEventListener('click', () => setState('primary'));
document.querySelector('.cancel-fallback').addEventListener('click', () => setState('primary'));

classicViewRadio.addEventListener('change', () => {
	settingsPanel.classList.toggle('is-requesting', classicViewRadio.checked);
});

timelineViewRadio.addEventListener('change', () => {
	settingsPanel.classList.remove('is-requesting');
});

document.addEventListener('keydown', (event) => {
	if (event.target instanceof HTMLInputElement) return;
	const state = ['primary', 'settings', 'fallback', 'disconnected', 'keyboard'][Number(event.key) - 1];
	if (state) setState(state);
});

setState(new URL(window.location.href).searchParams.get('state'), false);
