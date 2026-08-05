<script lang="ts">
	import { onMount, tick } from 'svelte';
	import CanvasHarness from './CanvasHarness.svelte';

	type VisualScenario = 'primary' | 'undated' | 'density';
	type CatalogSize = 'small' | 'medium' | 'large';
	type HarnessCommand =
		| { id: number; kind: 'trace' }
		| { id: number; kind: 'reset' }
		| { id: number; kind: 'export' };

	let scenario: VisualScenario = 'primary';
	let catalogSize: CatalogSize = 'medium';
	let command: HarnessCommand | null = null;
	let commandId = 0;
	let lastExport = 'No metrics export yet';

	function runCommand(kind: HarnessCommand['kind']) {
		command = { id: ++commandId, kind };
	}

	function handleExportSummary(summary: string) {
		lastExport = summary;
	}

	onMount(async () => {
		const params = new URL(window.location.href).searchParams;
		const requested = params.get('scenario');
		if (requested === 'undated') scenario = 'undated';
		else if (requested === 'stress' || requested === 'density') scenario = 'density';
		else if (requested === 'small' || requested === 'medium' || requested === 'large') {
			scenario = 'primary';
			catalogSize = requested;
		}
		if (params.get('autorun') === '1') {
			await tick();
			runCommand('trace');
		}
	});
</script>

<svelte:head>
	<title>Timeline canvas · synthetic prototype</title>
	<meta
		name="description"
		content="Production-isolated synthetic rendering and interaction harness for the Timeline canvas"
	/>
</svelte:head>

<div class="prototype-app">
	<div class="synthetic-banner" role="status">
		<span class="banner-light" aria-hidden="true"></span>
		<strong>SYNTHETIC PROTOTYPE — NO ROON CONNECTION</strong>
		<span>Local catalog · inert actions · production routes unreachable</span>
	</div>

	<header class="review-toolbar" aria-label="Prototype review controls">
		<div class="review-title">
			<strong>Draggable Timeline Canvas</strong>
			<span>§12 slice 4 · 1400 × 900 exact product frame</span>
		</div>

		<div class="review-control-group" role="group" aria-label="Visual scenario">
			<span>Scenario</span>
			{#each ['primary', 'undated', 'density'] as option}
				<button
					type="button"
					class:active={scenario === option}
					aria-pressed={scenario === option}
					onclick={() => (scenario = option as VisualScenario)}
				>
					{option === 'undated' ? 'Undated' : option === 'density' ? 'Density stress' : 'Primary'}
				</button>
			{/each}
		</div>

		<label class="review-select">
			<span>Catalog</span>
			<select bind:value={catalogSize} aria-label="Synthetic catalog size">
				<option value="small">Small</option>
				<option value="medium">Medium</option>
				<option value="large">Large</option>
			</select>
		</label>

		<div class="review-actions">
			<button type="button" onclick={() => runCommand('trace')}>Run 10s Trace</button>
			<button type="button" onclick={() => runCommand('reset')}>Reset ×20</button>
			<button type="button" onclick={() => runCommand('export')}>Export Metrics</button>
		</div>
	</header>

	<main class="review-stage">
		<CanvasHarness
			{scenario}
			catalogSize={scenario === 'density' ? 'large' : catalogSize}
			{command}
			onExportSummary={handleExportSummary}
		/>
	</main>

	<footer class="review-footnote">
		<span>{lastExport}</span>
		<span>Pointer: drag field to pan · Ctrl/⌘ + wheel to zoom · drag an album to a zone</span>
	</footer>
</div>
