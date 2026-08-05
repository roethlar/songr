/**
 * Reflect native `inert` as an actual boolean attribute as well as a DOM
 * property. The explicit attribute keeps the accessibility boundary visible
 * to tests and older DOM implementations whose inert property does not
 * reflect automatically.
 */
export function inertSubtree(
	node: HTMLElement,
	enabled: boolean
): { update(next: boolean): void; destroy(): void } {
	const apply = (next: boolean) => {
		node.toggleAttribute('inert', next);
		if ('inert' in node) node.inert = next;
	};
	apply(enabled);
	return {
		update: apply,
		destroy() {
			apply(false);
		}
	};
}
