import { afterEach, expect, it, vi } from 'vitest';
import { prepareRetainedLibraryPanel } from '../retainedLibraryPanel';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('prepares changed data under a retained parent, but not unchanged confirmations', () => {
 const parent = document.createElement('div'); parent.dataset.retainedLibraryPanel = '';
 parent.style.contentVisibility = 'hidden';
 const panel = document.createElement('div'); panel.dataset.retainedLibraryPanel = '';
 panel.setAttribute('aria-hidden', 'true');
 const content = document.createElement('div'); panel.append(content); parent.append(panel); document.body.append(parent);
 const layout = vi.spyOn(content, 'scrollHeight', 'get').mockImplementation(() => {
  expect(parent.style.contentVisibility).toBe('visible');
  expect(panel.style.contentVisibility).toBe('visible');
  return 100000;
 });
 const rows = [{ title: 'First' }];
 const action = prepareRetainedLibraryPanel(panel, [rows, 'normal']);
 expect(layout).toHaveBeenCalledOnce();
 expect(parent.style.contentVisibility).toBe('hidden');
 expect(panel.style.contentVisibility).toBe('');
 action.update([rows, 'normal']);
 expect(layout).toHaveBeenCalledOnce();
 action.update([[{ title: 'Replacement' }], 'normal']);
 expect(layout).toHaveBeenCalledTimes(2);
 action.destroy();
 action.update([[], 'compact']);
 expect(layout).toHaveBeenCalledTimes(2);
});
