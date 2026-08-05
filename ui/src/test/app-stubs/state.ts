// Vite's directory alias resolves `$app/state` to this conventional extension.
// The implementation lives in a .svelte.ts module so its exported page object
// remains reactive when tests mutate shallow history.
export * from './state.svelte';
