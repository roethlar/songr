/**
 * The desktop shell's bridge, as seen from the page.
 *
 * `desktop/src/preload.ts` exposes this on `window` only inside the Electron
 * shell. A plain browser tab has nothing here, which is exactly how the UI
 * decides whether to offer shell-only controls: presence of the function, not a
 * user-agent sniff or a build flag, so one bundle serves both.
 */
export interface DesktopShellBridge {
	readonly retryEngine?: () => void;
	/** Opens the shell's advanced settings window (network serving lives there). */
	readonly openAdvancedSettings?: () => void;
}

declare global {
	interface Window {
		roonControllerShell?: DesktopShellBridge;
	}
}

/**
 * The shell's "open advanced settings" command, or null when the page is not
 * running inside the desktop shell.
 *
 * Callers must treat null as "do not offer the control at all". The settings it
 * opens — chiefly `serveOnNetwork`, which is what makes the engine reachable
 * from anything but localhost — have no browser equivalent.
 */
export function openAdvancedSettings(): (() => void) | null {
	if (typeof window === 'undefined') return null;
	const open = window.roonControllerShell?.openAdvancedSettings;
	return typeof open === 'function' ? () => open() : null;
}
