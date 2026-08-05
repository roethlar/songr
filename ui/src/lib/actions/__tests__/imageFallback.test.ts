import { describe, it, expect } from 'vitest';
import { hideOnError } from '../imageFallback';

function makeImg(): HTMLImageElement {
	const img = document.createElement('img');
	img.src = 'http://localhost/api/image/some-key';
	document.body.appendChild(img);
	return img;
}

describe('hideOnError', () => {
	it('hides the image when its source fails to load', () => {
		const img = makeImg();
		hideOnError(img);

		img.dispatchEvent(new Event('error'));

		expect(img.style.visibility).toBe('hidden');
	});

	it('restores visibility when a later source loads successfully', () => {
		const img = makeImg();
		hideOnError(img);

		img.dispatchEvent(new Event('error'));
		expect(img.style.visibility).toBe('hidden');

		img.src = 'http://localhost/api/image/other-key';
		img.dispatchEvent(new Event('load'));
		expect(img.style.visibility).toBe('');
	});

	it('stops listening after destroy', () => {
		const img = makeImg();
		const action = hideOnError(img);
		action.destroy();

		img.dispatchEvent(new Event('error'));
		expect(img.style.visibility).toBe('');
	});
});
