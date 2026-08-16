<script lang="ts">
	import AppSettingsMenu from '../AppSettingsMenu.svelte';
	import { openSettingsMenu, settingsMenuOpen } from '$lib/stores/settingsMenuStore';
</script>

<button
	type="button"
	aria-label="Open Controller settings"
	aria-haspopup="dialog"
	aria-controls="controller-settings-dialog"
	aria-expanded={$settingsMenuOpen}
	onclick={openSettingsMenu}
>Settings</button>

<AppSettingsMenu />
