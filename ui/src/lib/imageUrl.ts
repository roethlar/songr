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
