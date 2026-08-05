export {};

declare global {
	interface Window {
		__timelineHarness?: {
			runTrace(): Promise<unknown>;
			resetTwentyTimes(): Promise<unknown>;
			getMetrics(): unknown;
		};
	}
}
