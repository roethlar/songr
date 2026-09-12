import { derived, get, readable, writable, type Readable } from 'svelte/store';
import { buildApiRequestInit } from '@shared/apiRequest';
import {
  parsePresentationSettingsSnapshot, parsePresentationSettingsUpdate, resolvePresentationSettings,
  type PresentationChoices, type PresentationSettingsSnapshot
} from '@shared/presentationSettings';

export interface PresentationSettingsState {
  readonly snapshot: PresentationSettingsSnapshot | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly notice: string | null;
}
export interface PresentationSettingsStore extends Readable<PresentationSettingsState> {
  load(fetchFn?: typeof fetch): Promise<void>;
  applySnapshot(value: unknown): boolean;
  update(choices: Partial<PresentationChoices>, fetchFn?: typeof fetch): Promise<boolean>;
  reset(): void;
}
const ENDPOINT = '/api/settings/presentation';
const initialState = (): PresentationSettingsState => ({ snapshot: null, loading: false, saving: false, error: null, notice: null });
function responseError(body: unknown, fallback: string): string {
  return body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : fallback;
}
/** Only committed server snapshots affect presentation; never browser storage. */
export function createPresentationSettingsStore(): PresentationSettingsStore {
  let state = initialState();
  const internal = writable(state);
  let generation = 0, readSequence = 0, messageSequence = 0;
  function publish(update: Partial<PresentationSettingsState>): void { state = { ...state, ...update }; internal.set(state); }
  function applySnapshot(value: unknown): boolean {
    const snapshot = parsePresentationSettingsSnapshot(value);
    if (!snapshot || (state.snapshot !== null && snapshot.revision <= state.snapshot.revision)) return false;
    publish({ snapshot });
    return true;
  }
  async function load(fetchFn: typeof fetch = fetch): Promise<void> {
    const currentGeneration = generation, sequence = ++readSequence;
    const message = state.saving ? null : ++messageSequence;
    publish({ loading: true, ...(!state.saving ? { error: null, notice: null } : {}) });
    try {
      const response = await fetchFn(ENDPOINT, buildApiRequestInit({ cache: 'no-store' }));
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(body, 'The server could not load appearance settings.'));
      const snapshot = parsePresentationSettingsSnapshot(body);
      if (!snapshot) throw new Error('The server returned invalid appearance settings.');
      if (currentGeneration === generation) applySnapshot(snapshot);
    } catch (error) {
      if (currentGeneration === generation && sequence === readSequence && message === messageSequence)
        publish({ error: `Could not load appearance settings. ${error instanceof Error ? error.message : 'Try again.'}` });
    } finally {
      if (currentGeneration === generation && sequence === readSequence) publish({ loading: false });
    }
  }
  async function update(choices: Partial<PresentationChoices>, fetchFn: typeof fetch = fetch): Promise<boolean> {
    if (state.saving) return false;
    if (!state.snapshot) { publish({ error: 'Load appearance settings before changing them.' }); return false; }
    const current = state.snapshot;
    const input = parsePresentationSettingsUpdate({ expectedRevision: current.revision,
      actionDisplay: current.actionDisplay, smoothScroll: current.smoothScroll, interfaceMotion: current.interfaceMotion, ...choices });
    if (!input) { publish({ error: 'These appearance choices are invalid.', notice: null }); return false; }
    const changed = input.actionDisplay !== current.actionDisplay || input.smoothScroll !== current.smoothScroll || input.interfaceMotion !== current.interfaceMotion;
    const currentGeneration = generation, message = ++messageSequence;
    publish({ saving: true, error: null, notice: null });
    try {
      const response = await fetchFn(ENDPOINT, buildApiRequestInit({ method: 'PUT', body: JSON.stringify(input) }));
      const body: unknown = await response.json().catch(() => null);
      if (currentGeneration !== generation) return false;
      if (response.status === 409) {
        const latest = body !== null && typeof body === 'object' && 'current' in body ? parsePresentationSettingsSnapshot(body.current) : null;
        if (!latest) throw new Error('The server returned an invalid conflict response. Reload and try again.');
        applySnapshot(latest);
        publish({ notice: 'Settings changed on another client. The current choices are shown; your change was not saved. Try again.' });
        return false;
      }
      if (!response.ok) throw new Error(responseError(body, 'The server could not save these choices.'));
      const confirmed = parsePresentationSettingsSnapshot(body);
      if (!confirmed || confirmed.revision < input.expectedRevision + Number(changed) || confirmed.actionDisplay !== input.actionDisplay ||
          confirmed.smoothScroll !== input.smoothScroll || confirmed.interfaceMotion !== input.interfaceMotion)
        throw new Error('The server did not confirm these appearance settings.');
      applySnapshot(confirmed);
      return true;
    } catch (error) {
      if (currentGeneration === generation && message === messageSequence)
        publish({ error: `Appearance changes were not saved. ${error instanceof Error ? error.message : 'Try again.'}` });
      return false;
    } finally {
      if (currentGeneration === generation) publish({ saving: false });
    }
  }
  function reset(): void {
    generation += 1; readSequence += 1; messageSequence += 1;
    state = initialState(); internal.set(state);
  }
  return { subscribe: internal.subscribe, load, applySnapshot, update, reset };
}
export const presentationSettingsStore = createPresentationSettingsStore();
export const loadPresentationSettings = (fetchFn: typeof fetch): Promise<void> => presentationSettingsStore.load(fetchFn);
export const applyPresentationSettings = (value: unknown): boolean => presentationSettingsStore.applySnapshot(value);

export const osReducedMotionStore = readable(false, set => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const update = () => set(query.matches);
  update();
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
});
export const effectivePresentationStore = derived(
  [presentationSettingsStore, osReducedMotionStore],
  ([$settings, $reducedMotion]) => resolvePresentationSettings($settings.snapshot, $reducedMotion)
);
export function getEffectiveMotion(): Pick<PresentationChoices, 'smoothScroll' | 'interfaceMotion'> {
  const { smoothScroll, interfaceMotion } = get(effectivePresentationStore);
  return { smoothScroll, interfaceMotion };
}
/** One binding covers overlays and dialogs as well as the library page. */
export function bindDocumentPresentation(root: HTMLElement): () => void {
  return effectivePresentationStore.subscribe(settings => {
    root.dataset.actionDisplay = settings.actionDisplay;
    root.dataset.smoothScroll = settings.smoothScroll ? 'on' : 'off';
    root.dataset.interfaceMotion = settings.interfaceMotion ? 'on' : 'off';
  });
}
