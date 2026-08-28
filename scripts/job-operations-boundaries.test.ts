import { access, readFile, readdir } from 'node:fs/promises';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

async function sourceFiles(directory: URL, prefix: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(new URL(`${entry.name}/`, directory), path));
    } else if (/\.(?:[cm]?js|ps1|ts|svelte|md|sql|ya?ml)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function imports(value: string): readonly string[] {
  const syntax = ts.createSourceFile(
    'job-operations-boundary-source.ts',
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) {
      const argument = node.arguments[0];
      if (node.arguments.length !== 1 || argument === undefined ||
        !ts.isStringLiteralLike(argument)) {
        throw new Error('retry dependency specifier must be one literal');
      }
      specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return specifiers;
}

function isForbiddenRetryDependency(specifier: string): boolean {
  if (/(?:gateway|provider|runtime-core|stripe-sdk|(?:^|\/)stripe\/runtime(?:\/|$))/iu
    .test(specifier)) return true;
  if (specifier.startsWith('.') || specifier.startsWith('$lib/')) return false;
  return specifier !== 'node:util/types' && specifier !== 'drizzle-orm';
}

function hasOperationsCapabilitySecretIdentifier(value: string): boolean {
  const withoutTransactionLocalSetting = value.replaceAll(
    'pale_orbit.plan7a_operations_job_capability',
    ''
  );
  return /(?:PLAN7A[_-])?OPERATIONS(?:[_-]JOB|Job)(?:[_-]LEASE|Lease)?(?:[_-]CAPABILITY|Capability)/iu
    .test(withoutTransactionLocalSetting);
}

describe('job operations application boundaries', () => {
  it('recognizes every literal module edge used by the retry isolation gate', () => {
    expect(imports(`
      import Stripe from 'stripe';
      import 'node:https';
      export { request } from 'axios';
      void import('undici');
      require('got');
    `)).toEqual(['stripe', 'node:https', 'axios', 'undici', 'got']);
  });

  it.each([
    'stripe',
    '@stripe/stripe-js',
    'node:http',
    'node:https',
    'axios',
    'got',
    'ky',
    'superagent',
    '$lib/server/commerce/stripe/runtime-core',
    '$lib/server/commerce/stripe/runtime',
    '../../commerce/stripe/gateway'
  ])('rejects the retry dependency %s', (specifier) => {
    expect(isForbiddenRetryDependency(specifier)).toBe(true);
  });

  it.each([
    'operationsJobLeaseCapability',
    'operationsJobCapability',
    'OPERATIONS_JOB_LEASE_CAPABILITY',
    'PLAN7A_OPERATIONS_JOB_CAPABILITY',
    'operations-job-lease-capability'
  ])('recognizes the operations capability secret identifier %s', (identifier) => {
    expect(hasOperationsCapabilitySecretIdentifier(identifier)).toBe(true);
  });

  it('does not confuse the transaction-local GUC name with a configured clear secret', () => {
    expect(hasOperationsCapabilitySecretIdentifier(
      'pale_orbit.plan7a_operations_job_capability'
    )).toBe(false);
  });

  it('enumerates every executable script format for capability sink checks', async () => {
    const scripts = await sourceFiles(new URL('scripts/', root), 'scripts');
    expect(scripts).toContain('scripts/start-dev.ps1');
    expect(scripts).toContain('scripts/stripe-secret-preflight.mjs');
  });

  it('composes the closed retry registry and operations handler only at the worker root', async () => {
    const worker = await source('src/worker.ts');

    for (const expected of [
      'createStripeEventJobRetryPolicyAdapter()',
      'createFinancialClassificationJobRetryPolicyAdapter()',
      'createJobRetryPolicyAdapters({',
      'createOperationsJobRetryHandler({',
      'createRegisteredJobHandlerMap([',
      'OPERATIONS_JOB_RETRY_COMMAND_JOB',
      'operationsRetryCommandHandler',
      'parseJobDiagnosticMetadata: parseRegisteredJobDiagnosticMetadata'
    ]) expect(worker).toContain(expected);

    expect(worker.match(/\bcreateJobRetryPolicyAdapters\s*\(/gu)).toHaveLength(1);
    expect(worker.match(/\bcreateOperationsJobRetryHandler\s*\(/gu)).toHaveLength(1);
    expect(worker.match(/\bcreateRegisteredJobHandlerMap\s*\(/gu)).toHaveLength(1);
    expect(worker).toMatch(
      /createJobRetryPolicyAdapters\(\{\s*rearmPendingStripeEvent:\s*createStripeEventJobRetryPolicyAdapter\(\),\s*rearmFinancialClassification:\s*createFinancialClassificationJobRetryPolicyAdapter\(\)\s*\}\)/u
    );

    const registryStart = worker.indexOf('const retryPolicies =');
    const handlerStart = worker.indexOf('const operationsRetryCommandHandler =');
    const bindingsStart = worker.indexOf('const handlers =');
    const runnerStart = worker.indexOf('run: (signal) => runWorker({');
    expect(registryStart).toBeGreaterThan(-1);
    expect(handlerStart).toBeGreaterThan(registryStart);
    expect(bindingsStart).toBeGreaterThan(handlerStart);
    expect(runnerStart).toBeGreaterThan(bindingsStart);
  });

  it('keeps policies, adapters, and the command handler off provider and network dependencies', async () => {
    const allowedImports: Readonly<Record<string, readonly string[]>> = {
      'src/lib/server/operations/jobs/policies.ts': [
        'node:util/types',
        '../../db/transaction',
        '../../jobs/catalog',
        './contracts'
      ],
      'src/lib/server/operations/jobs/handler.ts': [
        'node:util/types',
        'drizzle-orm',
        '../../db/client',
        '../../db/transaction',
        '../../jobs/catalog',
        '../../jobs/runner',
        '../../jobs/types',
        '../../observability/contracts',
        './contracts',
        './policies'
      ],
      'src/lib/server/operations/jobs/adapters/stripe-event.ts': [
        'node:util/types',
        'drizzle-orm',
        '$lib/server/jobs/catalog',
        '$lib/server/jobs/repository',
        '../policies'
      ],
      'src/lib/server/operations/jobs/adapters/financial-classification.ts': [
        'node:util/types',
        'drizzle-orm',
        '$lib/server/commerce/financial/jobs',
        '$lib/server/commerce/financial/constants',
        '$lib/server/commerce/financial/projection-authority',
        '$lib/server/jobs/repository',
        '../policies'
      ]
    };

    for (const [path, allowed] of Object.entries(allowedImports)) {
      const value = await source(path);
      const dependencies = imports(value);
      expect(dependencies.some(isForbiddenRetryDependency), path).toBe(false);
      expect([...new Set(dependencies)].sort(), path).toEqual([...allowed].sort());
      expect(value, path).not.toMatch(
        /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)/u
      );
    }

    const worker = await source('src/worker.ts');
    const retryAssembly = worker.slice(
      worker.indexOf('const retryPolicies ='),
      worker.indexOf('const handlers =')
    );
    expect(retryAssembly).not.toMatch(/stripeRuntime|gateway|provider/iu);
  });

  it('keeps the clear operations capability on its four in-memory transport modules', async () => {
    const applicationFiles = await sourceFiles(new URL('src/', root), 'src');
    const consumers: string[] = [];
    for (const file of applicationFiles) {
      if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) continue;
      if (hasOperationsCapabilitySecretIdentifier(await source(file))) consumers.push(file);
    }

    expect(consumers.sort()).toEqual([
      'src/lib/server/jobs/repository.ts',
      'src/lib/server/jobs/runner.ts',
      'src/lib/server/jobs/types.ts',
      'src/lib/server/operations/jobs/handler.ts'
    ].sort());
  });

  it('keeps clear operations capability identifiers out of configuration and evidence sinks', async () => {
    const documentation = (await sourceFiles(new URL('docs/', root), 'docs'))
      .filter((path) => !path.startsWith('docs/superpowers/'));
    const scripts = (await sourceFiles(new URL('scripts/', root), 'scripts'))
      .filter((path) => !/\.(?:test|spec)\.ts$/u.test(path));
    const sinks = [
      '.env.example',
      'README.md',
      'compose.dev.yaml',
      'compose.prod.yaml',
      'compose.stripe.yaml',
      'compose.test.yaml',
      ...documentation,
      ...scripts
    ];

    for (const path of sinks) {
      expect(hasOperationsCapabilitySecretIdentifier(await source(path)), path).toBe(false);
    }
  });

  it('keeps contracts independent of database, worker, provider, route, and browser modules', async () => {
    const contracts = await source('src/lib/server/operations/jobs/contracts.ts');

    expect(imports(contracts).some((path) =>
      /(?:db|worker|stripe|provider|routes|browser|\$app|\$env)/u.test(path)
    )).toBe(false);
  });

  it('keeps the repository on exactly three complete routines and off protected tables', async () => {
    const repository = await source('src/lib/server/operations/jobs/repository.ts');
    const routineCalls = Array.from(
      repository.matchAll(/public\.(?<routine>[a-z][a-z0-9_]*)\(/gu),
      (match) => match.groups?.routine ?? ''
    );

    expect(routineCalls).toEqual([
      'list_operational_jobs',
      'submit_job_retry_command',
      'get_owned_job_retry_command'
    ]);
    expect(repository).not.toMatch(/(?:from|into|update|join)\s+["']?(?:jobs|audit_events|operations_job_retry_(?:commands|claims))/iu);
    expect(imports(repository).some((path) => /db\/schema|jobs\/repository|audit\/service/u.test(path)))
      .toBe(false);
  });

  it('keeps the service on authorization, contracts, repository, and narrow audit only', async () => {
    const service = await source('src/lib/server/operations/jobs/service.ts');

    expect(imports(service).sort()).toEqual([
      '$lib/server/auth/admin-policy',
      './audit',
      './contracts',
      './repository'
    ].sort());
    expect(service).not.toMatch(/\b(?:sql|execute|select|insert|update|delete)\b/iu);
    expect(service).not.toMatch(/(?:fetch|stripe|provider|worker)/iu);
  });

  it('allows only audit.ts to import the shared audit service and freezes denial provenance', async () => {
    const directory = new URL('src/lib/server/operations/jobs/', root);
    const files = (await readdir(directory)).filter((name) =>
      name.endsWith('.ts') && !name.endsWith('.test.ts')
    );
    const sharedAuditImporters: string[] = [];
    for (const file of files) {
      const value = await readFile(new URL(file, directory), 'utf8');
      if (value.includes('$lib/server/audit/service')) sharedAuditImporters.push(file);
    }
    expect(sharedAuditImporters).toEqual(['audit.ts']);

    const audit = await source('src/lib/server/operations/jobs/audit.ts');
    expect(audit).toContain("action: 'operations.job_retry.requested'");
    expect(audit).toContain("outcome: 'denied'");
    expect(audit).toContain("resourceType: 'operations_job_retry_command'");
    for (const field of ['resourceId', 'requestMetadata', 'before', 'after']) {
      expect(audit).toMatch(new RegExp(`${field}: null`, 'u'));
    }

    const service = await source('src/lib/server/operations/jobs/service.ts');
    expect(service).toContain('auditJobRetryRequestDenied');
    expect(service.match(/await auditDenied\(/gu)).toHaveLength(1);
  });

  it('adds no route, UI, navigation, polling, public API, or provider boundary', async () => {
    for (const path of [
      'src/routes/admin/jobs',
      'src/routes/admin/operations',
      'src/lib/components/job-operations',
      'src/lib/client/job-operations'
    ]) {
      await expect(access(new URL(path, root))).rejects.toThrow();
    }

    const applicationFiles = [
      ...await sourceFiles(new URL('src/routes/', root), 'src/routes'),
      ...await sourceFiles(new URL('src/lib/', root), 'src/lib')
    ];
    const unexpectedConsumers: string[] = [];
    for (const file of applicationFiles) {
      if (file.startsWith('src/lib/server/operations/jobs/')) continue;
      const value = await source(file);
      if (
        /(?:\$lib\/server\/operations\/jobs|server\/operations\/jobs)/u.test(value) ||
        /(?:href|action)\s*=\s*["']\/admin\/(?:jobs|operations)/u.test(value) ||
        /(?:Retry job|Job operations|pollJobRetryCommand)/u.test(value)
      ) unexpectedConsumers.push(file);
    }
    expect(unexpectedConsumers).toEqual([]);

    const operationsSources = await Promise.all(
      (await readdir(new URL('src/lib/server/operations/jobs/', root)))
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => source(`src/lib/server/operations/jobs/${name}`))
    );
    const combined = operationsSources.join('\n');
    expect(combined).not.toMatch(
      /(?:provider gateway|\bfetch\s*\(|runtime-core|stripe-sdk|src\/worker|from ['"].*worker)/iu
    );
    expect(combined).not.toMatch(/(?:polling|retry button|navigation link|public api)/iu);
  });
});
