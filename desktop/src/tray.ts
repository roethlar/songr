/**
 * The Electron half of the tray: build a `Tray`, and rebuild its menu from a
 * `TrayMenuState`. Every decision about labels, enablement and tooltip text
 * was already made in `trayModel.ts`; nothing here decides anything.
 *
 * Platform notes:
 *   - macOS renders this in the menu bar. The icon file is named
 *     `...Template.png`, which is what makes macOS treat it as a template
 *     image and invert it for light and dark menu bars.
 *   - Linux tray tooltips are not shown by the AppIndicator implementations
 *     Electron uses, so the now-playing text is macOS/Windows only for now.
 *   - Windows convention is that a left-click on the icon shows the window
 *     while a right-click opens the menu; that click is wired here.
 */

import { Menu, Tray, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import type { TrayMenuState } from './trayModel';

export interface TrayControllerOptions {
  /** Absolute path to the 16px template PNG (the @2x file sits beside it). */
  readonly iconPath: string;
  readonly onToggleWindow: () => void;
  readonly onPlayPause: () => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  /**
   * The advanced settings page. Deliberately reachable only from here: the
   * owner's ruling is that these options stay buried and out of onboarding
   * (plan §1), so nothing in the app's own UI links to them.
   */
  readonly onOpenSettings: () => void;
  readonly onQuit: () => void;
}

export class TrayController {
  readonly #options: TrayControllerOptions;
  #tray: Tray | null = null;

  constructor(options: TrayControllerOptions) {
    this.#options = options;
  }

  /** Create the tray icon. Safe to call once the app is ready. */
  create(): void {
    if (this.#tray !== null) {
      return;
    }
    const icon = nativeImage.createFromPath(this.#options.iconPath);
    icon.setTemplateImage(true);
    this.#tray = new Tray(icon);

    if (process.platform === 'win32') {
      this.#tray.on('click', () => {
        this.#options.onToggleWindow();
      });
    }
  }

  /** Rebuild the menu and tooltip. A no-op before `create()`. */
  render(state: TrayMenuState): void {
    const tray = this.#tray;
    if (tray === null) {
      return;
    }

    const template: MenuItemConstructorOptions[] = [
      {
        label: state.windowItem.label,
        click: () => {
          this.#options.onToggleWindow();
        },
      },
      { type: 'separator' },
      {
        label: state.playPause.label,
        enabled: state.playPause.enabled,
        click: () => {
          this.#options.onPlayPause();
        },
      },
      {
        label: state.next.label,
        enabled: state.next.enabled,
        click: () => {
          this.#options.onNext();
        },
      },
      {
        label: state.previous.label,
        enabled: state.previous.enabled,
        click: () => {
          this.#options.onPrevious();
        },
      },
      { type: 'separator' },
      {
        label: 'Advanced Settings…',
        click: () => {
          this.#options.onOpenSettings();
        },
      },
      {
        label: 'Quit',
        click: () => {
          this.#options.onQuit();
        },
      },
    ];

    // Electron menus are immutable once built, so a state change means a new
    // menu — which is why every label and flag arrives together in one object.
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(state.tooltip);
  }

  destroy(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }
}
