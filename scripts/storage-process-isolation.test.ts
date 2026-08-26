import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

function runtimeSourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        /[.](?:[cm]?js|svelte|ts)$/u.test(entry.name) &&
        !/[.](?:test|spec)[.](?:[cm]?js|ts)$/u.test(entry.name)
      ) {
        files.push(path);
      }
    }
  };
  visit(resolve(root));
  return files.sort();
}

function runtimeScriptFragments(path: string, contents: string): readonly string[] {
  if (!path.endsWith('.svelte')) return [contents];
  return [...contents.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)]
    .map((match) => match[1] ?? '');
}

function hasRuntimeImportBinding(clause: ts.ImportClause | undefined): boolean {
  return clause === undefined || !clause.isTypeOnly;
}

function runtimeCallModuleSpecifier(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  if (!isDynamicImport && !isRequire) return undefined;

  const firstArgument = node.arguments[0];
  const validArity = isDynamicImport
    ? node.arguments.length === 1 || node.arguments.length === 2
    : node.arguments.length === 1;
  if (
    !validArity ||
    firstArgument === undefined ||
    !ts.isStringLiteralLike(firstArgument)
  ) {
    throw new Error('runtime module specifier must be one literal');
  }
  return firstArgument.text;
}

function runtimeModuleSpecifiersFromSource(
  path: string,
  contents: string
): readonly string[] {
  const specifiers = new Set<string>();
  for (const fragment of runtimeScriptFragments(path, contents)) {
    const syntax = ts.createSourceFile(
      path,
      fragment,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const visit = (node: ts.Node): void => {
      const callSpecifier = runtimeCallModuleSpecifier(node);
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        hasRuntimeImportBinding(node.importClause)
      ) {
        specifiers.add(node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.isTypeOnly
      ) {
        specifiers.add(node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression !== undefined &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        specifiers.add(node.moduleReference.expression.text);
      } else if (callSpecifier !== undefined) {
        specifiers.add(callSpecifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
  }
  return [...specifiers].sort();
}

function runtimeModuleSpecifiers(path: string): readonly string[] {
  return runtimeModuleSpecifiersFromSource(path, source(path));
}

function resolveRuntimeModule(importer: string, rawSpecifier: string): string | undefined {
  const specifier = rawSpecifier.split(/[?#]/u, 1)[0] ?? '';
  const base = specifier.startsWith('$lib/')
    ? resolve('src/lib', specifier.slice('$lib/'.length))
    : specifier.startsWith('.')
      ? resolve(dirname(importer), specifier)
      : undefined;
  if (base === undefined) return undefined;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.svelte`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, 'index.ts'),
    join(base, 'index.svelte'),
    join(base, 'index.js'),
    ...(base.endsWith('.js') ? [`${base.slice(0, -3)}.ts`] : [])
  ];
  return candidates.find((candidate) =>
    existsSync(candidate) && statSync(candidate).isFile()
  );
}

interface RuntimeImportGraph {
  readonly files: ReadonlySet<string>;
  readonly externalSpecifiers: ReadonlySet<string>;
  chainTo(path: string): string;
}

function runtimeValueImportGraph(entryFiles: readonly string[]): RuntimeImportGraph {
  const files = new Set<string>();
  const externalSpecifiers = new Set<string>();
  const parent = new Map<string, string | null>();
  const pending = entryFiles.map((path) => resolve(path));
  for (const entry of pending) parent.set(entry, null);

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (files.has(current)) continue;
    files.add(current);
    for (const specifier of runtimeModuleSpecifiers(current)) {
      const dependency = resolveRuntimeModule(current, specifier);
      if (dependency === undefined) {
        externalSpecifiers.add(specifier);
        continue;
      }
      if (parent.has(dependency)) continue;
      parent.set(dependency, current);
      pending.push(dependency);
    }
  }

  return {
    files,
    externalSpecifiers,
    chainTo(path) {
      const chain: string[] = [];
      let current: string | null | undefined = resolve(path);
      while (current !== undefined && current !== null) {
        chain.push(relative(process.cwd(), current).replaceAll('\\', '/'));
        current = parent.get(current);
      }
      return chain.reverse().join(' -> ');
    }
  };
}

function directRuntimeValueImporters(
  target: string,
  sourceFiles: readonly string[]
): readonly string[] {
  const resolvedTarget = resolve(target);
  return sourceFiles.filter((importer) => runtimeModuleSpecifiers(importer).some(
    (specifier) => resolveRuntimeModule(importer, specifier) === resolvedTarget
  )).map((importer) => relative(process.cwd(), importer).replaceAll('\\', '/')).sort();
}

function serviceBlock(compose: string, name: string): string {
  const match = new RegExp(
    `^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^secrets:|^networks:|^volumes:)`,
    'mu'
  ).exec(compose);
  if (!match) throw new Error(`Missing Compose service ${name}`);
  return match[0];
}

const storageEnvironment = [
  'STORAGE_STAGING_ROOT: /var/lib/pale-orbit/staging',
  'STORAGE_PUBLICATION_ROOT: /var/lib/pale-orbit/publication',
  'STORAGE_COVERS_ROOT: /var/lib/pale-orbit/covers',
  'STORAGE_SCRATCH_ROOT: /tmp/pale-orbit-verified'
] as const;

describe('storage process isolation deployment', () => {
  it('keeps the stateless worker-health graph out of storage and application clients', () => {
    const healthLibrary = source('src/lib/server/worker/health-check.ts');
    const healthImports = runtimeModuleSpecifiers('src/lib/server/worker/health-check.ts');
    const healthEntrypointImports = runtimeModuleSpecifiers('src/worker-health.ts');
    const healthGraph = runtimeValueImportGraph(['src/worker-health.ts']);
    const healthExternalSpecifiers = healthGraph.externalSpecifiers;
    const relativeGraph = [...healthGraph.files]
      .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))
      .sort();

    expect(healthImports).toEqual(['./heartbeat-contract', 'node:fs/promises']);
    expect(healthEntrypointImports).toEqual([
      '$lib/server/config/worker',
      '$lib/server/worker/health-check'
    ]);
    expect([...healthExternalSpecifiers].sort()).toEqual([
      'node:buffer',
      'node:fs',
      'node:fs/promises',
      'zod'
    ]);
    for (const forbidden of [
      '/auth/',
      '/commerce/',
      '/db/',
      '/email/',
      '/jobs/',
      '/routes/',
      '/storage/'
    ]) {
      expect(relativeGraph.some((path) => path.includes(forbidden)), forbidden).toBe(false);
    }
    for (const client of [
      'createDatabaseClient',
      'createObjectStorage',
      'nodemailer',
      'stripe',
      'better-auth'
    ]) {
      expect(healthLibrary).not.toContain(client);
    }
  });

  it('packages worker health as one named service input and one host-only source command', () => {
    const serviceBuild = source('vite.services.config.ts');
    const packageManifest = JSON.parse(source('package.json')) as {
      readonly scripts?: Readonly<Record<string, string>>;
      readonly dependencies?: Readonly<Record<string, string>>;
    };

    expect(serviceBuild).toContain(
      "'worker-health': resolve(import.meta.dirname, 'src/worker-health.ts')"
    );
    expect(serviceBuild).toMatch(
      /defineConfig\(\(\{\s*mode\s*\}\)\s*=>[\s\S]*mode\s*===\s*['"]worker-health['"]/u
    );
    expect(serviceBuild).toContain(
      'input: workerHealthBuild ? workerHealthInput : serviceInputs'
    );
    expect(serviceBuild).toContain('emptyOutDir: !workerHealthBuild');
    expect(serviceBuild).toContain('codeSplitting: !workerHealthBuild');
    expect(packageManifest.scripts?.['build:services']).toBe(
      'vite build --config vite.services.config.ts && vite build --config vite.services.config.ts --mode worker-health'
    );
    expect(packageManifest.scripts?.['worker:health']).toBe(
      'node --env-file-if-exists=.env --import tsx src/worker-health.ts'
    );
    expect(packageManifest.dependencies).not.toHaveProperty('tsx');
  });

  it('traverses every emitted import/export edge under verbatim module syntax', () => {
    expect(runtimeModuleSpecifiersFromSource('runtime-edge-fixture.ts', `
      import type { DeclarationOnlyImport } from './declaration-import';
      export type { DeclarationOnlyExport } from './declaration-export';
      import {} from './empty-import';
      import { type InlineImport } from './inline-import';
      export {} from './empty-export';
      export { type InlineExport } from './inline-export';
      import './side-effect-import';
      void import(\`$lib/server/dynamic-import\`);
      require(\`./template-require\`);
      void import('./dynamic-options', { with: { type: 'json' } });
    `)).toEqual([
      '$lib/server/dynamic-import',
      './dynamic-options',
      './empty-export',
      './empty-import',
      './inline-export',
      './inline-import',
      './side-effect-import',
      './template-require'
    ]);
  });

  it.each([
    ['computed dynamic import', "const target = 'stripe'; void import(target);"],
    ['interpolated dynamic import', "const target = 'stripe'; void import(`plugin-${target}`);"],
    ['computed require', "const target = 'stripe'; require(target);"],
    ['require without an argument', 'require();'],
    ['require with extra arguments', "require('zod', 'stripe');"]
  ])('rejects non-literal runtime module resolution: %s', (_name, contents) => {
    expect(() => runtimeModuleSpecifiersFromSource('runtime-edge-fixture.ts', contents))
      .toThrowError('runtime module specifier must be one literal');
  });

  it('does not confuse ordinary calls or require-named member methods with module loading', () => {
    expect(runtimeModuleSpecifiersFromSource('runtime-edge-fixture.ts', `
      const target = 'stripe';
      resolve(target);
      loader.require(target);
      require.resolve(target);
    `)).toEqual([]);
  });

  it('value-imports the test worker controller only from the worker process root', () => {
    const controllerPath = 'src/lib/server/jobs/test-worker-control.ts';
    const resolvedControllerPath = resolve(controllerPath);
    expect(
      existsSync(resolvedControllerPath),
      `Missing import-safe test worker controller at ${controllerPath}`
    ).toBe(true);

    const workerSource = source('src/worker.ts');
    expect(workerSource).toMatch(
      /import\s+\{[^}]*\bcreateTestWorkerControl\b[^}]*\}\s+from\s+['"]\$lib\/server\/jobs\/test-worker-control['"]/u
    );
    expect(workerSource.match(/\bcreateTestWorkerControl\s*\(/gu)).toHaveLength(1);
    expect(workerSource).toContain('const rawWorkerEnvironment = process.env;');
    expect(workerSource).toContain(
      "databaseEnvironmentForRole(rawWorkerEnvironment, 'worker')"
    );
    expect(workerSource).toMatch(
      /createTestWorkerControl\(\{\s*environment:\s*rawWorkerEnvironment,\s*concurrency:\s*config\.worker\.concurrency,\s*abortWorker:/u
    );

    const productionRuntimeSources = runtimeSourceFiles('src');
    expect(directRuntimeValueImporters(
      controllerPath,
      productionRuntimeSources
    )).toEqual(['src/worker.ts']);

    const workerGraph = runtimeValueImportGraph([resolve('src/worker.ts')]);
    expect(
      workerGraph.files.has(resolvedControllerPath),
      workerGraph.chainTo(resolvedControllerPath)
    ).toBe(true);

    const controllerGraph = runtimeValueImportGraph([resolvedControllerPath]);
    expect(controllerGraph.files.has(resolve(
      'src/lib/server/commerce/financial/admin-commands/errors.ts'
    ))).toBe(true);
    for (const forbiddenPath of [
      'src/lib/server/commerce/financial/admin-commands/handler.ts',
      'src/lib/server/commerce/financial/admin-commands/executors.ts'
    ]) {
      expect(
        controllerGraph.files.has(resolve(forbiddenPath)),
        controllerGraph.chainTo(resolve(forbiddenPath))
      ).toBe(false);
    }

    const webGraph = runtimeValueImportGraph([
      resolve('src/hooks.server.ts'),
      ...runtimeSourceFiles('src/routes'),
      ...runtimeSourceFiles('src/lib/components')
    ]);
    expect(
      webGraph.files.has(resolvedControllerPath),
      webGraph.chainTo(resolvedControllerPath)
    ).toBe(false);

    const cleanupGraph = runtimeValueImportGraph([resolve('src/cleanup-storage.ts')]);
    expect(
      cleanupGraph.files.has(resolvedControllerPath),
      cleanupGraph.chainTo(resolvedControllerPath)
    ).toBe(false);

    const controllerCreation = workerSource.indexOf('createTestWorkerControl({');
    const executorDecoration = workerSource.indexOf(
      'testWorkerControl.decorateFinancialAdminExecutors('
    );
    const handlerCreation = workerSource.indexOf(
      'createFinancialAdminCommandHandler({'
    );
    expect(executorDecoration).toBeGreaterThan(controllerCreation);
    expect(handlerCreation).toBeGreaterThan(executorDecoration);

    const pollStart = workerSource.indexOf('async function prepareWorkerPoll(');
    const shutdownStart = workerSource.indexOf('function requestShutdown()');
    const pollSource = workerSource.slice(pollStart, shutdownStart);
    expect(pollSource).toContain('await prepareTestWorkerPoll({');
    expect(pollSource).toContain('control: testWorkerControl');
    expect(pollSource).toContain('signal: context.signal');
    expect(pollSource).toContain('maintenance: async () => {');
    expect(pollSource).toContain('purgeCommerceClaimIssuances(databaseClient.db)');
    expect(pollSource).toContain('await ensureFinancialSchedule(context);');

    const runWorkerCall = workerSource.indexOf('await runWorker({');
    const throwIfFailed = workerSource.indexOf(
      'testWorkerControl.throwIfFailed();',
      runWorkerCall
    );
    const catchStart = workerSource.indexOf('} catch (error: unknown)', runWorkerCall);
    expect(runWorkerCall).toBeGreaterThan(-1);
    expect(throwIfFailed).toBeGreaterThan(runWorkerCall);
    expect(throwIfFailed).toBeLessThan(catchStart);
  }, 30_000);

  it('launches the controller-capable worker only with the owned isolated test environment', () => {
    const harness = source('scripts/with-test-database.ts');
    for (const expected of [
      "const runId = randomBytes(8).toString('hex');",
      'const project = `pale-orbit-test-${runId}`;',
      "const testStoragePrefix = join(resolve(tmpdir()), 'pale-orbit-test-storage-');",
      'const testStorageRoot = await mkdtemp(testStoragePrefix);',
      "const workerReadyFile = join(testStorageRoot, 'worker.ready');",
      "if (flag === '--worker') withWorker = true;",
      "APP_ENV: 'test'",
      'PALE_ORBIT_TEST_PROJECT: project',
      "DATABASE_HOST: '127.0.0.1'",
      "DATABASE_NAME: 'pale_orbit_test'",
      "DATABASE_WORKER_USER: 'pale_orbit_test_worker'",
      "WORKER_CONCURRENCY: '1'",
      'WORKER_READY_FILE: workerReadyFile',
      "const workerEnvironment = databaseEnvironmentForRole(webEnvironment, 'worker');",
      "spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts']",
      'if (withWorker) worker = await startWorker(workerEnvironment);',
      'env: webEnvironment'
    ]) {
      expect(harness).toContain(expected);
    }

    const workerEnvironmentStart = harness.indexOf(
      "const workerEnvironment = databaseEnvironmentForRole(webEnvironment, 'worker');"
    );
    const workerSpawn = harness.indexOf(
      'if (withWorker) worker = await startWorker(workerEnvironment);'
    );
    expect(workerEnvironmentStart).toBeGreaterThan(-1);
    expect(workerSpawn).toBeGreaterThan(workerEnvironmentStart);
    for (const setting of [
      'DATABASE_USER',
      'DATABASE_USER_FILE',
      'DATABASE_PASSWORD',
      'DATABASE_PASSWORD_FILE',
      'DATABASE_OWNER_USER',
      'DATABASE_OWNER_USER_FILE',
      'DATABASE_OWNER_PASSWORD',
      'DATABASE_OWNER_PASSWORD_FILE'
    ]) {
      const deletion = harness.indexOf(`delete workerEnvironment.${setting};`);
      expect(deletion, setting).toBeGreaterThan(workerEnvironmentStart);
      expect(deletion, setting).toBeLessThan(workerSpawn);
    }

    expect(harness).not.toMatch(
      /\b(?:TEST_)?WORKER_(?:CONTROL|REQUEST|PAUSE|RELEASE|ACK(?:NOWLEDGEMENT)?)_FILE\b/u
    );
  });

  it('keeps every web, cleanup, production, and non-test composition unable to enable control', () => {
    const production = source('compose.prod.yaml');
    const development = source('compose.dev.yaml');
    const testServices = source('compose.test.yaml');
    const exampleEnvironment = source('.env.example');
    const playwright = source('playwright.config.ts');
    const productionServices = ['app', 'worker', 'storage-cleanup'].map(
      (name) => serviceBlock(production, name)
    );
    const developmentServices = ['app', 'worker', 'storage-cleanup'].map(
      (name) => serviceBlock(development, name)
    );

    for (const block of productionServices) {
      expect(block).toContain('APP_ENV: production');
      expect(block).not.toContain('PALE_ORBIT_TEST_PROJECT');
      expect(block).not.toContain('pale-orbit-test-storage-');
    }
    for (const block of developmentServices) {
      expect(block).toContain('DATABASE_HOST: postgres');
      expect(block).not.toContain('PALE_ORBIT_TEST_PROJECT');
      expect(block).not.toContain('pale-orbit-test-storage-');
    }

    expect(testServices).not.toMatch(/^ {2}(?:app|worker|storage-cleanup):/mu);
    expect(exampleEnvironment).toContain('APP_ENV=development');
    expect(exampleEnvironment).not.toContain('PALE_ORBIT_TEST_PROJECT');
    expect(playwright).toMatch(
      /\bcommand:\s*'npm run build:web && npm run preview -- --host 127\.0\.0\.1 --port 4173 --strictPort'/u
    );
    expect(playwright).not.toContain('src/worker.ts');
    expect(playwright).not.toContain('$lib/server/jobs/test-worker-control');

    const callerSelectedControlSetting =
      /\b(?:TEST_)?WORKER_(?:CONTROL|REQUEST|PAUSE|RELEASE|ACK(?:NOWLEDGEMENT)?)_FILE\b/u;
    for (const sourceText of [production, development, exampleEnvironment, playwright]) {
      expect(sourceText).not.toMatch(callerSelectedControlSetting);
    }
  });

  it('mounts publication read-only in web and all persistent roots read-write in worker', () => {
    const compose = source('compose.prod.yaml');
    const app = serviceBlock(compose, 'app');
    const worker = serviceBlock(compose, 'worker');

    for (const setting of storageEnvironment) {
      expect(app).toContain(setting);
      expect(worker).toContain(setting);
    }
    expect(app).toContain('book_staging:/var/lib/pale-orbit/staging');
    expect(app).toContain('book_publication:/var/lib/pale-orbit/publication:ro');
    expect(app).toContain('book_covers:/var/lib/pale-orbit/covers');
    expect(worker).toContain('book_staging:/var/lib/pale-orbit/staging');
    expect(worker).toContain('book_publication:/var/lib/pale-orbit/publication');
    expect(worker).not.toContain('book_publication:/var/lib/pale-orbit/publication:ro');
    expect(worker).toContain('book_covers:/var/lib/pale-orbit/covers');
    expect(app).not.toContain('book_storage:');
    expect(worker).not.toContain('book_storage:');
  });

  it('uses capability-specific split-root readiness without weakening publication isolation', () => {
    expect(source('src/routes/health/ready/+server.ts')).toContain(
      "probeStorage(getObjectStorage(), 'web')"
    );
    expect(source('src/worker.ts')).toContain("probeStorage(storage, 'writer')");
    expect(source('src/cleanup-storage.ts')).toContain("probeStorage(storage, 'writer')");
    const runtime = source('docs/runtime-environments.md');
    expect(runtime).toContain('round-trips staging and covers');
    expect(runtime).toContain('fixed publication sentinel');
    expect(runtime).toContain('round-trip all three roots');
  });

  it('gives cleanup explicit read-write access to all persistent roots and ephemeral scratch', () => {
    const cleanup = serviceBlock(source('compose.prod.yaml'), 'storage-cleanup');
    for (const setting of storageEnvironment) expect(cleanup).toContain(setting);
    for (const mount of [
      'book_staging:/var/lib/pale-orbit/staging',
      'book_publication:/var/lib/pale-orbit/publication',
      'book_covers:/var/lib/pale-orbit/covers'
    ]) {
      expect(cleanup).toContain(mount);
      expect(cleanup).not.toContain(`${mount}:ro`);
    }
    expect(cleanup).toMatch(/^ {4}tmpfs:\r?\n\s+- \/tmp:rw,noexec,nosuid,size=/mu);
  });

  it('gives cleanup only its dedicated production database credential', () => {
    const cleanup = serviceBlock(source('compose.prod.yaml'), 'storage-cleanup');

    expect(cleanup).toContain(
      'DATABASE_STORAGE_CLEANUP_USER: ${DATABASE_STORAGE_CLEANUP_USER:'
    );
    expect(cleanup).toContain(
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE: /run/secrets/database_storage_cleanup_password'
    );
    expect(cleanup).toMatch(/^\s+- database_storage_cleanup_password\s*$/mu);
    expect(cleanup).not.toContain('DATABASE_USER:');
    expect(cleanup).not.toContain('/run/secrets/database_password');
    expect(cleanup).not.toContain('DATABASE_OWNER_');
    expect(cleanup).not.toContain('DATABASE_WORKER_');
  });

  it('declares three persistent production volumes and no authoritative scratch volume', () => {
    const compose = source('compose.prod.yaml');
    const volumes = compose.slice(compose.lastIndexOf('\nvolumes:'));
    expect(volumes).toContain('  book_staging:');
    expect(volumes).toContain('  book_publication:');
    expect(volumes).toContain('  book_covers:');
    expect(volumes).not.toContain('  book_storage:');
    expect(volumes).not.toMatch(/scratch/iu);
  });

  it('mirrors the same read-only publication boundary in development Compose', () => {
    const compose = source('compose.dev.yaml');
    const app = serviceBlock(compose, 'app');
    const worker = serviceBlock(compose, 'worker');
    const cleanup = serviceBlock(compose, 'storage-cleanup');
    for (const block of [app, worker, cleanup]) {
      for (const setting of storageEnvironment) expect(block).toContain(setting);
    }
    expect(app).toContain('./.data/storage-publication:/var/lib/pale-orbit/publication:ro');
    expect(worker).toContain('./.data/storage-publication:/var/lib/pale-orbit/publication');
    expect(cleanup).toContain('./.data/storage-publication:/var/lib/pale-orbit/publication');
  });

  it('documents only the routed storage settings in the environment template', () => {
    const example = source('.env.example');
    expect(example).toContain('STORAGE_STAGING_ROOT=.data/storage-staging');
    expect(example).toContain('STORAGE_PUBLICATION_ROOT=.data/storage-publication');
    expect(example).toContain('STORAGE_COVERS_ROOT=.data/storage-covers');
    expect(example).not.toContain('STORAGE_LOCAL_ROOT');
  });

  it('documents the generation-aware derived-key rollout without requiring a legacy backfill', () => {
    const runbook = source('docs/storage-ingestion-and-publication.md');

    expect(runbook).toContain(
      '`derived/v1/generations/<canonical 0..2147483647>/<class>/<uuid>.webp`'
    );
    expect(runbook).toContain('`derived/v1/<class>/<uuid>.webp`');
    expect(runbook).toContain('no backfill');
    expect(runbook).toContain('protects an active legacy derived key conservatively');
    expect(runbook).toContain('exact revision ID and generation');
  });

  it('requires an explicit writer-quiescence attestation for every cleanup apply', () => {
    const runbook = source('docs/storage-ingestion-and-publication.md');
    const runtime = source('docs/runtime-environments.md');
    const packageConfiguration = JSON.parse(source('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(packageConfiguration.scripts['storage:cleanup:apply']).toBe(
      'node --env-file-if-exists=.env --import tsx src/cleanup-storage.ts --apply --writers-quiesced'
    );
    for (const document of [runbook, runtime]) {
      expect(document).toContain('--apply --writers-quiesced');
      expect(document).not.toMatch(/cleanup-storage\.js --apply(?:\r?\n|$)/u);
    }
    expect(runbook).toContain(
      'docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup'
    );
    expect(runbook).toContain(
      'docker compose --file compose.prod.yaml --profile tools ps --all app worker storage-cleanup'
    );
    for (const path of ['staging', 'publication', 'covers']) {
      expect(runbook).toContain(
        `docker ps --all --filter volume=/var/lib/pale-orbit/${path}`
      );
    }
    expect(runbook).toContain("inspect every all-state container's `.Mounts[].Source`");
    expect(runbook).toContain('three resolved `.data` paths');
    for (const document of [runbook, runtime]) {
      for (const volume of ['book_staging', 'book_publication', 'book_covers']) {
        expect(document).toContain(`docker ps --all --filter volume=<project>_${volume}`);
      }
    }
    expect(runbook).toContain('all-state consumer check');
  });

  it('keeps owned production smoke and fixture-probe resources on the three-root topology', () => {
    const smoke = source('scripts/plan6b-production-smoke.ts');
    const fixture = source('scripts/plan6b-fixture-runtime-probe.ts');
    for (const storageSource of [smoke, fixture]) {
      expect(storageSource).toContain('book_staging');
      expect(storageSource).toContain('book_publication');
      expect(storageSource).toContain('book_covers');
      expect(storageSource).not.toContain('STORAGE_LOCAL_ROOT');
    }
    expect(fixture).toContain('book_publication:/var/lib/pale-orbit/publication:ro');
    expect(fixture).toContain('book_publication:/var/lib/pale-orbit/publication');
  });

  it('documents a fail-closed legacy-volume migration with explicit rollback and disposition', () => {
    const runbook = source('docs/storage-ingestion-and-publication.md');
    for (const expected of [
      '## Split-volume upgrade',
      'docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup',
      'STORAGE_MIGRATION_HELPER_IMAGE',
      '@sha256:',
      'npm run storage:migrate-volumes',
      'book_storage',
      'book_staging',
      'book_publication',
      'book_covers',
      'No running or stopped container may mount the legacy or any new exact storage volume during migration.',
      'count, byte, and SHA-256',
      'rollback',
      'legacy volume untouched'
    ]) expect(runbook).toContain(expected);
    expect(runbook).toMatch(/new volumes[^.]*empty/iu);
    expect(runbook).toMatch(/app and worker[^.]*stopped/iu);
  });

  it('gates canonical production cleanup and startup on the legacy split-volume migration', () => {
    for (const path of [
      'docs/database-and-workers.md',
      'docs/runtime-environments.md'
    ]) {
      const document = source(path);
      const sectionStart = document.indexOf(
        path.endsWith('database-and-workers.md')
          ? '## Production deployment order'
          : '## Production baseline'
      );
      const section = document.slice(sectionStart);
      const provision = section.indexOf('run --rm database-role-provision');
      const split = section.indexOf('npm run storage:migrate-volumes');
      const cleanup = section.indexOf('run --rm storage-cleanup');
      const startup = section.indexOf('up --detach --wait');

      expect(sectionStart, path).toBeGreaterThan(-1);
      expect(split, path).toBeGreaterThan(provision);
      expect(cleanup, path).toBeGreaterThan(split);
      expect(startup, path).toBeGreaterThan(cleanup);
      expect(section, path).toMatch(/already-split[^.]*verified/iu);
      expect(section, path).toMatch(
        /brand-new[^.]*legacy[^.]*absent[^.]*no storage-referencing/iu
      );
      expect(section, path).toMatch(/must not[^.]*storage-cleanup[^.]*migration report/iu);
    }
  });

  it('documents one atomic DB-plus-three-volume bundle verified before readiness', () => {
    const document = source('docs/storage-ingestion-and-publication.md');
    const runbook = document.slice(
      document.indexOf('## Current atomic split-volume backup and restore'),
      document.indexOf('## Coordinated backup')
    );
    for (const expected of [
      '## Current atomic split-volume backup and restore',
      'No running or stopped container may mount',
      'database.dump',
      'staging.tar.gz',
      'staging.manifest.json',
      'publication.tar.gz',
      'publication.manifest.json',
      'covers.tar.gz',
      'covers.manifest.json',
      'backup-bundle.json',
      'STORAGE_BACKUP_HELPER_IMAGE',
      'npm run deployment:checkpoint -- capture',
      'npm run deployment:checkpoint -- rehearse'
    ]) expect(runbook).toContain(expected);
    expect(runbook).not.toContain('npm run storage:backup-volumes');
    expect(runbook).not.toContain('npm run backup:bundle');
    expect(runbook).toMatch(
      /proves every restored database reference[^.]*checks maintenance liveness\/readiness only after/iu
    );
    expect(runbook).toMatch(/scratch[^.]*health[^.]*non-authoritative/iu);
    expect(runbook).toMatch(/archive[^.]*live volume[^.]*equality/iu);
    expect(runbook).toMatch(/restored volume[^.]*manifest[^.]*equality/iu);
  });

  it('composes all six financial administrator executors only in the worker root', () => {
    const worker = source('src/worker.ts');
    const web = source('src/hooks.server.ts');
    const webRuntimeSources = [
      resolve('src/hooks.server.ts'),
      ...runtimeSourceFiles('src/routes'),
      ...runtimeSourceFiles('src/lib/components/admin')
    ];
    const refundRouteReachableExecutorModules = [
      'src/lib/server/commerce/financial/refund-review/finalize.ts',
      'src/lib/server/commerce/financial/refund-review/corrections.ts',
      'src/lib/server/commerce/financial/refund-review/recovery.ts'
    ];
    const webRuntimeGraph = runtimeValueImportGraph(webRuntimeSources);

    for (const expected of [
      'createFinancialAdminCommandExecutors',
      'createFinancialAdminCommandHandler',
      'FINANCIAL_ADMIN_COMMAND_JOB',
      'executeRefundDraftSave',
      'executeRefundDraftDiscard',
      'executeRefundAllocationFinalize',
      'executeReportingCorrectionCreate',
      'executeAdministrativeRecoveryActivate',
      'executeAdministrativeRecoveryDeactivate'
    ]) {
      expect(worker).toContain(expected);
      expect(web).not.toContain(expected);
    }

    expect(worker.match(/createFinancialAdminCommandExecutors\s*\(/gu)).toHaveLength(1);
    expect(worker.match(/createFinancialAdminCommandHandler\s*\(/gu)).toHaveLength(1);
    for (const [dependency, executor] of [
      ['refundDraftSave', 'executeRefundDraftSave'],
      ['refundDraftDiscard', 'executeRefundDraftDiscard'],
      ['refundAllocationFinalize', 'executeRefundAllocationFinalize'],
      ['refundReportingCorrectionCreate', 'executeReportingCorrectionCreate'],
      ['administrativeRecoveryActivate', 'executeAdministrativeRecoveryActivate'],
      ['administrativeRecoveryDeactivate', 'executeAdministrativeRecoveryDeactivate']
    ] as const) {
      expect(worker).toMatch(
        new RegExp(`${dependency}:\\s*${executor}\\s+as\\s+FinancialAdminCommandExecutor`, 'u')
      );
    }
    expect(worker).toMatch(
      /\[FINANCIAL_ADMIN_COMMAND_JOB,\s*financialAdminCommandHandler\]/u
    );
    expect(web).not.toMatch(/financial-admin-command|DATABASE_WORKER|financial_worker/iu);

    for (const path of webRuntimeSources) {
      const runtimeSource = source(path);
      const forbiddenMatch = runtimeSource.match(
        /admin-commands\/(?:executors|handler)|createFinancialAdminCommandExecutors|createFinancialAdminCommandHandler|FINANCIAL_ADMIN_COMMAND_JOB|executeRefundDraftSave|executeRefundDraftDiscard|executeRefundAllocationFinalize|executeReportingCorrectionCreate|executeAdministrativeRecoveryActivate|executeAdministrativeRecoveryDeactivate|financialAdminLeaseCapability|DATABASE_WORKER|pale_orbit_financial_worker/iu
      )?.[0] ?? null;
      expect(forbiddenMatch, relative(process.cwd(), path)).toBeNull();
    }

    for (const path of [
      'src/lib/server/commerce/financial/admin-commands/handler.ts',
      'src/lib/server/commerce/financial/admin-commands/executors.ts'
    ]) {
      const resolvedPath = resolve(path);
      expect(
        webRuntimeGraph.files.has(resolvedPath),
        webRuntimeGraph.chainTo(resolvedPath)
      ).toBe(false);
    }
    expect(webRuntimeGraph.files.has(resolve(
      'src/lib/server/commerce/financial/admin-commands/errors.ts'
    ))).toBe(true);

    for (const path of refundRouteReachableExecutorModules) {
      expect(webRuntimeGraph.files.has(resolve(path)), path).toBe(true);
      const moduleSource = source(path);
      const valueImportSource = moduleSource.replace(
        /import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?/gu,
        ''
      );
      expect(valueImportSource, path).not.toMatch(
        /from\s+['"]\$lib\/server\/commerce\/financial\/admin-commands\/(?:handler|executors)['"]/u
      );
      expect(moduleSource, path).toContain(
        "from '$lib/server/commerce/financial/admin-commands/errors'"
      );
      expect(moduleSource, path).toMatch(
        /import\s+type\s+\{\s*FinancialAdminCommandExecutorContext\s*\}\s+from\s+['"]\$lib\/server\/commerce\/financial\/admin-commands\/handler['"]/u
      );
    }
  }, 30_000);
});
