import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import {
	ClassicBrowseSupersededError,
	createClassicBrowseSessionClient
} from '../classicBrowseSessionStore';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function socket() {
	return { connected: true };
}

describe('Classic browse session client', () => {
	it('does not acquire while its mode lifecycle is suspended', async () => {
		const emit = vi.fn();
		const client = createClassicBrowseSessionClient({
			getSocket: () => socket() as never,
			getTabId: () => 'tab-1',
			createRequestId: () => 'request-1',
			emit: emit as never
		});

		await expect(
			client.request(
				{
					owner: 'classic-mode',
					claimId: 1,
					ready: Promise.resolve({ handleId: 'inactive', generation: 0 })
				},
				'browse',
				'classic-browse',
				{ hierarchy: 'browse', popAll: true }
			)
		).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
		expect(emit).not.toHaveBeenCalled();
	});

	it('acquires one opaque generation and sends no raw session key', async () => {
		const liveSocket = socket();
		const emit = vi.fn().mockResolvedValue({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 4 }
			}
		});
		let request = 0;
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});

		const claim = client.claim('classic-mode');
		await expect(claim.ready).resolves.toEqual({ handleId: 'handle-1', generation: 4 });
		expect(emit).toHaveBeenCalledWith(
			liveSocket,
			'classic-session:acquire',
			{ requestId: 'request-1', tabId: 'tab-1' },
			{ timeoutMs: 20_000 }
		);
		expect(JSON.stringify(emit.mock.calls)).not.toContain('multiSessionKey');
	});

	it('retries the same claim after its first socket connection race', async () => {
		const liveSocket = { connected: false };
		const emit = vi.fn().mockResolvedValue({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 1 }
			}
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => 'request-1',
			emit: emit as never
		});

		const claim = client.claim('unified-mode');
		await expect(claim.ready).rejects.toThrow('Not connected to server');
		expect(emit).not.toHaveBeenCalled();

		liveSocket.connected = true;
		await expect(claim.ready).resolves.toEqual({ handleId: 'handle-1', generation: 1 });
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it('invalidates a delayed old command and releases exactly once on suspend', async () => {
		const liveSocket = socket();
		const command = deferred<unknown>();
		let request = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: 'handle-old', generation: 1 }
					}
				};
			}
			if (event === 'classic-session:release') {
				return { success: true, data: { requestId: payload.requestId } };
			}
			return command.promise;
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
		const claim = client.claim('classic-mode');
		await claim.ready;
		const pending = client.request(
			claim,
			'browse',
			'classic-browse',
			{ hierarchy: 'browse', popAll: true }
		);

		client.release(claim);
		command.resolve({
			success: true,
			data: {
				requestId: 'request-2',
				session: { handleId: 'handle-old', generation: 1 },
				result: { title: 'Late', level: 0, offset: 0, count: 0, items: [] }
			}
		});

		await expect(pending).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
		expect(
			emit.mock.calls.filter(([, event]) => event === 'classic-session:release')
		).toHaveLength(1);
		client.release(claim);
		expect(
			emit.mock.calls.filter(([, event]) => event === 'classic-session:release')
		).toHaveLength(1);
	});

	it('retires an acquire acknowledgment that arrives after suspension', async () => {
		const liveSocket = socket();
		const acquire = deferred<unknown>();
		let request = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') return acquire.promise;
			return { success: true, data: { requestId: payload.requestId } };
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
		const claim = client.claim('classic-mode');
		const pending = claim.ready;
		client.release(claim);
		acquire.resolve({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-late', generation: 1 }
			}
		});
		await expect(pending).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
		expect(
			emit.mock.calls.filter(([, event]) => event === 'classic-session:release')
		).toHaveLength(1);
	});

	it('holds a role across a multi-command transaction', async () => {
		const liveSocket = socket();
		const betweenCommands = deferred<void>();
		const commandOrder: string[] = [];
		let request = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: 'handle-1', generation: 1 }
					}
				};
			}
			commandOrder.push(payload.options.hierarchy);
			return {
				success: true,
				data: {
					requestId: payload.requestId,
					session: payload.session,
					result: {
						title: payload.options.hierarchy,
						level: 0,
						offset: 0,
						count: 0,
						items: []
					}
				}
			};
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
		const claim = client.claim('classic-mode');
		await claim.ready;

		const transaction = client.transaction(claim, 'classic-explore', async (role) => {
			await role.request('browse', { hierarchy: 'artists', popAll: true });
			await betweenCommands.promise;
			await role.request('browse', { hierarchy: 'albums', popAll: true });
		});
		await vi.waitFor(() => expect(commandOrder).toEqual(['artists']));
		const outside = client.request(claim, 'browse', 'classic-explore', {
			hierarchy: 'composers',
			popAll: true
		});
		await Promise.resolve();
		expect(commandOrder).toEqual(['artists']);

		betweenCommands.resolve();
		await Promise.all([transaction, outside]);
		expect(commandOrder).toEqual(['artists', 'albums', 'composers']);
	});

	it('detaches a fresh lifecycle queue from an unresolved old command', async () => {
		const liveSocket = socket();
		const oldCommand = deferred<unknown>();
		let request = 0;
		let acquisition = 0;
		const emittedHandles: string[] = [];
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				const handleId = `handle-${++acquisition}`;
				return {
					success: true,
					data: { requestId: payload.requestId, session: { handleId, generation: acquisition } }
				};
			}
			if (event === 'classic-session:release') {
				return { success: true, data: { requestId: payload.requestId } };
			}
			emittedHandles.push(payload.session.handleId);
			if (payload.session.handleId === 'handle-1') return oldCommand.promise;
			return {
				success: true,
				data: {
					requestId: payload.requestId,
					session: payload.session,
					result: { title: 'Fresh', level: 0, offset: 0, count: 0, items: [] }
				}
			};
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
		const oldClaim = client.claim('classic-mode');
		await oldClaim.ready;
		const oldPending = client.request(oldClaim, 'browse', 'classic-browse', {
			hierarchy: 'browse',
			popAll: true
		});
		await vi.waitFor(() => expect(emittedHandles).toEqual(['handle-1']));

		client.release(oldClaim);
		const freshClaim = client.claim('classic-mode');
		await freshClaim.ready;
		const fresh = client.request(freshClaim, 'browse', 'classic-browse', {
			hierarchy: 'browse',
			popAll: true
		});
		await expect(fresh).resolves.toMatchObject({ title: 'Fresh' });
		expect(emittedHandles).toEqual(['handle-1', 'handle-2']);

		oldCommand.resolve({
			success: true,
			data: {
				requestId: 'request-2',
				session: { handleId: 'handle-1', generation: 1 },
				result: { title: 'Old', level: 0, offset: 0, count: 0, items: [] }
			}
		});
		await expect(oldPending).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
	});

	it('abandons an outcome-unknown command and acquires a fresh generation', async () => {
		const liveSocket = socket();
		let request = 0;
		let acquisition = 0;
		let failCommand = true;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				const handleId = `handle-${++acquisition}`;
				return {
					success: true,
					data: { requestId: payload.requestId, session: { handleId, generation: acquisition } }
				};
			}
			if (event === 'classic-session:release') {
				return { success: true, data: { requestId: payload.requestId } };
			}
			if (failCommand) {
				failCommand = false;
				throw new Error('ack timeout');
			}
			return {
				success: true,
				data: {
					requestId: payload.requestId,
					session: payload.session,
					result: { title: 'Recovered', level: 0, offset: 0, count: 0, items: [] }
				}
			};
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
		const claim = client.claim('classic-mode');
		await claim.ready;
		await expect(
			client.request(claim, 'browse', 'classic-browse', {
				hierarchy: 'browse',
				popAll: true
			})
		).rejects.toThrow('ack timeout');
		expect(
			emit.mock.calls.filter(([, event]) => event === 'classic-session:release')
		).toHaveLength(1);

		await expect(client.recover(claim)).resolves.toEqual({ handleId: 'handle-2', generation: 2 });
		await expect(
			client.request(claim, 'browse', 'classic-browse', {
				hierarchy: 'browse',
				popAll: true
			})
		).resolves.toMatchObject({ title: 'Recovered' });
	});

	it('abandons a malformed successful command acknowledgment before reacquiring', async () => {
		const liveSocket = socket();
		let request = 0;
		let acquisition = 0;
		let returnMalformedResult = true;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				const handleId = `handle-${++acquisition}`;
				return {
					success: true,
					data: { requestId: payload.requestId, session: { handleId, generation: acquisition } }
				};
			}
			if (event === 'classic-session:release') {
				return { success: true, data: { requestId: payload.requestId } };
			}
			if (returnMalformedResult) {
				returnMalformedResult = false;
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: payload.session,
						result: { title: 'Missing offset', level: 0, count: 0, items: [] }
					}
				};
			}
			return {
				success: true,
				data: {
					requestId: payload.requestId,
					session: payload.session,
					result: { title: 'Recovered', level: 0, offset: 0, count: 0, items: [] }
				}
			};
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});

		const claim = client.claim('classic-mode');
		await claim.ready;
		await expect(
			client.request(claim, 'browse', 'classic-browse', {
				hierarchy: 'browse',
				popAll: true
			})
		).rejects.toThrow('Malformed Classic browse response');
		expect(
			emit.mock.calls.filter(([, event]) => event === 'classic-session:release')
		).toHaveLength(1);

		await expect(client.recover(claim)).resolves.toEqual({ handleId: 'handle-2', generation: 2 });
		await expect(
			client.request(claim, 'browse', 'classic-browse', {
				hierarchy: 'browse',
				popAll: true
			})
		).resolves.toMatchObject({ title: 'Recovered' });
	});

	it('retires a disconnected socket generation before reconnect acquisition', async () => {
		const liveSocket = socket();
		let request = 0;
		let acquisition = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				const handleId = `handle-${++acquisition}`;
				return {
					success: true,
					data: { requestId: payload.requestId, session: { handleId, generation: acquisition } }
				};
			}
			return { success: true, data: { requestId: payload.requestId } };
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
		const claim = client.claim('classic-mode');
		await claim.ready;
		client.connectionLost(claim);
		await expect(client.recover(claim)).resolves.toEqual({ handleId: 'handle-2', generation: 2 });
		expect(
			emit.mock.calls.filter(([, event]) => event === 'classic-session:acquire')
		).toHaveLength(2);
	});

	it('rejects a transaction whose callback catches an abandoned request', async () => {
		const liveSocket = socket();
		let request = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: 'handle-1', generation: 1 }
					}
				};
			}
			if (event === 'classic-session:release') {
				return { success: true, data: { requestId: payload.requestId } };
			}
			throw new Error('drill lost authority');
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
		const claim = client.claim('classic-mode');
		await claim.ready;

		await expect(
			client.transaction(claim, 'classic-explore', async (transaction) => {
				try {
					await transaction.request('browse', { hierarchy: 'browse', popAll: true });
				} catch {
					// Resolver-level fallbacks cannot turn an abandoned session into success.
				}
				return 'partial';
			})
		).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
		expect(get(client)).toMatchObject({ owner: 'classic-mode', phase: 'none' });
	});

	it('hands a deferred normal claim through Classic to a fresh normal generation', async () => {
		const liveSocket = socket();
		const deferredNormal = deferred<unknown>();
		let request = 0;
		let acquisition = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				acquisition += 1;
				if (acquisition === 1) return deferredNormal.promise;
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: `handle-${acquisition}`, generation: acquisition }
					}
				};
			}
			return { success: true, data: { requestId: payload.requestId } };
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});

		const normalA = client.claim('normal-shell');
		const classicB = client.claim('classic-mode');
		await expect(classicB.ready).resolves.toEqual({ handleId: 'handle-2', generation: 2 });
		client.release(normalA);
		expect(get(client)).toMatchObject({ owner: 'classic-mode', phase: 'live' });

		client.release(classicB);
		const normalC = client.claim('normal-shell');
		await expect(normalC.ready).resolves.toEqual({ handleId: 'handle-3', generation: 3 });
		client.release(classicB);

		deferredNormal.resolve({
			success: true,
			data: {
				requestId: 'request-1',
				session: { handleId: 'handle-1', generation: 1 }
			}
		});
		await expect(normalA.ready).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
		expect(get(client)).toMatchObject({
			owner: 'normal-shell',
			phase: 'live',
			session: { handleId: 'handle-3', generation: 3 }
		});
	});

	it('ignores cleanup from a replaced same-owner claim', async () => {
		const liveSocket = socket();
		let request = 0;
		let acquisition = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				acquisition += 1;
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: `handle-${acquisition}`, generation: acquisition }
					}
				};
			}
			return { success: true, data: { requestId: payload.requestId } };
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});

		const oldClassic = client.claim('classic-mode');
		await oldClassic.ready;
		const replacementClassic = client.claim('classic-mode');
		await replacementClassic.ready;
		await expect(
			client.request(oldClassic, 'browse', 'classic-browse', {
				hierarchy: 'browse',
				popAll: true
			})
		).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
		expect(emit.mock.calls.filter(([, event]) => event === 'browse:browse')).toEqual([]);
		client.release(oldClassic);

		expect(get(client)).toMatchObject({
			owner: 'classic-mode',
			phase: 'live',
			session: { handleId: 'handle-2', generation: 2 }
		});
	});

	it('starts the reverse owner after either prior owner acquisition fails', async () => {
		const liveSocket = socket();
		let request = 0;
		let acquisition = 0;
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				acquisition += 1;
				if (acquisition === 1 || acquisition === 3) {
					return { success: false, error: 'claim failed', code: 'SESSION_LOST' };
				}
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: `handle-${acquisition}`, generation: acquisition }
					}
				};
			}
			return { success: true, data: { requestId: payload.requestId } };
		});
		const client = createClassicBrowseSessionClient({
			getSocket: () => liveSocket as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});

		const failedNormal = client.claim('normal-shell');
		await expect(failedNormal.ready).rejects.toThrow('claim failed');
		const readyClassic = client.claim('classic-mode');
		await expect(readyClassic.ready).resolves.toEqual({ handleId: 'handle-2', generation: 2 });
		client.release(readyClassic);

		const failedClassic = client.claim('classic-mode');
		await expect(failedClassic.ready).rejects.toThrow('claim failed');
		const readyNormal = client.claim('normal-shell');
		await expect(readyNormal.ready).resolves.toEqual({ handleId: 'handle-4', generation: 4 });
		expect(get(client)).toMatchObject({ owner: 'normal-shell', phase: 'live' });
	});
});

describe('Unified-mode session ownership', () => {
	function acquireEmit(options: { failBrowseOnce?: boolean } = {}) {
		let acquisition = 0;
		let failBrowse = options.failBrowseOnce === true;
		const browsed: string[] = [];
		const emit = vi.fn(async (_socket, event, payload) => {
			if (event === 'classic-session:acquire') {
				acquisition += 1;
				return {
					success: true,
					data: {
						requestId: payload.requestId,
						session: { handleId: `handle-${acquisition}`, generation: acquisition }
					}
				};
			}
			if (failBrowse) {
				failBrowse = false;
				throw new Error('socket dropped mid-drill');
			}
			browsed.push(payload.options.hierarchy);
			return {
				success: true,
				data: {
					requestId: payload.requestId,
					session: payload.session,
					result: {
						title: payload.options.hierarchy,
						level: 0,
						offset: 0,
						count: 0,
						items: []
					}
				}
			};
		});
		return { emit, browsed };
	}

	function unifiedClient(emit: ReturnType<typeof vi.fn>) {
		let request = 0;
		return createClassicBrowseSessionClient({
			getSocket: () => socket() as never,
			getTabId: () => 'tab-1',
			createRequestId: () => `request-${++request}`,
			emit: emit as never
		});
	}

	it('hands Classic off to Unified with a fresh generation', async () => {
		const { emit } = acquireEmit();
		const client = unifiedClient(emit);

		const classic = client.claim('classic-mode');
		await expect(classic.ready).resolves.toEqual({ handleId: 'handle-1', generation: 1 });

		const unified = client.claim('unified-mode');
		await expect(unified.ready).resolves.toEqual({ handleId: 'handle-2', generation: 2 });
		expect(get(client)).toMatchObject({ owner: 'unified-mode', phase: 'live' });

		// The suspended mode's late release must not tear down Unified.
		client.release(classic);
		expect(get(client)).toMatchObject({
			owner: 'unified-mode',
			phase: 'live',
			session: { handleId: 'handle-2', generation: 2 }
		});
	});

	it('supersedes an older unified claim without emitting its commands', async () => {
		const { emit, browsed } = acquireEmit();
		const client = unifiedClient(emit);

		const oldUnified = client.claim('unified-mode');
		await oldUnified.ready;
		const replacement = client.claim('unified-mode');
		await replacement.ready;

		await expect(
			client.request(oldUnified, 'browse', 'classic-explore', {
				hierarchy: 'artists',
				popAll: true
			})
		).rejects.toBeInstanceOf(ClassicBrowseSupersededError);
		expect(browsed).toEqual([]);

		client.release(oldUnified);
		expect(get(client)).toMatchObject({
			owner: 'unified-mode',
			phase: 'live',
			session: { handleId: 'handle-2', generation: 2 }
		});
	});

	it('recovers the same unified claim after a mid-drill disconnect', async () => {
		const { emit, browsed } = acquireEmit({ failBrowseOnce: true });
		const client = unifiedClient(emit);

		const unified = client.claim('unified-mode');
		const firstSession = { handleId: 'handle-1', generation: 1 };
		await expect(unified.ready).resolves.toEqual(firstSession);
		const drillGeneration = client.generation();
		expect(client.isSessionCurrent(unified, firstSession)).toBe(true);
		expect(client.isGenerationCurrent(unified, drillGeneration)).toBe(true);

		await expect(
			client.transaction(unified, 'classic-explore', async (role) => {
				await role.request('browse', { hierarchy: 'artists', popAll: true });
			})
		).rejects.toBeInstanceOf(Error);
		expect(browsed).toEqual([]);

		client.connectionLost(unified);
		// The pre-disconnect drill generation is permanently retired.
		expect(client.isSessionCurrent(unified, firstSession)).toBe(false);
		expect(client.isGenerationCurrent(unified, drillGeneration)).toBe(false);

		const recoveredSession = {
			handleId: 'handle-2',
			generation: 2
		};
		await expect(client.recover(unified)).resolves.toEqual(recoveredSession);
		expect(client.isSessionCurrent(unified, recoveredSession)).toBe(true);
		expect(client.isGenerationCurrent(unified, drillGeneration)).toBe(false);
		expect(client.isGenerationCurrent(unified, client.generation())).toBe(true);

		await client.transaction(unified, 'classic-explore', async (role) => {
			await role.request('browse', { hierarchy: 'artists', popAll: true });
		});
		expect(browsed).toEqual(['artists']);
	});
});
