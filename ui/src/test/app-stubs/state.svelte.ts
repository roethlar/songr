function clonePageState(state: App.PageState): App.PageState {
	if (typeof structuredClone === 'function') {
		try {
			return structuredClone(state);
		} catch {
			// Svelte's deep state proxy is intentionally not structured-cloneable.
		}
	}
	return JSON.parse(JSON.stringify(state)) as App.PageState;
}

export const page = $state({
	url: new URL('http://localhost/'),
	params: {},
	route: { id: null as string | null },
	status: 200,
	error: null,
	data: {},
	state: {} as App.PageState,
	form: null
});

export function __setTestPage(url: string | URL, state: App.PageState): void {
	page.url = new URL(url, page.url);
	page.state = clonePageState(state);
}

export function __resetTestPage(
	url: string | URL = 'http://localhost/',
	state: App.PageState = {}
): void {
	page.url = new URL(url, 'http://localhost/');
	page.params = {};
	page.route = { id: null };
	page.status = 200;
	page.error = null;
	page.data = {};
	page.state = clonePageState(state);
	page.form = null;
}
