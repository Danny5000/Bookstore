import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8').replace(/\r\n?/gu, '\n');
}

function productionSourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (absoluteDirectory: string): void => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (
        /[.](?:[cm]?js|svelte|ts)$/u.test(entry.name) &&
        !/[.](?:test|spec)[.](?:[cm]?js|ts)$/u.test(entry.name)
      ) {
        files.push(relative(repositoryRoot, absolutePath).replaceAll('\\', '/'));
      }
    }
  };
  visit(resolve(repositoryRoot, directory));
  return files.sort();
}

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  expect(startIndex, start).toBeGreaterThan(-1);
  expect(endIndex, end).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

describe('observability ownership and privacy boundaries', () => {
  it('keeps context.ts as the sole production x-request-id reader', () => {
    const readers = productionSourceFiles('src').filter((path) =>
      /headers\s*\.\s*get\(\s*['"]x-request-id['"]\s*\)/iu.test(source(path))
    );

    expect(readers).toEqual(['src/lib/server/observability/context.ts']);
    expect(source(readers[0]!)).toMatch(
      /normalizeOrCreateCorrelationId\(request\.headers\.get\('x-request-id'\), uuidSource\)/u
    );
  });

  it('establishes top-level context before timing and the maintenance/auth operation', () => {
    const hook = source('src/hooks.server.ts');
    const operation = between(
      hook,
      'async function requestOperation(',
      'type CapturedRequestOperation ='
    );
    const observed = between(
      hook,
      'async function observedRequest(',
      'export const handle: Handle ='
    );
    const handle = hook.slice(hook.indexOf('export const handle: Handle ='));

    expect(handle).toMatch(
      /const correlationId = correlationIdForRequest\(event\.request\);[\s\S]*return runWithDiagnosticContext\(\s*\{ kind: 'web', correlationId \},\s*\(\) => observedRequest\(/u
    );
    expect(observed.indexOf('const startedAt = performance.now();')).toBeLessThan(
      observed.indexOf('captureRequestOperation(event, resolve, config)')
    );
    expect(operation.indexOf('isRequestAvailable(')).toBeLessThan(
      operation.indexOf('const auth = getAuthServer();')
    );
  });

  it('keeps URL, query, header, and domain data out of lifecycle logger inputs', () => {
    const hook = source('src/hooks.server.ts');
    const lifecycle = source('src/lib/server/observability/http-lifecycle.ts');
    const loggerInputs = [...hook.matchAll(
      /emitHttpLifecycleEvent\(logger,\s*\{([\s\S]*?)\n\s*\}\);/gu
    )].map((match) => match[1] ?? '');

    expect(loggerInputs).toHaveLength(2);
    for (const input of loggerInputs) {
      expect(input).not.toMatch(
        /\b(?:request|url|pathname|query|response|body|headers|cookies|params|formData|actionPayload|exception|domainResponseCode|cause|stack|message|email|token|secret|payload|signature|deduplicationKey|objectKey)\s*:/u
      );
    }
    expect(lifecycle).not.toMatch(
      /\b(?:request|url|pathname|query|response|body|headers|cookies|params|formData|actionPayload|exception|domainResponseCode|cause|stack|message|email|token|secret|payload|signature|deduplicationKey|objectKey)\s*:/u
    );
    expect(hook).not.toMatch(/JSON\.stringify|\.searchParams\b|\.search\b|\.href\b/u);
  });

  it('does not echo correlation through a response header', () => {
    const assignments = productionSourceFiles('src').filter((path) =>
      /(?:headers\s*\.\s*(?:set|append)\(\s*['"]x-request-id['"]|['"]x-request-id['"]\s*:)/iu.test(source(path))
    );
    expect(assignments).toEqual([]);
  });

  it('introduces no raw console call in observability modules or the migrated hook', () => {
    const files = [
      'src/hooks.server.ts',
      ...productionSourceFiles('src/lib/server/observability')
    ];
    for (const path of files) {
      expect(source(path), path).not.toMatch(/\bconsole\.(?:debug|error|info|log|warn)\s*\(/u);
    }
  });

  it('keeps smoke producers unwired to the logger during Checkpoint B', () => {
    for (const path of [
      'scripts/plan6b-production-smoke.ts',
      'scripts/plan6b-fixture-runtime-probe.ts'
    ]) {
      const smoke = source(path);
      expect(smoke, path).not.toMatch(
        /(?:from\s+|import\s*\()\s*['"][^'"]*observability\/logger['"]/u
      );
      expect(smoke, path).not.toContain('createStructuredLogger');
    }
  });

  it('keeps worker health private, fixed-output, and free of network or public-route behavior', () => {
    const healthLibrary = source('src/lib/server/worker/health-check.ts');
    const healthEntrypoint = source('src/worker-health.ts');
    const healthSources = `${healthLibrary}\n${healthEntrypoint}`;
    const healthImports = [...healthLibrary.matchAll(/from\s+['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]);
    const publicRouteSources = productionSourceFiles('src/routes').map(source).join('\n');

    expect(healthImports).toEqual(['node:fs/promises', './heartbeat-contract']);
    expect(healthSources.match(/\[worker-health\] unhealthy/gu)).toHaveLength(2);
    expect(healthSources).not.toMatch(/`[^`]*\[worker-health\] unhealthy|\$\{/u);
    expect(healthSources).not.toMatch(
      /\b(?:fetch|listen|createServer|connect|createConnection|WebSocket)\s*\(|from\s+['"]node:(?:http|https|net|tls|dgram)['"]/iu
    );
    expect(publicRouteSources).not.toMatch(/worker[-_/ ]health|WORKER_READY_FILE/iu);
    expect(healthSources).not.toMatch(
      /createStructuredLogger|emitStructuredLog|console\.(?:debug|info|log|warn)\s*\(/u
    );
  });

  it('keeps diagnostic context out of authorization locals', () => {
    const appTypes = source('src/app.d.ts');
    const locals = between(appTypes, 'interface Locals {', '}\n  }');

    expect(locals).toContain('user: SessionUser | null;');
    expect(locals).toContain('session: SessionRecord | null;');
    expect(locals).toContain('actor: Actor;');
    expect(locals).not.toMatch(/diagnostic|observability|correlation|requestId|authorizationContext/iu);
  });
});
