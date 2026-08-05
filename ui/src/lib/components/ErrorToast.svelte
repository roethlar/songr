<script lang="ts">
	import {
		commandFeedbackQueue,
		dismissCommandFeedback,
		type CommandFeedbackToast
	} from '$lib/stores/commandFeedbackStore';

	// One 5s auto-dismiss timer per toast — a later push must not reset
	// an earlier toast's clock, so the diff runs inside the effect body
	// (an effect cleanup would cancel every timer on each queue change).
	const timers = new Map<number, ReturnType<typeof setTimeout>>();

	$effect(() => {
		const toasts = $commandFeedbackQueue;
		for (const toast of toasts) {
			if (!timers.has(toast.id)) {
				timers.set(
					toast.id,
					setTimeout(() => {
						timers.delete(toast.id);
						dismissCommandFeedback(toast.id);
					}, 5000)
				);
			}
		}
		for (const [id, timer] of timers) {
			if (!toasts.some((toast) => toast.id === id)) {
				clearTimeout(timer);
				timers.delete(id);
			}
		}
	});

	$effect(() => {
		return () => {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		};
	});

	function sourceLabel(toast: CommandFeedbackToast): string {
		const label =
			toast.source === 'transport' ? 'Playback' : toast.source === 'queue' ? 'Queue' : 'Browse';
		return toast.kind === 'success' ? label : `${label} Error`;
	}
</script>

{#if $commandFeedbackQueue.length > 0}
	<div class="toast-stack">
		{#each $commandFeedbackQueue as toast (toast.id)}
			{@const isSuccess = toast.kind === 'success'}
			<div class="toast" class:error-toast={!isSuccess} class:success-toast={isSuccess}>
				<div class="toast-content">
					<div class="toast-header">
						<span class="toast-icon">{isSuccess ? '✓' : '⚠️'}</span>
						<strong>{sourceLabel(toast)}</strong>
					</div>
					<p class="toast-message">{toast.message}</p>
					{#if !isSuccess}
						<p class="toast-command">Command: {toast.command}</p>
					{/if}
				</div>
				<button class="toast-dismiss" onclick={() => dismissCommandFeedback(toast.id)}>✕</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-stack {
		position: fixed;
		bottom: 2rem;
		right: 2rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		z-index: 1000;
	}

	.toast {
		max-width: 400px;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: var(--shadow-soft);
		padding: 1rem;
		display: flex;
		gap: 1rem;
		animation: slideIn 0.3s ease-out;
	}

	@keyframes slideIn {
		from {
			transform: translateY(100%);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}

	.error-toast {
		border-left: 4px solid #dc3545;
	}

	.success-toast {
		border-left: 4px solid #28a745;
	}

	.success-toast .toast-header strong {
		color: #28a745;
	}

	.toast-content {
		flex: 1;
	}

	.toast-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.toast-icon {
		font-size: 1.2rem;
	}

	.toast-header strong {
		color: #dc3545;
	}

	.toast-message {
		margin: 0.5rem 0;
		color: var(--text);
	}

	.toast-command {
		margin: 0.25rem 0 0 0;
		font-size: 0.85rem;
		color: var(--text-soft);
		font-family: monospace;
	}

	.toast-dismiss {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: var(--text-soft);
		cursor: pointer;
		padding: 0;
		line-height: 1;
	}

	.toast-dismiss:hover {
		color: var(--text);
	}
</style>
