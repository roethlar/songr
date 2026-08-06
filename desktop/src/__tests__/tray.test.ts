/**
 * The Electron glue in `tray.ts` decides nothing, but it does *wire* things —
 * and the advanced settings page has exactly one entry point in the whole app
 * (plan §1: buried, never in onboarding, nothing in the UI links to it). If
 * that menu item is missing or wired to the wrong callback, the settings are
 * unreachable and no other test notices.
 *
 * Electron is mocked here rather than launched: `Menu.buildFromTemplate` is the
 * seam, so capturing the template it is handed is enough to see the wiring.
 */

import type { TrayMenuState } from '../trayModel';

const buildFromTemplate = jest.fn((template: unknown) => ({ template }));
const setContextMenu = jest.fn();
const setToolTip = jest.fn();
const trayOn = jest.fn();
const trayDestroy = jest.fn();

jest.mock(
  'electron',
  () => ({
    Menu: { buildFromTemplate },
    Tray: jest.fn(() => ({
      on: trayOn,
      setContextMenu,
      setToolTip,
      destroy: trayDestroy,
    })),
    nativeImage: { createFromPath: () => ({ setTemplateImage: () => undefined }) },
  }),
  { virtual: true },
);

// Imported after the mock is registered, so the module under test binds to it.
/* eslint-disable @typescript-eslint/no-require-imports */
const { TrayController } = require('../tray') as typeof import('../tray');

const MENU_STATE: TrayMenuState = {
  tooltip: 'Nothing playing',
  targetZoneId: null,
  windowItem: { label: 'Show Window', enabled: true },
  playPause: { label: 'Play', enabled: false },
  next: { label: 'Next', enabled: false },
  previous: { label: 'Previous', enabled: false },
};

interface CapturedItem {
  label?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
}

function renderMenu(overrides: Partial<Record<string, () => void>> = {}): {
  items: CapturedItem[];
  calls: string[];
} {
  buildFromTemplate.mockClear();
  const calls: string[] = [];
  const record = (name: string) => () => calls.push(name);
  const controller = new TrayController({
    iconPath: '/app/resources/trayIconTemplate.png',
    onToggleWindow: record('toggle'),
    onPlayPause: record('playPause'),
    onNext: record('next'),
    onPrevious: record('previous'),
    onOpenSettings: overrides.onOpenSettings ?? record('settings'),
    onQuit: record('quit'),
  });
  controller.create();
  controller.render(MENU_STATE);
  return {
    items: buildFromTemplate.mock.calls[0]?.[0] as CapturedItem[],
    calls,
  };
}

describe('the tray menu', () => {
  it('offers the advanced settings page, the only way to reach it', () => {
    const { items } = renderMenu();
    const labels = items.map((item) => item.label ?? `(${String(item.type)})`);
    expect(labels).toContain('Advanced Settings…');
  });

  it('wires that item to the settings callback, not to some other one', () => {
    const { items, calls } = renderMenu();
    const settingsItem = items.find(
      (item) => item.label === 'Advanced Settings…',
    );
    settingsItem?.click?.();
    expect(calls).toEqual(['settings']);
  });

  it('keeps Quit last, so the destructive item is not adjacent to the transport', () => {
    const { items } = renderMenu();
    expect(items[items.length - 1]?.label).toBe('Quit');
  });
});
