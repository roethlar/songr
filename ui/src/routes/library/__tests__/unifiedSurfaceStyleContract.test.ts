import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const unifiedSurfaceCss = readFileSync(
	resolve(process.cwd(), 'src/routes/library/unified-surface.css'),
	'utf8'
);
const appCss = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');
const layoutSource = readFileSync(resolve(process.cwd(), 'src/routes/+layout.svelte'), 'utf8');

function sourceRuleBody(source: string, selector: string): string {
	const start = source.indexOf(selector);
	if (start < 0) throw new Error(`Missing rule: ${selector}`);
	const bodyStart = source.indexOf('{', start) + 1;
	const bodyEnd = source.indexOf('}', bodyStart);
	return source.slice(bodyStart, bodyEnd);
}

const ruleBody = (selector: string): string => sourceRuleBody(unifiedSurfaceCss, selector);
const layoutRuleBody = (selector: string): string => sourceRuleBody(layoutSource, selector);

describe('Unified surface artist separators', () => {
	it('keeps only letter-heading rules and dotted name-to-count leaders', () => {
		expect(ruleBody('.unified-surface .arow')).not.toContain('border-bottom');
		expect(ruleBody('.unified-surface .ad')).toContain(
			'border-bottom: 1px dotted var(--songr-line-13)'
		);
		expect(ruleBody('.unified-surface .gl')).toContain(
			'border-bottom: 1px solid var(--line-subtle)'
		);
	});
});

describe('Gallery Ivory light theme', () => {
	it('keeps OLED black as the unchanged dark default', () => {
		expect(appCss).toContain('--songr-app-bg: #050505');
		expect(appCss).toContain('--songr-bg: #000');
		expect(appCss).toContain('--songr-panel: #0b0b0b');
		expect(appCss).toContain('--songr-accent: #c8a24a');
	});

	it('pins the owner-approved surfaces and maps them into Unified', () => {
		expect(appCss).toContain("html[data-theme='light']");
		expect(appCss).toContain('--songr-header: #faf6ef');
		expect(appCss).toContain('--songr-bg: #f3eee5');
		expect(appCss).toContain('--songr-rail: #eee6da');
		expect(appCss).toContain('--songr-control: #e8dfd1');
		expect(appCss).toContain('--songr-hover: #d9ccb9');
		expect(appCss).toContain('--songr-line: #cbbda7');
		expect(appCss).toContain('--songr-line-strong: #ccbea8');
		expect(appCss).toContain('--songr-accent: #b48732');

		expect(ruleBody('.unified-surface {')).toContain('--bg: var(--songr-bg)');
		expect(ruleBody('.unified-surface .bar')).toContain('background: var(--header)');
		expect(ruleBody('.unified-surface .rail')).toContain('background: var(--rail-bg)');
	});

	it('themes the transport with the same shared palette', () => {
		const playBar = layoutRuleBody('.play-bar');
		expect(playBar).toContain('background: var(--songr-app-bg)');
		expect(playBar).toContain('border-top: 1px solid var(--songr-line)');
		expect(playBar).toContain('color: var(--songr-text)');
		expect(layoutRuleBody('.unified-transport-controls')).toContain(
			'color: var(--songr-text-mid)'
		);
		expect(layoutRuleBody('.unified-queue')).toContain('background: var(--songr-control)');
		expect(layoutSource).toContain('linear-gradient(to right, var(--songr-accent)');
		expect(ruleBody('.unified-surface .player')).toContain(
			'background: var(--songr-app-bg)'
		);
	});
});
