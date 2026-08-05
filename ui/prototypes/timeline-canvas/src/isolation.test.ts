import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from 'vitest';

const prototypeRoot = [
	resolve(cwd(), 'ui/prototypes/timeline-canvas'),
	resolve(cwd(), 'prototypes/timeline-canvas'),
	cwd()
].find((candidate) => existsSync(resolve(candidate, 'vite.config.ts')));

if (!prototypeRoot) throw new Error('Unable to locate the standalone Timeline prototype root');

const sourceDirectory = resolve(prototypeRoot, 'src');
const uiRoot = resolve(prototypeRoot, '../..');
const repositoryRoot = resolve(uiRoot, '..');
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.svelte']);

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return sourceExtensions.has(extname(entry.name)) ? [path] : [];
	});
}

function combinedSource(files: readonly string[]): string {
	return files.map((path) => readFileSync(path, 'utf8')).join('\n');
}

describe('prototype isolation', () => {
	it('is absent from both production module graphs', () => {
		const productionSource = combinedSource([
			...sourceFiles(resolve(repositoryRoot, 'src')),
			...sourceFiles(resolve(uiRoot, 'src'))
		]);

		expect(productionSource).not.toContain('prototypes/timeline-canvas');
		expect(productionSource).not.toContain('timeline-harness-root');
	});

	it('has no production imports, controller transport, or browser network calls', () => {
		const prototypeFiles = sourceFiles(sourceDirectory).filter(
			(path) => !path.endsWith('.test.ts') && !path.includes(`${join('src', '__tests__')}`)
		);
		const prototypeSource = combinedSource(prototypeFiles);
		const forbidden = [
			/from\s+['"](?:\$app|\$lib|@shared|socket\.io-client)/,
			/(?:ui\/src|src\/shared|\/api\/|\/socket\.io)/,
			/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/,
			/\.sendBeacon\s*\(/
		];

		for (const pattern of forbidden) expect(prototypeSource).not.toMatch(pattern);
	});

	it('uses a localhost-only standalone Vite root and temporary build output', () => {
		const config = readFileSync(resolve(prototypeRoot, 'vite.config.ts'), 'utf8');
		expect(config).toContain("host: '127.0.0.1'");
		expect(config).toContain('strictPort: true');
		expect(config).toContain("join(tmpdir(), 'roon-controller-timeline-harness')");
		expect(config).not.toMatch(/sveltekit|proxy:|alias:|\/api|socket\.io/i);
	});

	it('ships twelve representative local 512px PNG artwork fixtures', () => {
		const artworkDirectory = resolve(prototypeRoot, 'public/artwork');
		const files = readdirSync(artworkDirectory).filter((name) => name.endsWith('.png')).sort();
		expect(files).toHaveLength(12);
		let totalBytes = 0;
		for (const name of files) {
			const bytes = readFileSync(resolve(artworkDirectory, name));
			totalBytes += bytes.length;
			expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(bytes.readUInt32BE(16)).toBe(512);
			expect(bytes.readUInt32BE(20)).toBe(512);
			expect(bytes.length).toBeGreaterThan(10_000);
		}
		expect(totalBytes).toBeGreaterThan(1_000_000);
	});

	it('keeps the current built prototype free of production and controller markers', () => {
		const buildDirectory = join(tmpdir(), 'roon-controller-timeline-harness');
		expect(existsSync(buildDirectory), 'prototype test must scan a current standalone build').toBe(true);
		const built = combinedSource(sourceFiles(buildDirectory));
		expect(built).not.toMatch(/socket\.io-client|\/api\/|src\/shared|ui\/src/);
	});
});
