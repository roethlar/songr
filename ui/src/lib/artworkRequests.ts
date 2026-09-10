/** Admission is shared across retained scopes and detail pages. A cancelled
 * interest removes queued work, but an active request keeps its slot until it
 * settles: closing a browser request does not cancel Roon's get_image callback.
 */
export type ArtworkResult = { ok: true } | { ok: false; retryable: boolean };
export interface ArtworkInterest {
	priority(value: number): void;
	dispose(): void;
}
interface Interest {
	priority: number;
	complete: (result: ArtworkResult) => void;
}
interface Request {
	url: string;
	interests: Set<Interest>;
	attempts: number;
	active: boolean;
	timer?: ReturnType<typeof setTimeout>;
}
interface RequestOptions {
	fetch?: typeof fetch;
	concurrency?: number;
	timeoutMs?: number;
	retryDelays?: readonly number[];
}

export function createArtworkRequests(options: RequestOptions = {}) {
	const concurrency = options.concurrency ?? 4;
	// ImageService normally answers within its 15-second timeout. Keep browser
	// requests alive through that response instead of abandoning them on scroll.
	const timeoutMs = options.timeoutMs ?? 20_000;
	const retryDelays = options.retryDelays ?? [500, 1500];
	const requests = new Map<string, Request>();
	let active = 0;
	let scheduled = false;

	function schedule(): void {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(pump);
	}
	function finish(request: Request, result: ArtworkResult): void {
		if (requests.get(request.url) === request) requests.delete(request.url);
		for (const interest of request.interests) interest.complete(result);
		request.interests.clear();
	}
	async function run(request: Request): Promise<void> {
		request.active = true;
		request.attempts++;
		active++;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		let result: ArtworkResult = { ok: false, retryable: true };
		let retryAfter = 0;
		try {
			const response = await (options.fetch ?? globalThis.fetch)(request.url, {
				signal: controller.signal, credentials: 'same-origin', cache: 'default'
			});
			// Finish the body before giving back the slot. On success the HTTP
			// cache owns these bytes; img.src then uses the original cacheable URL.
			await response.arrayBuffer();
			if (response.ok) result = { ok: true };
			else {
				result = { ok: false, retryable: [408, 429, 500, 502, 503, 504].includes(response.status) };
				const header = response.headers.get('Retry-After');
				if (header) {
					const seconds = Number(header);
					retryAfter = Math.max(0, Math.min(300_000, Number.isFinite(seconds)
						? seconds * 1000 : Date.parse(header) - Date.now())) || 0;
				}
			}
		} catch {
			// Connection errors and the bounded request timeout may recover.
		} finally {
			clearTimeout(timeout);
			request.active = false;
			active--;
		}
		if (!result.ok && result.retryable && request.interests.size) {
			// A brief outage gets two prompt retries. If Core stays unavailable,
			// recover without requiring navigation, at a bounded 30-second rate.
			// Disposing the last visible/near interest cancels this wait entirely.
			const delay = request.attempts <= retryDelays.length
				? retryDelays[request.attempts - 1] : 30_000;
			request.timer = setTimeout(() => {
				request.timer = undefined;
				schedule();
			}, Math.max(retryAfter, delay));
		} else finish(request, result);
		schedule();
	}
	function pump(): void {
		scheduled = false;
		while (active < concurrency) {
			let next: Request | undefined;
			let best = Infinity;
			for (const request of requests.values()) {
				if (request.active || request.timer || !request.interests.size) continue;
				for (const interest of request.interests) {
					if (interest.priority < best) {
						next = request;
						best = interest.priority;
					}
				}
			}
			if (!next) break;
			void run(next);
		}
	}
	return {
		request(url: string, priority: number, complete: (result: ArtworkResult) => void): ArtworkInterest {
			let request = requests.get(url);
			if (!request) {
				request = { url, interests: new Set(), attempts: 0, active: false };
				requests.set(url, request);
			}
			const interest = { priority, complete };
			request.interests.add(interest);
			schedule();
			return {
				priority(value) { interest.priority = value; schedule(); },
				dispose() {
					request.interests.delete(interest);
					if (!request.interests.size && !request.active) {
						clearTimeout(request.timer);
						if (requests.get(url) === request) requests.delete(url);
					}
				}
			};
		}
	};
}

export const artworkRequests = createArtworkRequests();
