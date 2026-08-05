import '@testing-library/jest-dom/vitest';

class ResizeObserverStub implements ResizeObserver {
	disconnect(): void {}
	observe(): void {}
	unobserve(): void {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
	configurable: true,
	writable: true,
	value: ResizeObserverStub
});
