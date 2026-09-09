import { buildQueries, queryAllByAttribute, screen } from '@testing-library/svelte';

/** DOM presence includes retained lists. These queries describe the active surface. */
export function activeLibraryElements(selector: string): HTMLElement[] {
 return [...document.querySelectorAll<HTMLElement>(selector)]
  .filter(node => !node.closest('[data-retained-library-panel][aria-hidden="true"]'));
}
const queryAll = (container: HTMLElement, id: string) =>
 queryAllByAttribute('data-testid', container, id)
  .filter(node => !node.closest('[data-retained-library-panel][aria-hidden="true"]'));
const [queryBy, getAll, getBy, findAll, findBy] = buildQueries(queryAll,
 (_container, id) => `Multiple active Library elements with test id ${id}`,
 (_container, id) => `No active Library element with test id ${id}`);
const textOptions = { ignore: 'script,style,[data-retained-library-panel][aria-hidden="true"],[data-retained-library-panel][aria-hidden="true"] *' };
export const activeLibraryScreen = {
 queryAllByTestId: (id: string) => queryAll(document.body, id),
 queryByTestId: (id: string) => queryBy(document.body, id),
 getAllByTestId: (id: string) => getAll(document.body, id),
 getByTestId: (id: string) => getBy(document.body, id),
 findAllByTestId: (id: string) => findAll(document.body, id),
 findByTestId: (id: string) => findBy(document.body, id),
 findByText: (...args: Parameters<typeof screen.findByText>) => screen.findByText(args[0], { ...textOptions, ...args[1] }, args[2]),
 getByText: (...args: Parameters<typeof screen.getByText>) => screen.getByText(args[0], { ...textOptions, ...args[1] }),
 getAllByText: (...args: Parameters<typeof screen.getAllByText>) => screen.getAllByText(args[0], { ...textOptions, ...args[1] }),
 queryByText: (...args: Parameters<typeof screen.queryByText>) => screen.queryByText(args[0], { ...textOptions, ...args[1] }),
 queryAllByText: (...args: Parameters<typeof screen.queryAllByText>) => screen.queryAllByText(args[0], { ...textOptions, ...args[1] })
};
