import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ErrorToast from '../ErrorToast.svelte';
import {
	pushCommandFeedback,
	clearCommandFeedback
} from '$lib/stores/commandFeedbackStore';

beforeEach(() => {
	clearCommandFeedback();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('ErrorToast', () => {
	it('renders nothing when no feedback is set', () => {
		render(ErrorToast);
		expect(screen.queryByRole('button', { name: /✕/ })).toBeNull();
	});

	it('renders a transport error with the right label', async () => {
		render(ErrorToast);
		pushCommandFeedback({
			source: 'transport',
			command: 'transport:play-pause',
			message: 'Roon rejected the command'
		});
		expect(await screen.findByText(/playback error/i)).toBeInTheDocument();
		expect(screen.getByText('Roon rejected the command')).toBeInTheDocument();
		expect(screen.getByText(/transport:play-pause/)).toBeInTheDocument();
	});

	it('renders queue / browse errors with the right label', async () => {
		const { unmount } = render(ErrorToast);
		pushCommandFeedback({ source: 'queue', command: 'queue:play-from-here', message: 'q err' });
		expect(await screen.findByText(/queue error/i)).toBeInTheDocument();
		unmount();

		render(ErrorToast);
		pushCommandFeedback({ source: 'browse', command: 'browse:browse', message: 'b err' });
		expect(await screen.findByText(/browse error/i)).toBeInTheDocument();
	});

	it('renders kind=success as a confirmation, not an error (no "Error" heading, no command line)', async () => {
		render(ErrorToast);
		pushCommandFeedback({
			source: 'browse',
			command: 'favorites',
			kind: 'success',
			message: 'Added "Lio-Marcus Mendel" to favorites.'
		});
		expect(await screen.findByText('Added "Lio-Marcus Mendel" to favorites.')).toBeInTheDocument();
		// Heading is just the source label — no "Error", no ⚠️.
		expect(screen.getByText('Browse')).toBeInTheDocument();
		expect(screen.queryByText(/browse error/i)).toBeNull();
		expect(screen.queryByText('⚠️')).toBeNull();
		expect(screen.getByText('✓')).toBeInTheDocument();
		// The "Command: …" debug line is error-only noise.
		expect(screen.queryByText(/Command: favorites/)).toBeNull();
	});

	it('clears via the dismiss button', async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(ErrorToast);
		pushCommandFeedback({ source: 'transport', command: 'x', message: 'oops' });
		expect(await screen.findByText('oops')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: '✕' }));
		expect(screen.queryByText('oops')).toBeNull();
	});

	it('auto-clears after 5 seconds', async () => {
		render(ErrorToast);
		pushCommandFeedback({ source: 'transport', command: 'x', message: 'fades' });
		expect(await screen.findByText('fades')).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(5000);
		expect(screen.queryByText('fades')).toBeNull();
	});

	it('stacks rapid pushes instead of overwriting — both stay visible', async () => {
		render(ErrorToast);
		pushCommandFeedback({
			source: 'browse',
			command: 'favorites',
			kind: 'success',
			message: 'Added "Abbey Road" to favorites.'
		});
		pushCommandFeedback({
			source: 'transport',
			command: 'transport:play-pause',
			message: 'Roon rejected the command'
		});
		expect(await screen.findByText('Added "Abbey Road" to favorites.')).toBeInTheDocument();
		expect(screen.getByText('Roon rejected the command')).toBeInTheDocument();
	});

	it('expires each toast on its own 5s clock — a later push does not reset earlier toasts', async () => {
		render(ErrorToast);
		pushCommandFeedback({ source: 'transport', command: 'x', message: 'first toast' });
		await vi.advanceTimersByTimeAsync(3000);
		pushCommandFeedback({ source: 'transport', command: 'x', message: 'second toast' });

		// First reaches its 5s lifetime while the second is 2s old.
		await vi.advanceTimersByTimeAsync(2000);
		expect(screen.queryByText('first toast')).toBeNull();
		expect(screen.getByText('second toast')).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(3000);
		expect(screen.queryByText('second toast')).toBeNull();
	});

	it('caps concurrent toasts at three, dropping the oldest', async () => {
		render(ErrorToast);
		for (const n of [1, 2, 3, 4]) {
			pushCommandFeedback({ source: 'queue', command: 'q', message: `toast ${n}` });
		}
		expect(await screen.findByText('toast 4')).toBeInTheDocument();
		expect(screen.getByText('toast 2')).toBeInTheDocument();
		expect(screen.getByText('toast 3')).toBeInTheDocument();
		expect(screen.queryByText('toast 1')).toBeNull();
	});
});
