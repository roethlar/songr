/**
 * Shared open/closed state for the Controller settings dialog.
 *
 * The dialog itself (AppSettingsMenu) is mounted once at the layout level,
 * while the trigger that opens it lives in the Unified Library bar. The store
 * is the seam between those component trees. The neutral shell deliberately
 * has no trigger.
 */
import { writable } from 'svelte/store';

export const settingsMenuOpen = writable(false);

export function openSettingsMenu(): void {
	settingsMenuOpen.set(true);
}

export function closeSettingsMenu(): void {
	settingsMenuOpen.set(false);
}
