/**
 * Deterministic monogram fallback for item artwork: a stable hue pair
 * hashed from the title plus the first letter of the first real word
 * (leading article stripped). Used wherever an item has no image key —
 * honest absence is a placeholder tile, never a broken image.
 */
export function monogram(title: string): { style: string; letter: string } {
	const word = title.replace(/^(the |a |an )/i, '').trim() || '?';
	let hash = 0;
	for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	return {
		style: `background:linear-gradient(150deg,hsl(${hash % 360},14%,20%),hsl(${(hash + 40) % 360},12%,11%))`,
		letter: (word[0] ?? '?').toUpperCase()
	};
}
