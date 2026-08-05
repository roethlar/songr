import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const unifiedSurfaceCss = readFileSync(
	resolve(process.cwd(), 'src/routes/library/unified-surface.css'),
	'utf8'
);

function ruleBody(selector: string): string {
	const start = unifiedSurfaceCss.indexOf(selector);
	if (start < 0) throw new Error(`Missing unified-surface rule: ${selector}`);
	const bodyStart = unifiedSurfaceCss.indexOf('{', start) + 1;
	const bodyEnd = unifiedSurfaceCss.indexOf('}', bodyStart);
	return unifiedSurfaceCss.slice(bodyStart, bodyEnd);
}

describe('Unified surface artist separators', () => {
	it('keeps only letter-heading rules and dotted name-to-count leaders', () => {
		expect(ruleBody('.unified-surface .arow')).not.toContain('border-bottom');
		expect(ruleBody('.unified-surface .ad')).toContain(
			'border-bottom: 1px dotted rgba(255, 255, 255, 0.13)'
		);
		expect(ruleBody('.unified-surface .gl')).toContain(
			'border-bottom: 1px solid rgba(255, 255, 255, 0.06)'
		);
	});
});
