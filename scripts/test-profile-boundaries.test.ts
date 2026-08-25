import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function source(relativePath: string): string {
  const path = resolve(repositoryRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n?/gu, '\n') : '';
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

function runtimeModuleSpecifiers(path: string, contents: string): readonly string[] {
  const specifiers = new Set<string>();
  const syntax = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.importClause === undefined || !node.importClause.isTypeOnly)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return [...specifiers].sort();
}

const packageManifest = JSON.parse(source('package.json')) as {
  readonly scripts: Readonly<Record<string, string>>;
};
const unitConfigSource = source('vitest.config.ts');
const serviceConfigSource = source('vitest.service.config.ts');
const commerceOperationsTestSource = source('scripts/commerce-operations.test.ts');
const serviceTestSource = source('tests/service/financial-restore-witness.test.ts');
const financialWitnessHarnessSource = source('scripts/financial-restore-witness-harness.ts');
const productionSmokeTestSource = source('scripts/plan6b-production-smoke.test.ts');
const productionSmokeTestRuntimeModules = runtimeModuleSpecifiers(
  'scripts/plan6b-production-smoke.test.ts',
  productionSmokeTestSource
);
const readmeSource = source('README.md');
const databaseAndWorkersSource = source('docs/database-and-workers.md');

describe('test profile boundaries', () => {
  it('pins the four public test commands and release-gate order', () => {
    expect(packageManifest.scripts.test).toBe('vitest run --config vitest.config.ts');
    expect(packageManifest.scripts['test:unit']).toBe(
      'vitest run --config vitest.config.ts'
    );
    expect(packageManifest.scripts['test:service']).toBe(
      'vitest run --config vitest.service.config.ts'
    );
    expect(packageManifest.scripts['test:watch']).toBe('vitest --config vitest.config.ts');
    expect(packageManifest.scripts.verify).toBe(
      'npm run check && npm run lint && npm run test:unit && npm run test:service && npm run test:database && npm run build'
    );

    const verifySteps = packageManifest.scripts.verify.split(' && ');
    expect(occurrences(packageManifest.scripts.verify, 'npm run test:service')).toBe(1);
    expect(verifySteps.indexOf('npm run test:service')).toBeGreaterThan(
      verifySteps.indexOf('npm run test:unit')
    );
    expect(verifySteps.indexOf('npm run test:service')).toBeLessThan(
      verifySteps.indexOf('npm run test:database')
    );
  });

  it('does not rewrite existing database, browser, or upgrade commands', () => {
    expect(packageManifest.scripts['test:integration:raw']).toBe(
      'vitest run --config vitest.integration.config.ts'
    );
    expect(packageManifest.scripts['test:integration']).toBe(
      'tsx scripts/with-test-database.ts npm run test:integration:raw'
    );
    expect(packageManifest.scripts['test:plan6b-upgrade']).toBe(
      'tsx scripts/with-plan6b-upgrade-database.ts --phase-command tsx tests/integration/financial-migration.test.ts'
    );
    expect(packageManifest.scripts['test:e2e:raw']).toBe('playwright test');
    expect(packageManifest.scripts['test:e2e']).toBe(
      'tsx scripts/with-test-database.ts --worker --bootstrap-admin npm run test:e2e:raw'
    );
    expect(packageManifest.scripts['test:database']).toBe(
      'npm run test:integration && npm run test:e2e'
    );
  });

  it('keeps unit discovery hermetic and service discovery singular and serial', () => {
    expect(unitConfigSource).toContain(
      "include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']"
    );
    expect(unitConfigSource).toContain("exclude: ['tests/service/**/*.test.ts']");
    expect(serviceConfigSource).toContain(
      "include: ['tests/service/financial-restore-witness.test.ts']"
    );
    expect(serviceConfigSource).toContain("environment: 'node'");
    expect(serviceConfigSource).toContain('fileParallelism: false');
    expect(serviceConfigSource).toContain('maxWorkers: 1');
    expect(serviceConfigSource).toContain('clearMocks: true');
    expect(serviceConfigSource).toContain('restoreMocks: true');
    expect(serviceConfigSource).not.toContain('tests/integration');
    expect(serviceConfigSource).not.toContain('tests/e2e');
    expect(serviceConfigSource).not.toContain('upgrade');
    expect(serviceConfigSource).not.toContain('smoke');
    expect(serviceConfigSource).not.toContain("include: ['tests/service/**/*.test.ts']");
  });

  it('keeps production smoke tests from directly importing live socket runtimes', () => {
    expect(productionSmokeTestRuntimeModules).not.toContain('node:net');
    expect(productionSmokeTestRuntimeModules).not.toContain('node:dgram');
  });

  it('places the one active PostgreSQL invocation only in the service test', () => {
    const activeInvocation = 'await runBoundedFinancialWitnessHarness()';
    expect(occurrences(commerceOperationsTestSource, activeInvocation)).toBe(0);
    expect(occurrences(serviceTestSource, activeInvocation)).toBe(1);
    expect(serviceTestSource).toContain(
      'executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL'
    );
    expect(serviceTestSource).toContain('financialWitnessTestTimeoutMs');
  });

  it('retains the bounded supervisor and exact cleanup safeguards', () => {
    for (const safeguard of [
      'const financialWitnessHarnessTimeoutMs = 1_200_000',
      'npm_execpath is required for the direct Node test-database harness',
      'terminateFinancialWitnessHarnessProcessTree',
      "'down', '--volumes', '--remove-orphans'",
      'pale-orbit-test-[0-9a-f]{16}',
      'pale-orbit-test-storage-',
      'exactNewFinancialHarnessProject',
      'exactNewFinancialHarnessStorageDirectory',
      'assertFinancialHarnessProjectOwned'
    ]) {
      expect(financialWitnessHarnessSource, safeguard).toContain(safeguard);
    }
  });

  it('documents the explicit service lane without folding it into test:database', () => {
    const qualityGates = readmeSource.match(
      /Quality gates:[\s\S]*?```powershell\n([\s\S]*?)\n```/u
    )?.[1] ?? '';
    expect(qualityGates.indexOf('npm run test:service')).toBeGreaterThan(
      qualityGates.indexOf('npm run test:unit')
    );
    expect(qualityGates.indexOf('npm run test:service')).toBeLessThan(
      qualityGates.indexOf('npm run test:integration')
    );
    for (const boundary of [
      '`npm test`, `npm run test:unit`, and `npm run test:watch` are hermetic',
      '`npm run test:service`',
      'does not include `npm run test:service`',
      'check -> lint -> unit -> service -> integration/E2E -> build',
      'npm_execpath',
      'bounded supervisor'
    ]) {
      expect(databaseAndWorkersSource, boundary).toContain(boundary);
    }
  });
});
