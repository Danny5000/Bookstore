import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const readRepositoryFile = (path: string) =>
	readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Caddy sensitive URI logging boundary', () => {
	it('filters nested request URIs in the default runtime logger and keeps access logging disabled', async () => {
		const caddyfile = await readRepositoryFile('deploy/Caddyfile');
		const firstSiteBlock = caddyfile.indexOf(':2015 {');

		expect(firstSiteBlock).toBeGreaterThan(-1);

		const globalOptions = caddyfile.slice(0, firstSiteBlock);
		const siteBlocks = caddyfile.slice(firstSiteBlock);

		expect(globalOptions).toMatch(
			/log\s+default\s*\{[\s\S]*?format\s+filter\s*\{[\s\S]*?request>uri\s+(?:delete|replace\s+REDACTED)(?:\s|$)[\s\S]*?\}[\s\S]*?\}/u
		);
		expect(caddyfile).not.toMatch(/^[\t ]*log_credentials(?:[\t ]|$)/mu);
		expect(siteBlocks).not.toMatch(/^[\t ]*log(?:[\t ]|$)/mu);
	});

	it('documents the runtime and authentication logging boundary', async () => {
		const [runtimeGuide, authenticationGuide] = await Promise.all([
			readRepositoryFile('docs/runtime-environments.md'),
			readRepositoryFile('docs/authentication-and-email.md')
		]);

		expect(runtimeGuide).toMatch(/access logging[^.]*disabled/iu);
		expect(runtimeGuide).toMatch(/default runtime logger[^.]*`request>uri`[^.]*delet/iu);
		expect(runtimeGuide).toMatch(/`log_credentials`[^.]*unset/iu);
		expect(authenticationGuide).toMatch(/native[^.]*verification[^.]*reset[^.]*magic[^.]*bearer/iu);
		expect(authenticationGuide).toMatch(/request targets?[^.]*paths?[^.]*query strings?/iu);
		expect(authenticationGuide).toMatch(/Caddy[^.]*`request>uri`[^.]*delet/iu);
		expect(authenticationGuide).toMatch(/access logs?[^.]*equivalent[^.]*filter/iu);
	});
});
