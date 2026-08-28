import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { posix } from 'node:path';
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
    } else if (/\.(?:[cm]?js|ps1|ts|svelte|md|sql|ya?ml|json|toml|txt|csv)$/u
      .test(entry.name) || entry.name.endsWith('.env')) {
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
  if (isProviderOrNetworkDependency(specifier)) return true;
  if (specifier.startsWith('.') || specifier.startsWith('$lib/')) return false;
  return specifier !== 'node:util/types' && specifier !== 'drizzle-orm';
}

function isProviderOrNetworkDependency(specifier: string): boolean {
  return /(?:gateway|provider|runtime-core|stripe-sdk|(?:^|\/)stripe\/runtime(?:\/|$))/iu
    .test(specifier) ||
    /^(?:@stripe\/stripe-js|stripe|node:https?|axios|got|ky|superagent|undici)(?:\/|$)/u
      .test(specifier);
}

async function resolveLocalTypeScriptModule(
  importer: string,
  specifier: string
): Promise<string | undefined> {
  const unresolved = specifier.startsWith('$lib/')
    ? `src/lib/${specifier.slice('$lib/'.length)}`
    : specifier.startsWith('.')
      ? posix.normalize(posix.join(posix.dirname(importer), specifier))
      : undefined;
  if (unresolved === undefined) return undefined;
  const withoutJavaScriptExtension = unresolved.replace(/\.[cm]?js$/u, '');
  const candidates = unresolved.endsWith('.ts')
    ? [unresolved]
    : [`${withoutJavaScriptExtension}.ts`, `${withoutJavaScriptExtension}/index.ts`];
  for (const candidate of candidates) {
    try {
      await access(new URL(candidate, root));
      return candidate;
    } catch { /* try the next TypeScript module shape */ }
  }
  return undefined;
}

function hasOperationsCapabilitySecretIdentifier(value: string): boolean {
  const withoutTransactionLocalSetting = value.replaceAll(
    'pale_orbit.plan7a_operations_job_capability',
    ''
  );
  return /(?:PLAN7A[_-])?OPERATIONS(?:[_-]JOB|Job)(?:[_-]LEASE|Lease)?(?:[_-]CAPABILITY|Capability)/iu
    .test(withoutTransactionLocalSetting);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

  it('keeps the complete local retry-adapter graph off provider and network edges', async () => {
    const pending = [
      'src/lib/server/operations/jobs/adapters/stripe-event.ts',
      'src/lib/server/operations/jobs/adapters/financial-classification.ts'
    ];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const path = pending.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const value = await source(path);
      const dependencies = imports(value);
      const forbiddenDependencies: string[] = [];
      const resolvedDependencies: string[] = [];
      for (const dependency of dependencies) {
        const resolved = await resolveLocalTypeScriptModule(path, dependency);
        const localSchemaModel = resolved?.startsWith('src/lib/server/db/schema/') === true;
        if (isProviderOrNetworkDependency(dependency) && !localSchemaModel) {
          forbiddenDependencies.push(dependency);
        }
        if (resolved !== undefined) resolvedDependencies.push(resolved);
      }
      expect(
        forbiddenDependencies,
        `${path} reached a provider or network dependency`
      ).toEqual([]);
      expect(
        /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)/u
          .test(value),
        `${path} reached a provider or network primitive`
      ).toBe(false);
      for (const resolved of resolvedDependencies) {
        if (!visited.has(resolved)) pending.push(resolved);
      }
    }

    expect(visited.has('src/lib/server/jobs/repository.ts')).toBe(true);
    expect(visited.has(
      'src/lib/server/commerce/financial/projection-authority.ts'
    )).toBe(true);
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

  it('keeps both fixed Task 18 canaries and their digests out of committed safe surfaces', async () => {
    const clearCanaries = ['O'.repeat(43), 'F'.repeat(43)] as const;
    const privateValues = [
      ...clearCanaries,
      ...clearCanaries.map(sha256)
    ];
    const documentation = await sourceFiles(new URL('docs/', root), 'docs');
    const databaseArtifacts = await sourceFiles(new URL('drizzle/', root), 'drizzle');
    const productionSources = (await sourceFiles(new URL('src/', root), 'src'))
      .filter((path) => !/\.(?:test|spec)\.[cm]?ts$/u.test(path));
    const operationalScripts = (await sourceFiles(new URL('scripts/', root), 'scripts'))
      .filter((path) => !/\.(?:test|spec)\.[cm]?ts$/u.test(path));
    const rootConfiguration = [
      '.dockerignore',
      '.env.example',
      '.gitignore',
      '.nvmrc',
      'README.md',
      'compose.dev.yaml',
      'compose.prod.yaml',
      'compose.stripe.yaml',
      'compose.test.yaml',
      'deploy/Caddyfile',
      'deploy/container.env',
      'Dockerfile',
      'drizzle.config.ts',
      'eslint.config.js',
      'package-lock.json',
      'package.json',
      'playwright.config.ts',
      'svelte.config.js',
      'tsconfig.json',
      'vite.config.ts',
      'vite.services.config.ts',
      'vitest.config.ts',
      'vitest.integration.config.ts',
      'vitest.service.config.ts'
    ];
    const fixedArtifactSurfaces = [
      'scripts/capture-restore-row-counts.sql',
      'scripts/deployment-checkpoint.ts',
      'scripts/execute-financial-restore-verifier.ts',
      'scripts/financial-restore-witness-harness.ts',
      'scripts/verify-financial-restore.sql'
    ];
    const surfaces = [...new Set([
      ...documentation,
      ...databaseArtifacts,
      ...productionSources,
      ...operationalScripts,
      ...rootConfiguration,
      ...fixedArtifactSurfaces
    ])];

    for (const path of surfaces) {
      const value = await source(path);
      for (const privateValue of privateValues) {
        expect(
          value.includes(privateValue),
          `${path} persisted a fixed Task 18 capability value`
        ).toBe(false);
      }
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

  it('keeps every current operator guide aligned with Checkpoint C head', async () => {
    const currentGuidePaths = [
      'README.md',
      'docs/authentication-and-email.md',
      'docs/commerce-and-guest-claims.md',
      'docs/customer-library-and-reader.md',
      'docs/database-and-workers.md',
      'docs/dependency-decisions.md',
      'docs/financial-reconciliation-and-reporting.md',
      'docs/runtime-environments.md',
      'docs/storage-ingestion-and-publication.md',
      'docs/stripe-financial-reconciliation.md'
    ] as const;
    const guides = await Promise.all(currentGuidePaths.map(async (path) => ({
      path,
      value: await source(path)
    })));
    for (const guide of guides) {
      expect(guide.value, guide.path).toContain('Plan 7A Checkpoint C');
      expect(guide.value, guide.path).toContain(
        'migration chain ends at `0015_plan7a_operations_authority`'
      );
      expect(guide.value, guide.path).toContain(
        'executable verifier is `plan7a-database-catalog-v1`'
      );

      const prose = guide.value.replace(/```[\s\S]*?```/gu, '');
      for (const [index, paragraph] of prose.split(/\r?\n\s*\r?\n/u).entries()) {
        if (!/`0014(?:_[^`]*)?`|plan6b-financial-catalog-v4/u.test(paragraph)) continue;
        expect(
          /(?:historical|legacy|bundle-authenticated)/iu.test(paragraph),
          `${guide.path} prose paragraph ${index + 1} presents Plan 6B head/verifier history as current`
        ).toBe(true);
      }
    }

    const currentOperatorCorpus = guides.map((guide) => guide.value).join('\n');
    const canonicalGuide = guides.find(
      (guide) => guide.path === 'docs/commerce-and-guest-claims.md'
    )?.value;
    expect(canonicalGuide).toBeDefined();
    const canonicalCheckpointCSection = canonicalGuide?.match(
      /^## Release state and authority\r?\n([\s\S]*?)(?=^## )/mu
    )?.[1];
    expect(canonicalCheckpointCSection).toBeDefined();
    for (const [label, pattern] of [
      ['migration head', /migration chain ends at `0015_plan7a_operations_authority`/u],
      ['catalog verifier', /executable verifier is `plan7a-database-catalog-v1`/u],
      ['backend authority', /backend-only list\/submit\/status/iu],
      ['application authorization', /`jobs\.retry`/u],
      ['database reauthorization', /current-role reauthorization/iu],
      ['closed catalog', /exactly eleven production job kinds/iu],
      ['enabled policies', /only pending Stripe-event rearm and exact financial-classification rearm are enabled/iu],
      ['fixed disabled policies', /all other initial policies return disabled\/excluded fixed results/iu],
      ['no generic reset', /no generic job reset/iu],
      ['no delivered redelivery', /no delivered-outbox redelivery/iu],
      ['no recursive retry', /no recursive command retry/iu],
      ['no ingestion retry', /no general ingestion retry/iu],
      ['provider isolation', /no provider call occurs/iu],
      ['per-claim capability', /per-claim/iu],
      ['transaction-local capability', /memory\/transaction-local only/iu],
      ['digest-only persistence', /digest-persisted/iu],
      ['non-environment capability', /not environment secrets/iu],
      ['separate authorities', /financial-admin and revision-ingestion authorities remain separate/iu],
      ['durable authority', /command, audit, and restore authority is exact/iu],
      ['retained history', /command history is retained/iu],
      ['no operations UI', /no operations route, page, navigation, polling, or button exists/iu],
      ['production posture', /production (?:stays|remains) maintenance-only and Stripe-disabled/iu]
    ] as const) {
      expect(
        pattern.test(canonicalCheckpointCSection ?? ''),
        `missing canonical current ${label} guidance`
      )
        .toBe(true);
    }

    const deferredParagraph = canonicalCheckpointCSection
      ?.split(/\r?\n\s*\r?\n/u)
      .find((paragraph) => /Checkpoint D remain deferred/iu.test(paragraph));
    expect(deferredParagraph).toBeDefined();
    for (const [label, phrase] of [
      ['monitoring', 'Monitoring/alerts'],
      ['stage evidence', 'generalized stage evidence'],
      ['activation', 'production-live activation'],
      ['Stripe', 'Stripe enablement'],
      ['candidate capture', 'fresh release-candidate capture'],
      ['Checkpoint D', 'Checkpoint D remain deferred']
    ] as const) {
      expect(
        deferredParagraph?.toLocaleLowerCase('en-US')
          .includes(phrase.toLocaleLowerCase('en-US')),
        `missing canonical deferred ${label} guidance`
      ).toBe(true);
    }

    const storageGuide = guides.find(
      (guide) => guide.path === 'docs/storage-ingestion-and-publication.md'
    )?.value;
    const legacyRestoreParagraph = storageGuide?.match(
      /This legacy rollback procedure[^\r\n]*/u
    )?.[0];
    expect(legacyRestoreParagraph).toContain('`0014_plan6bii_issue_transition_fail_closed`');
    expect(legacyRestoreParagraph).toContain('`plan6b-financial-catalog-v4`');
    expect(currentOperatorCorpus).not.toMatch(
      /Checkpoint D (?:is |has been )?(?:implemented|complete)/iu
    );
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
