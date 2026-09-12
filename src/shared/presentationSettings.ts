/** Shared appearance choices for every client connected to one Songr server. */
export type ActionDisplay = "icons" | "text" | "both";
export const PRESENTATION_SETTINGS_EVENT = "presentation-settings-updated" as const;
export interface PresentationChoices {
  readonly actionDisplay: ActionDisplay;
  readonly smoothScroll: boolean;
  readonly interfaceMotion: boolean;
}
export interface PresentationSettingsSnapshot extends PresentationChoices {
  readonly version: 1;
  readonly revision: number;
}
export interface PresentationSettingsUpdate extends PresentationChoices {
  readonly expectedRevision: number;
}
export const DEFAULT_PRESENTATION_SETTINGS: PresentationSettingsSnapshot = Object.freeze({
  version: 1, revision: 0, actionDisplay: "icons", smoothScroll: true, interfaceMotion: true,
});
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function choices(value: Record<string, unknown>): PresentationChoices | null {
  if ((value.actionDisplay !== "icons" && value.actionDisplay !== "text" && value.actionDisplay !== "both") ||
      typeof value.smoothScroll !== "boolean" || typeof value.interfaceMotion !== "boolean") return null;
  return { actionDisplay: value.actionDisplay, smoothScroll: value.smoothScroll, interfaceMotion: value.interfaceMotion };
}
export function parsePresentationSettingsSnapshot(value: unknown): PresentationSettingsSnapshot | null {
  if (!isRecord(value) || !hasKeys(value, ["version", "revision", "actionDisplay", "smoothScroll", "interfaceMotion"]) ||
      value.version !== 1 || !revision(value.revision)) return null;
  const parsed = choices(value);
  return parsed ? { version: 1, revision: value.revision, ...parsed } : null;
}
export function parsePresentationSettingsUpdate(value: unknown): PresentationSettingsUpdate | null {
  if (!isRecord(value) || !hasKeys(value, ["expectedRevision", "actionDisplay", "smoothScroll", "interfaceMotion"]) ||
      !revision(value.expectedRevision)) return null;
  const parsed = choices(value);
  return parsed ? { expectedRevision: value.expectedRevision, ...parsed } : null;
}
/** Device accessibility overrides never change the shared saved values. */
export function resolvePresentationSettings(snapshot: PresentationSettingsSnapshot | null, reducedMotion: boolean): PresentationChoices {
  return {
    actionDisplay: snapshot?.actionDisplay ?? "icons",
    smoothScroll: snapshot !== null && snapshot.smoothScroll && !reducedMotion,
    interfaceMotion: snapshot !== null && snapshot.interfaceMotion && !reducedMotion,
  };
}
