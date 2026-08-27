/**
 * Build a `/api/image/<key>?scale=fit&width=W&height=H` URL with the
 * key safely encoded as a path segment. Roon's `image_key` is opaque
 * and may legally contain `/`, `?`, `#`, `%` — interpolating it raw
 * would break routing or change which image is fetched. Use this
 * helper at every call site instead of templating the URL inline.
 *
 * Pass 0 / undefined for `width` or `height` to omit the scale params
 * entirely (server returns the original).
 */
export interface ImageUrlOptions {
	width?: number;
	height?: number;
	scale?: 'fit' | 'fill' | 'stretch';
}

export function imageUrl(
	key: string | undefined,
	{ width, height, scale = 'fit' }: ImageUrlOptions = {}
): string {
	if (!key) return '';
	const path = `/api/image/${encodeURIComponent(key)}`;
	const params = new URLSearchParams();
	if (width && height) {
		params.set('scale', scale);
		params.set('width', String(width));
		params.set('height', String(height));
	}
	const qs = params.toString();
	return qs ? `${path}?${qs}` : path;
}

/**
 * Build a `/api/artist-portrait/wide/<key>` URL for an artist's wide
 * photograph. A different picture, from a different place, than the one
 * `imageUrl` serves: these keys are not artwork keys, they do not resolve
 * against `/api/image`, and the two are never interchangeable.
 *
 * The shape is a path segment the server owns rather than a parameter a
 * caller supplies, so this URL can only ever ask for the wide picture.
 * Width is left to the server, which serves the largest it holds.
 *
 * A build without the extended library features still answers this path —
 * with an honest "not part of this build" — so a caller never has to ask
 * whether the route exists, only what it said.
 */
export function wideArtistPortraitUrl(key: string | undefined): string {
	if (!key) return '';
	return `/api/artist-portrait/wide/${encodeURIComponent(key)}`;
}
