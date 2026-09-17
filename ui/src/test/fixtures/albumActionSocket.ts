import type { AlbumActionSocket } from '$lib/library/AlbumActionController';

interface Emission {
	readonly event: string;
	readonly value: unknown;
	readonly timeoutMs: number;
	readonly ack: (value: unknown) => void;
	readonly expire: () => void;
	readonly isPending: () => boolean;
}

export class FakeSocket implements AlbumActionSocket {
	connected = true;
	readonly emissions: Emission[] = [];
	readonly ackTimeouts: number[] = [];
	onEmission: ((emission: Emission) => void) | null = null;
	readonly #handlers = new Map<string, Set<(value: unknown) => void>>();

	on(event: string, handler: (value: unknown) => void): this {
		const handlers = this.#handlers.get(event) ?? new Set();
		handlers.add(handler);
		this.#handlers.set(event, handlers);
		return this;
	}

	off(event: string, handler: (value: unknown) => void): this {
		this.#handlers.get(event)?.delete(handler);
		return this;
	}

	timeout(milliseconds: number): {
			emit: (
				event: string,
				value: unknown,
				ack: (error: unknown, response?: unknown) => void
		) => FakeSocket;
	} {
		this.ackTimeouts.push(milliseconds);
		return {
			emit: (event, value, ack) => {
				let pending = true;
				const emission: Emission = {
					event,
					value,
					timeoutMs: milliseconds,
					ack: (response) => {
						if (!pending) return;
						pending = false;
						ack(null, response);
					},
					expire: () => {
						if (!pending) return;
						pending = false;
						ack(new Error('operation has timed out'));
					},
					isPending: () => pending
				};
				this.emissions.push(emission);
				this.onEmission?.(emission);
				return this;
			}
		};
	}

	pendingAckCount(): number {
		return this.emissions.filter((emission) => emission.isPending()).length;
	}

	expirePendingAcks(): void {
		for (const emission of this.emissions) emission.expire();
	}

	serverEmit(event: string, value: unknown): void {
		for (const handler of [...(this.#handlers.get(event) ?? [])]) handler(value);
	}

	emission(event: string, index = 0): Emission {
		const emission = this.emissions.filter((candidate) => candidate.event === event)[index];
		if (!emission) throw new Error(`Missing ${event} emission ${index}`);
		return emission;
	}

	count(event: string): number {
		return this.emissions.filter((candidate) => candidate.event === event).length;
	}

	listenerCount(event: string): number {
		return this.#handlers.get(event)?.size ?? 0;
	}
}
