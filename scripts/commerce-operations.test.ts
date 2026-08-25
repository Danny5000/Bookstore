import { readFile, readdir } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertFinancialHarnessProjectOwned,
  exactNewFinancialHarnessProject,
  exactNewFinancialHarnessStorageDirectory,
  financialWitnessHarnessTimeoutMs,
  financialWitnessTestTimeoutMs,
  ownerRestoreVerifierLauncher,
  restoreVerifierWitnessPath,
  runBoundedFinancialWitnessHarness,
  waitForFinancialWitnessHarnessClose,
  type FinancialHarnessDockerResource,
  type FinancialWitnessHarnessClose
} from './financial-restore-witness-harness';

const root = new URL('../', import.meta.url);
const executeFile = promisify(execFile);
const stripePreflightPath = fileURLToPath(
  new URL('./stripe-secret-preflight.mjs', import.meta.url)
);
function runStripePreflight(overrides: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env };
  delete environment.STRIPE_SECRET_KEY;
  delete environment.STRIPE_WEBHOOK_SECRET;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return spawnSync(process.execPath, [stripePreflightPath], {
    encoding: 'utf8',
    env: environment
  });
}

function documentedPosixPreflight(runbook: string): string {
  const script = runbook.match(
    /On a Docker-only Linux VPS[\s\S]*?```sh\r?\n(?<script>[\s\S]*?)\r?\n```/u
  )?.groups?.script;
  if (!script) throw new Error('Documented POSIX Stripe preflight was not found');
  return script;
}

function posixShellPath(): string {
  if (process.platform !== 'win32') return '/bin/sh';
  const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (gitExecPath.status !== 0 || !gitExecPath.stdout.trim()) {
    throw new Error('Git for Windows is required to exercise the documented POSIX preflight');
  }
  const gitRoot = dirname(dirname(dirname(gitExecPath.stdout.trim())));
  return join(gitRoot, 'bin', 'sh.exe');
}

function runDocumentedPosixPreflight(script: string, overrides: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env };
  delete environment.STRIPE_SECRET_KEY;
  delete environment.STRIPE_WEBHOOK_SECRET;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return spawnSync(posixShellPath(), ['-s'], {
    encoding: 'utf8',
    env: environment,
    input: script
  });
}

interface ComposeService {
  environment?: Record<string, string>;
  secrets?: Array<{ source: string; target: string }>;
}

interface ComposeConfiguration {
  services: Record<string, ComposeService>;
  secrets: Record<string, { environment: string }>;
}

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

interface MigrationJournal {
  readonly entries: readonly {
    readonly idx: number;
    readonly tag: string;
  }[];
}

async function protectedPlan6bMigrationFiles(): Promise<string[]> {
  const journal = JSON.parse(
    await source('drizzle/meta/_journal.json')
  ) as MigrationJournal;
  return journal.entries
    .filter((entry) => entry.idx >= 7)
    .sort((left, right) => left.idx - right.idx)
    .map((entry) => `${entry.tag}.sql`);
}

function quotedSqlIdentifiers(value: string | undefined): string[] {
  return Array.from(
    value?.matchAll(/'(?<value>[a-z][a-z0-9_]*)'/gu) ?? [],
    (match) => match.groups?.value ?? ''
  ).filter(Boolean);
}

function migrationFinancialIssuePairs(migration: string): string[] {
  const expression = migration.match(
    /add constraint "financial_reconciliation_issues_semantic_identity" check \((?<expression>[\s\S]*?)\);--> statement-breakpoint/iu
  )?.groups?.expression;
  if (!expression) throw new Error('Financial issue semantic identity constraint was not found');
  const pairs = Array.from(
    expression.matchAll(
      /"financial_reconciliation_issues"\."resource_type"\s*(?:in\s*\((?<resources>[^)]*)\)|=\s*'(?<resource>[a-z][a-z0-9_]*)')\s+and\s+"financial_reconciliation_issues"\."safe_code"\s*(?:in\s*\((?<codes>[^)]*)\)|=\s*'(?<code>[a-z][a-z0-9_]*)')/giu
    ),
    (match) => {
      const resources = match.groups?.resource
        ? [match.groups.resource]
        : quotedSqlIdentifiers(match.groups?.resources);
      const codes = match.groups?.code
        ? [match.groups.code]
        : quotedSqlIdentifiers(match.groups?.codes);
      return resources.flatMap((resource) => codes.map((code) => `${resource}:${code}`));
    }
  ).flat();
  return [...new Set(pairs)].sort();
}

function expectedFinancialIssueTriples(pairs: readonly string[]): string[] {
  return pairs.map((pair) => {
    const safeCode = pair.slice(pair.indexOf(':') + 1);
    const impact = ['allocation_incomplete', 'missing_source'].includes(safeCode)
      ? 'pending'
      : 'exception';
    return `${pair}:${impact}`;
  }).sort();
}

function verifierFinancialIssueTriples(sql: string): string[] {
  const values = sql.match(
    /allowed_issue_triples\s*\(\s*resource_type\s*,\s*safe_code\s*,\s*impact\s*\)\s+as\s*\(\s*values(?<values>[\s\S]*?)\r?\n\s*\),\s*orphan_counts\s+as\s*\(/iu
  )?.groups?.values ?? '';
  const triples = Array.from(
    values.matchAll(
      /\(\s*'(?<resource>[a-z][a-z0-9_]*)'\s*,\s*'(?<code>[a-z][a-z0-9_]*)'\s*,\s*'(?<impact>[a-z][a-z0-9_]*)'\s*\)/gu
    ),
    (match) => `${match.groups?.resource}:${match.groups?.code}:${match.groups?.impact}`
  );
  return [...new Set(triples)].sort();
}

function legacyCommerceWorkerIssuePairs(sql: string): string[] {
  const values = sql.match(
    /legacy_commerce_worker_issue_pairs\s*\(\s*resource_type\s*,\s*safe_code\s*\)\s+as\s*\(\s*values(?<values>[\s\S]*?)\r?\n\s*\),\s*canonical_resolved_audits\s+as\s*\(/iu
  )?.groups?.values ?? '';
  const pairs = Array.from(
    values.matchAll(
      /\(\s*'(?<resource>[a-z][a-z0-9_]*)'\s*,\s*'(?<code>[a-z][a-z0-9_]*)'\s*\)/gu
    ),
    (match) => `${match.groups?.resource}:${match.groups?.code}`
  );
  return [...new Set(pairs)].sort();
}

function markdownSection(document: string, heading: string): string {
  const marker = `## ${heading}`;
  const markerIndex = document.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Markdown section not found: ${heading}`);
  const contentStart = markerIndex + marker.length;
  const nextHeading = document.slice(contentStart).search(/^## /mu);
  return nextHeading === -1
    ? document.slice(contentStart)
    : document.slice(contentStart, contentStart + nextHeading);
}

function fencedBlockAfter(
  section: string,
  introduction: string,
  language: 'powershell' | 'sh'
): string {
  const introductionIndex = section.indexOf(introduction);
  if (introductionIndex === -1) {
    throw new Error(`Documented code block introduction not found: ${introduction}`);
  }
  const block = section
    .slice(introductionIndex)
    .match(new RegExp(`\`\`\`${language}\\r?\\n(?<script>[\\s\\S]*?)\\r?\\n\`\`\``, 'u'))
    ?.groups?.script;
  if (!block) throw new Error(`Documented ${language} block not found after: ${introduction}`);
  return block;
}

function fencedCodeBlocks(section: string, language: 'powershell' | 'sh'): string[] {
  return Array.from(
    section.matchAll(
      new RegExp(`\`\`\`${language}\\r?\\n(?<script>[\\s\\S]*?)\\r?\\n\`\`\``, 'gu')
    ),
    (match) => match.groups?.script ?? ''
  );
}

function documentedPowerShellFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name} {`);
  if (start === -1) throw new Error(`Documented PowerShell function not found: ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < script.length; index += 1) {
    if (script[index] === '{') {
      depth += 1;
      opened = true;
    } else if (script[index] === '}') {
      depth -= 1;
      if (opened && depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error(`Documented PowerShell function is unterminated: ${name}`);
}

function documentedFinancialPosixFunctions(script: string, nextFunction: string): string {
  const start = script.indexOf('canonicalize_financial_operational_diagnostics() {');
  const end = script.indexOf(`${nextFunction}() {`, start);
  if (start === -1 || end === -1) {
    throw new Error('Documented POSIX financial diagnostic functions were not found');
  }
  return script.slice(start, end);
}

function expectNativeCommandsFailClosed(script: string): void {
  const lines = script.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (
      !/^\s*(?:&\s*|(?:\$\w+\s*=\s*)?@\(\s*&?\s*)?(?:docker|icacls\.exe)\b/iu.test(
        line
      )
    ) continue;
    const nextLine = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0);
    expect(nextLine?.trim(), `native command lacks fail-closed assertion: ${line.trim()}`).toMatch(
      /^Assert-NativeSuccess\b/u
    );
  }
}

async function composeConfiguration(...files: string[]): Promise<ComposeConfiguration> {
  const arguments_ = [
    ...files.flatMap((file) => ['--file', file]),
    '--profile',
    'tools'
  ];
  const { stdout } = await executeFile(
    'docker',
    ['compose', ...arguments_, 'config', '--format', 'json'],
    {
      cwd: new URL('.', root),
      env: {
        ...process.env,
        APP_IMAGE: 'registry.invalid/pale-orbit@sha256:validation-only',
        ORIGIN: 'https://bookstore.invalid',
        DATABASE_NAME: 'validation_database',
        DATABASE_OWNER_USER: 'validation_owner',
        DATABASE_USER: 'validation_web',
        DATABASE_WORKER_USER: 'validation_worker',
        DATABASE_STORAGE_CLEANUP_USER: 'validation_storage_cleanup',
        SMTP_HOST: 'smtp.invalid',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
        SMTP_REQUIRE_TLS: 'true',
        SMTP_USER: 'validation_user',
        SMTP_FROM: 'Validation <noreply@bookstore.invalid>',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@bookstore.invalid',
        BOOTSTRAP_ADMIN_NAME: 'Validation Administrator',
        SITE_ADDRESS: 'bookstore.invalid',
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: undefined
      }
    }
  );
  return JSON.parse(stdout) as ComposeConfiguration;
}

function mountedSecretSources(service: ComposeService): string[] {
  return (service.secrets ?? []).map((secret) => secret.source).sort();
}

describe('commerce operations contract', () => {
  it.each([
    ['missing secret key', { STRIPE_WEBHOOK_SECRET: 'whsec_private_webhook_value' }],
    ['missing webhook secret', { STRIPE_SECRET_KEY: 'sk_test_private_key_value' }],
    ['empty secret key', {
      STRIPE_SECRET_KEY: '   ',
      STRIPE_WEBHOOK_SECRET: 'whsec_private_webhook_value'
    }],
    ['empty webhook secret', {
      STRIPE_SECRET_KEY: 'sk_test_private_key_value',
      STRIPE_WEBHOOK_SECRET: ''
    }]
  ] as const)('rejects %s without printing either credential', (_label, environment) => {
    const result = runStripePreflight(environment);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('[stripe-preflight] required Stripe credentials are missing or empty');
    expect(output).not.toContain('sk_test_private_key_value');
    expect(output).not.toContain('whsec_private_webhook_value');
  });

  it('accepts both non-empty credentials without printing their values', () => {
    const result = runStripePreflight({
      STRIPE_SECRET_KEY: 'sk_test_private_key_value',
      STRIPE_WEBHOOK_SECRET: 'whsec_private_webhook_value'
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain('[stripe-preflight] required Stripe credentials are present');
    expect(output).not.toContain('sk_test_private_key_value');
    expect(output).not.toContain('whsec_private_webhook_value');
  });

  it('executes the exact documented POSIX fallback for missing, blank, and present values', async () => {
    const script = documentedPosixPreflight(await source('docs/commerce-and-guest-claims.md'));
    const scenarios = [
      ['both missing', {}, 1],
      ['empty secret key', {
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: 'whsec_private_webhook_value'
      }, 1],
      ['empty webhook secret', {
        STRIPE_SECRET_KEY: 'sk_test_private_key_value',
        STRIPE_WEBHOOK_SECRET: ''
      }, 1],
      ['whitespace secret key', {
        STRIPE_SECRET_KEY: ' \t ',
        STRIPE_WEBHOOK_SECRET: 'whsec_private_webhook_value'
      }, 1],
      ['whitespace webhook secret', {
        STRIPE_SECRET_KEY: 'sk_test_private_key_value',
        STRIPE_WEBHOOK_SECRET: ' \t '
      }, 1],
      ['both present', {
        STRIPE_SECRET_KEY: 'sk_test_private_key_value',
        STRIPE_WEBHOOK_SECRET: 'whsec_private_webhook_value'
      }, 0]
    ] as const;

    for (const [name, environment, expectedStatus] of scenarios) {
      const result = runDocumentedPosixPreflight(script, environment);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, name).toBe(expectedStatus);
      expect(output, name).not.toContain('sk_test_private_key_value');
      expect(output, name).not.toContain('whsec_private_webhook_value');
    }
  });

  it('keeps every production application process disabled and maintenance-only', async () => {
    const compose = await composeConfiguration('compose.prod.yaml');
    for (const name of ['app', 'worker']) {
      expect(compose.services[name]?.environment, name).toMatchObject({
        APPLICATION_MODE: 'maintenance',
        STRIPE_ENABLED: 'false',
        STRIPE_TEST_FIXTURE_MODE: 'false',
        STRIPE_LIVE_MODE: 'false',
        STRIPE_CHECKOUT_DURATION_SECONDS: '1800',
        STRIPE_WEBHOOK_TOLERANCE_SECONDS: '300',
        COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS: '60',
        COMMERCE_CHECKOUT_RATE_LIMIT_MAX: '5'
      });
    }
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.environment?.STRIPE_ENABLED !== undefined) {
        expect(service.environment, name).toMatchObject({
          STRIPE_ENABLED: 'false',
          STRIPE_TEST_FIXTURE_MODE: 'false',
          STRIPE_LIVE_MODE: 'false'
        });
      }
      expect(service.environment, name).not.toHaveProperty('STRIPE_SECRET_KEY');
      expect(service.environment, name).not.toHaveProperty('STRIPE_WEBHOOK_SECRET');
      expect(service.environment, name).not.toHaveProperty('STRIPE_SECRET_KEY_FILE');
      expect(service.environment, name).not.toHaveProperty('STRIPE_WEBHOOK_SECRET_FILE');
    }
  });

  it('publishes one exact stage-aware Plan 6B release command and migration identity boundary', async () => {
    const [packageText, smokeSource, fixtureSource, { DEPLOYMENT_BACKUP_ARTIFACTS }] =
      await Promise.all([
        source('package.json'),
        source('scripts/plan6b-production-smoke.ts'),
        source('scripts/plan6b-fixture-runtime-probe.ts'),
        import('./deployment-backup-bundle')
      ]);
    const packageManifest = JSON.parse(packageText) as { scripts: Record<string, string> };
    const production = await composeConfiguration('compose.prod.yaml');
    const migrationIdentityNames = [
      'DATABASE_MIGRATION_WEB_USER',
      'DATABASE_MIGRATION_WORKER_USER',
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER'
    ] as const;

    expect(packageManifest.scripts['smoke:plan6b'])
      .toBe('node --import tsx scripts/plan6b-production-smoke.ts');
    expect(packageManifest.scripts['smoke:plan6b-fixture'])
      .toBe('node --import tsx scripts/plan6b-fixture-runtime-probe.ts');
    expect(Object.hasOwn(packageManifest.scripts, 'smoke:plan6b-i')).toBe(false);
    expect(Object.keys(packageManifest.scripts)
      .filter((key) => key.startsWith('smoke:plan6b'))
      .sort()).toEqual(['smoke:plan6b', 'smoke:plan6b-fixture']);

    expect(smokeSource).toContain("export type Plan6bSmokeStage = '6b-ii'");
    expect(fixtureSource).toContain("const FIXTURE_STAGE = '6b-ii'");
    expect(smokeSource).not.toMatch(/plan6b-i-(?:smoke|fixture)-/u);
    expect(fixtureSource).not.toMatch(/plan6b-i-(?:smoke|fixture)-/u);

    expect(production.services.migrate?.environment).toMatchObject({
      DATABASE_MIGRATION_WEB_USER: 'validation_web',
      DATABASE_MIGRATION_WORKER_USER: 'validation_worker',
      DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'validation_storage_cleanup'
    });
    expect(production.services.migrate?.environment).not.toHaveProperty('DATABASE_PASSWORD');
    for (const [name, service] of Object.entries(production.services)) {
      if (name === 'migrate') continue;
      for (const identityName of migrationIdentityNames) {
        expect(service.environment, name).not.toHaveProperty(identityName);
      }
    }

    expect(DEPLOYMENT_BACKUP_ARTIFACTS).toHaveLength(14);
  });

  it('scopes Stripe API and webhook secrets to their exact app and worker consumers', async () => {
    const baseline = await composeConfiguration('compose.prod.yaml');
    const merged = await composeConfiguration('compose.prod.yaml', 'compose.stripe.yaml');
    const stripeServices = ['app', 'worker'];
    expect(Object.entries(merged.services)
      .filter(([, service]) => service.environment?.STRIPE_ENABLED === 'true')
      .map(([name]) => name)
      .sort()).toEqual(stripeServices);
    expect(Object.entries(merged.services)
      .filter(([, service]) => service.environment?.STRIPE_SECRET_KEY_FILE !== undefined)
      .map(([name]) => name)
      .sort()).toEqual(stripeServices);
    expect(Object.entries(merged.services)
      .filter(([, service]) => service.environment?.STRIPE_WEBHOOK_SECRET_FILE !== undefined)
      .map(([name]) => name)
      .sort()).toEqual(['app']);
    expect(Object.entries(merged.services)
      .filter(([, service]) => mountedSecretSources(service).includes('stripe_secret_key'))
      .map(([name]) => name)
      .sort()).toEqual(stripeServices);
    expect(Object.entries(merged.services)
      .filter(([, service]) => mountedSecretSources(service).includes('stripe_webhook_secret'))
      .map(([name]) => name)
      .sort()).toEqual(['app']);
    for (const name of stripeServices) {
      expect(merged.services[name]?.environment, name).toMatchObject({
        APPLICATION_MODE: 'maintenance',
        STRIPE_ENABLED: 'true',
        STRIPE_TEST_FIXTURE_MODE: 'false',
        STRIPE_LIVE_MODE: 'false',
        STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe_secret_key'
      });
      expect(mountedSecretSources(merged.services[name]!)).toEqual(name === 'app' ? [
        'auth_secret',
        'database_password',
        'stripe_secret_key',
        'stripe_webhook_secret'
      ] : [
        'auth_secret',
        'database_worker_password',
        'smtp_password',
        'stripe_secret_key'
      ]);
    }
    expect(merged.services.app?.environment).toHaveProperty(
      'STRIPE_WEBHOOK_SECRET_FILE',
      '/run/secrets/stripe_webhook_secret'
    );
    expect(merged.services.worker?.environment).not.toHaveProperty('STRIPE_WEBHOOK_SECRET_FILE');
    for (const name of ['migrate', 'bootstrap-admin', 'storage-cleanup', 'caddy', 'postgres']) {
      expect(merged.services[name]?.environment, name).not.toHaveProperty('STRIPE_ENABLED', 'true');
      expect(merged.services[name]?.environment, name).not.toHaveProperty('STRIPE_SECRET_KEY_FILE');
      expect(merged.services[name]?.environment, name).not.toHaveProperty('STRIPE_WEBHOOK_SECRET_FILE');
      expect(mountedSecretSources(merged.services[name]!)).not.toContain('stripe_secret_key');
      expect(mountedSecretSources(merged.services[name]!)).not.toContain('stripe_webhook_secret');
    }
    for (const [name, service] of Object.entries(baseline.services)) {
      expect(
        mountedSecretSources(merged.services[name]!).filter((secret) => !secret.startsWith('stripe_')),
        name
      ).toEqual(mountedSecretSources(service));
    }
    expect(merged.secrets).toMatchObject({
      database_password: { environment: 'DATABASE_PASSWORD' },
      database_storage_cleanup_password: {
        environment: 'DATABASE_STORAGE_CLEANUP_PASSWORD'
      },
      auth_secret: { environment: 'AUTH_SECRET' },
      smtp_password: { environment: 'SMTP_PASSWORD' },
      stripe_secret_key: { environment: 'STRIPE_SECRET_KEY' },
      stripe_webhook_secret: { environment: 'STRIPE_WEBHOOK_SECRET' }
    });
  });

  it('documents safe commerce, claim, reconciliation, and manual-checkpoint operations', async () => {
    const [runbook, readme, runtime, database, authentication, library, plan] = await Promise.all([
      source('docs/commerce-and-guest-claims.md'),
      source('README.md'),
      source('docs/runtime-environments.md'),
      source('docs/database-and-workers.md'),
      source('docs/authentication-and-email.md'),
      source('docs/customer-library-and-reader.md'),
      source('docs/superpowers/plans/2026-08-10-backend-plan-6a-stripe-commerce-guest-claims.md')
    ]);
    for (const expected of [
      '2026-07-29.dahlia',
      'Tax calculated at checkout',
      'Mailpit',
      'Stripe Dashboard',
      'partial multi-title',
      'Plan 6B',
      'APPLICATION_MODE=maintenance',
      'Never paste Stripe credentials into chat'
    ]) expect(runbook).toContain(expected);
    expect(runbook).toMatch(/STRIPE_CHECKOUT_DURATION_SECONDS=1800/u);
    expect(runbook).toMatch(/STRIPE_WEBHOOK_TOLERANCE_SECONDS=300/u);
    expect(runbook).toMatch(/STRIPE_TEST_FIXTURE_MODE=false/u);
    expect(readme).toContain('docs/commerce-and-guest-claims.md');
    expect(readme).not.toContain('Checkout is not live in Plan 5');
    expect(runtime).toContain('compose.stripe.yaml');
    expect(runtime).toContain('does not verify that environment-backed secret values are present');
    expect(runbook).toContain('does not verify that environment-backed secret values are present');
    expect(database).toContain('stripe_events');
    expect(authentication).toContain('guest purchase');
    expect(library).toContain('entitlement_grants');
    expect(runbook).toContain('guest identity email plaintext');
    expect(runbook).not.toContain('guest email digests');
    expect(plan).toContain(
      'Focused route/runtime tests cover live-mode mismatch, expired or rotated order status, and disabled-Stripe 503 responses.'
    );

    const posixPreflight = documentedPosixPreflight(runbook);
    expect(posixPreflight).toContain('stripe_credential_present()');
    expect(posixPreflight).toContain('case "${1-}" in');
    expect(posixPreflight).toContain('*[![:space:]]*) return 0 ;;');
    expect(posixPreflight).toContain(
      'stripe_credential_present "${STRIPE_SECRET_KEY-}"'
    );
    expect(posixPreflight).toContain(
      'stripe_credential_present "${STRIPE_WEBHOOK_SECRET-}"'
    );
    expect(posixPreflight).not.toContain('[ -z ');
    expect(posixPreflight).not.toMatch(/printf[^\n]*\$\{?STRIPE_/u);

    const preflightCommand = 'npm run stripe:preflight';
    const overlayUpCommand =
      'docker compose --file compose.prod.yaml --file compose.stripe.yaml up --detach --wait';
    for (const [name, document] of [
      ['commerce runbook', runbook],
      ['runtime runbook', runtime]
    ] as const) {
      expect(document.indexOf(preflightCommand), name).toBeGreaterThan(-1);
      expect(document.indexOf(overlayUpCommand), name).toBeGreaterThan(
        document.indexOf(preflightCommand)
      );
    }
  });

  it('creates restrictive backup workspaces and verifies the Linux workspace identity', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const windowsWorkspace = fencedBlockAfter(
      backupSection,
      'On Windows PowerShell',
      'powershell'
    );
    const linuxWorkspace = fencedBlockAfter(
      backupSection,
      'On the GNU/Linux production VPS',
      'sh'
    );
    const integrityPowerShell = fencedCodeBlocks(integritySection, 'powershell').join('\n');
    const integrityShell = fencedCodeBlocks(integritySection, 'sh').join('\n');

    expect(windowsWorkspace).toContain('function New-RestrictedWorkspace');
    expect(windowsWorkspace).toContain('function Assert-NativeSuccess');
    expect(windowsWorkspace).toContain('$LASTEXITCODE');
    expect(windowsWorkspace).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
    expect(windowsWorkspace).toContain('/setowner');
    expect(windowsWorkspace).toContain('/inheritance:r');
    expect(windowsWorkspace).toContain('/grant:r');
    expect(windowsWorkspace).toContain('${currentIdentity}:(OI)(CI)F');
    for (const workspaceHelper of [windowsWorkspace, integrityPowerShell]) {
      const icaclsInvocations = workspaceHelper
        .split(/\r?\n/u)
        .filter((line) => line.includes('icacls.exe'));
      expect(icaclsInvocations).toHaveLength(3);
      expect(icaclsInvocations.every((line) => line.trimStart().startsWith('$null = & icacls.exe')))
        .toBe(true);
    }
    expect(windowsWorkspace).toContain('AreAccessRulesProtected');
    expect(windowsWorkspace).toContain('.Owner');
    expect(windowsWorkspace).toContain('[System.IO.FileAttributes]::ReparsePoint');
    expect(windowsWorkspace).toContain(
      'Get-ChildItem -LiteralPath $workspace -Force -ErrorAction Stop'
    );
    expect(windowsWorkspace.indexOf('function New-RestrictedWorkspace')).toBeLessThan(
      windowsWorkspace.indexOf('$backup = New-RestrictedWorkspace')
    );
    expect(linuxWorkspace).toContain('mktemp -d');
    expect(linuxWorkspace).toContain('new_restricted_workspace()');
    expect(linuxWorkspace).toContain('readlink -f');
    expect(linuxWorkspace).toContain('[ ! -L "$workspace" ]');
    expect(linuxWorkspace).toContain("stat -c '%u'");
    expect(linuxWorkspace).toContain('id -u');
    expect(linuxWorkspace).toContain("stat -c '%a'");
    expect(linuxWorkspace).toContain(
      'workspace_entries="$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)"'
    );
    expect(linuxWorkspace).toContain('workspace_entries=');
    expect(linuxWorkspace).toContain('|| return 1');
    expect(linuxWorkspace).toContain('[ -z "$workspace_entries" ]');
    expect(linuxWorkspace.indexOf('new_restricted_workspace()')).toBeLessThan(
      linuxWorkspace.indexOf('backup="$(new_restricted_workspace')
    );
    expect(integrityPowerShell).toContain('$verifiedRestore = New-RestrictedWorkspace');
    expect(integrityShell).toContain('verified_restore="$(new_restricted_workspace');
    expect(integrityPowerShell.indexOf('$verifiedRestore = New-RestrictedWorkspace')).toBeLessThan(
      integrityPowerShell.indexOf('test-decrypt $destinationCiphertext $verifiedRestore')
    );
    expect(integrityShell.indexOf('verified_restore="$(new_restricted_workspace')).toBeLessThan(
      integrityShell.indexOf('test-decrypt "$destination_ciphertext" "$verified_restore"')
    );
  });

  it('binds every production command to one validated Compose project and Docker engine', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const productionPowerShell = [backupSection, integritySection]
      .flatMap((section) => fencedCodeBlocks(section, 'powershell'))
      .join('\n');
    const productionShell = [backupSection, integritySection]
      .flatMap((section) => fencedCodeBlocks(section, 'sh'))
      .join('\n');
    const firstPowerShellMutation = productionPowerShell.indexOf('stop app worker');
    const firstShellMutation = productionShell.indexOf('compose_prod stop app worker');

    expect(productionPowerShell).toContain(
      '$project = $env:COMPOSE_PROJECT_NAME.Trim().ToLowerInvariant()'
    );
    expect(productionPowerShell).toContain("'^[a-z0-9][a-z0-9_-]*$'");
    expect(productionPowerShell).toContain('$productionDockerContext');
    expect(productionPowerShell).toContain('$productionDockerEngineId');
    expect(productionPowerShell.indexOf('APPROVED_SOURCE_DOCKER_CONTEXT')).toBeLessThan(
      firstPowerShellMutation
    );
    expect(productionPowerShell.indexOf('docker --context $sourceDockerContext info')).toBeLessThan(
      firstPowerShellMutation
    );
    for (const line of productionPowerShell.split(/\r?\n/u)) {
      if (!/\bdocker --context \$sourceDockerContext compose\b/u.test(line)) continue;
      expect(line).toContain('--project-name $project');
    }

    expect(productionShell).toContain('normalize_compose_project()');
    expect(productionShell).toContain('compose_prod()');
    expect(productionShell).toContain('source_docker compose --project-name "$project"');
    expect(productionShell).toContain('production_docker_context=');
    expect(productionShell).toContain('production_docker_engine_id=');
    expect(productionShell.indexOf('APPROVED_SOURCE_DOCKER_CONTEXT')).toBeLessThan(firstShellMutation);
    expect(productionShell.indexOf("source_docker info --format '{{.ID}}'")).toBeLessThan(
      firstShellMutation
    );

    const outsideRestore = storageRunbook.replace(restoreSection, '');
    expect(outsideRestore).not.toMatch(/^[^\n]*(?:docker compose|compose_prod)[^\n]*\bup\b[^\n]*\bworker\b/gmu);
    expect(restoreSection).not.toMatch(/^[^\n]*(?:docker compose|compose_restore)[^\n]*\bup\b[^\n]*\bworker\b/gmu);
  });

  it('cleans container dumps in finally paths and validates application RepoDigests', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const backupPowerShell = fencedCodeBlocks(backupSection, 'powershell').join('\n');
    const backupShell = fencedCodeBlocks(backupSection, 'sh').join('\n');
    const powerShellDump = backupPowerShell.indexOf('pg_dump');
    const powerShellCopy = backupPowerShell.indexOf('docker --context $sourceDockerContext cp "${postgres}:/tmp/pale-orbit.dump"');
    const powerShellFinally = backupPowerShell.indexOf('finally {');
    const powerShellCleanup = backupPowerShell.indexOf('rm -f /tmp/pale-orbit.dump');
    const shellDump = backupShell.indexOf('pg_dump');
    const shellCopy = backupShell.indexOf('source_docker cp "${postgres}:/tmp/pale-orbit.dump"');

    expect(backupPowerShell).toContain('try {');
    expect(powerShellDump).toBeGreaterThan(-1);
    expect(powerShellDump).toBeLessThan(powerShellCopy);
    expect(powerShellCopy).toBeGreaterThan(-1);
    expect(powerShellCopy).toBeLessThan(powerShellFinally);
    expect(powerShellCleanup).toBeGreaterThan(powerShellFinally);
    expect(backupPowerShell).toContain('$containerDumpCreated');
    expect(backupPowerShell).toContain('ConvertFrom-Json');
    expect(backupPowerShell).toContain("$repoDigestJson.StartsWith('[')");
    expect(backupPowerShell).toContain("$repoDigestJson.EndsWith(']')");
    expect(backupPowerShell).toContain('@sha256:[0-9a-f]{64}');
    expect(backupPowerShell).toContain('$validRepoDigests.Count -lt 1');

    expect(backupShell).toContain('cleanup_container_dump()');
    expect(backupShell).toContain("trap 'finish_source_backup");
    expect(backupShell.indexOf('container_dump_created=1')).toBeLessThan(shellDump);
    expect(shellDump).toBeLessThan(shellCopy);
    expect(shellCopy).toBeLessThan(
      backupShell.lastIndexOf('cleanup_container_dump || exit 1')
    );
    expect(backupShell).toContain("'{{range .RepoDigests}}{{println .}}{{end}}'");
    expect(backupShell).toContain('@sha256:[0-9a-f]{64}');
    expect(backupShell).toContain('[ "$repo_digest_count" -ge 1 ]');
    expect(backupShell).toContain("[ \"$application_image_json\" != null ]");
    expect(backupShell).toContain("[ \"$application_image_json\" != '[]' ]");
  });

  it('provides a fail-closed end-to-end GNU/Linux backup and restore path', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const backupShell = fencedCodeBlocks(backupSection, 'sh').join('\n');
    const integrityShell = fencedCodeBlocks(integritySection, 'sh').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');

    for (const token of [
      'pg_dump',
      'source_docker cp',
      'rm -f /tmp/pale-orbit.dump',
      'psql',
      'storage.tar.gz',
      'application-image.json',
      'backup-file-manifest.sha256',
      'sha256sum'
    ]) {
      expect(backupShell).toContain(token);
    }
    expect(backupShell).toContain('verify_source_storage_samples()');
    expect(integrityShell).toContain('verify_plaintext_set()');
    expect(integrityShell).toContain('verify_plaintext_set "$verified_restore"');
    expect(integrityShell).toContain('backup-file-manifest.sha256');

    for (const token of [
      'compose_restore()',
      'get_restore_project_inventory()',
      'assert_restore_worker_stopped()',
      'pg_restore',
      'migrate',
      'storage-cleanup',
      "fetch('http://127.0.0.1:3000'+path)",
      'down --volumes',
      'assert_restore_project_absent'
    ]) {
      expect(restoreShell).toContain(token);
    }
    expect(integrityShell).toContain('dispose_plaintext_workspace()');
    expect(integrityShell).toContain('PLAINTEXT_DISPOSITION_COMMAND');
    expect(restoreShell).toContain('restore_docker cp "$verified_restore/database.dump"');
    expect(restoreShell).toContain(
      '-v "${verified_restore}/storage.tar.gz:/backup/storage.tar.gz:ro"'
    );
    expect(restoreShell).not.toContain('restore_docker cp "$backup/database.dump"');
    expect(restoreShell.indexOf('compose_restore create app')).toBeLessThan(
      restoreShell.indexOf('-v "${restore_project}_book_storage:/restore"')
    );
    expect(restoreShell.indexOf('preflight_inventory="$(get_restore_project_inventory)"')).toBeLessThan(
      restoreShell.indexOf('compose_restore up --detach --wait postgres')
    );
    expect(restoreShell).toContain(
      'assert_restore_project_absent "$preflight_inventory" || exit 1'
    );
    expect(restoreShell.indexOf('compose_restore down --volumes')).toBeLessThan(
      restoreShell.lastIndexOf('assert_restore_project_absent')
    );
    expect(restoreShell).toContain(
      'assert_restore_project_absent "$post_teardown_inventory" || exit 1'
    );
    const restoreShellLines = restoreShell.split(/\r?\n/u).filter((line) => line.trim());
    const restoreStarts = restoreShellLines.filter((line) =>
      /^compose_restore up\b/u.test(line.trim())
    );
    expect(restoreStarts).toHaveLength(2);
    expect(restoreStarts[0]).toMatch(/\bpostgres\s*\|\|\s*exit 1$/u);
    expect(restoreStarts[1]).toMatch(/\bapp\s*\|\|\s*exit 1$/u);
    for (const command of restoreStarts) {
      expect(command).not.toMatch(/\bworker\b/u);
      const commandIndex = restoreShellLines.indexOf(command);
      expect(restoreShellLines[commandIndex - 1]?.trim()).toBe(
        'assert_restore_worker_stopped || exit 1'
      );
      expect(restoreShellLines[commandIndex + 1]?.trim()).toBe(
        'assert_restore_worker_stopped || exit 1'
      );
    }
    for (const line of [backupShell, integrityShell, restoreShell].join('\n').split(/\r?\n/u)) {
      if (!/(?:^\s*|\$\(\s*|!\s+)(?:docker|source_docker|restore_docker|compose_prod|compose_restore)\b/u.test(line)) continue;
      if (/^\s*(?:source_docker|restore_docker|compose_prod|compose_restore)\(\)\s*\{/u.test(line)) continue;
      expect(line, `POSIX native command is not fail-closed: ${line.trim()}`).toMatch(
        /(?:\|\|\s*(?:return|exit)|\|\|\s*finish_status=1|^\s*if\s+!|"\$@"\s*$)/u
      );
    }
  });

  it('ships executable deterministic row-count, storage-sample, and financial verifiers', async () => {
    const [
      rowCounts,
      storageSamples,
      financialVerifier,
      financialRunbook,
      restoreVerifierWitness
    ] = await Promise.all([
      source('scripts/capture-restore-row-counts.sql'),
      source('scripts/capture-storage-samples.sql'),
      source('scripts/verify-financial-restore.sql'),
      source('docs/stripe-financial-reconciliation.md'),
      source('scripts/execute-financial-restore-verifier.ts')
    ]);

    for (const script of [rowCounts, storageSamples, financialVerifier]) {
      expect(script).toMatch(/^\\set ON_ERROR_STOP on$/mu);
      expect(script).toMatch(/set transaction read only/iu);
      expect(script).toMatch(/set local search_path = pg_catalog, public, drizzle/iu);
    }
    expect(rowCounts).toContain("n.nspname in ('public', 'drizzle')");
    expect(rowCounts).toContain("c.relkind in ('r', 'p')");
    expect(rowCounts).toContain('format(\'select count(*) from %I.%I\'');
    expect(rowCounts).toContain('copy (');
    expect(rowCounts).toContain('with (format csv, header true)');
    expect(rowCounts).toContain('collate "C"');
    expect(storageSamples).toContain("'cover'");
    expect(storageSamples).toContain("'revision_original'");
    expect(storageSamples).toContain("'prose_image'");
    expect(storageSamples).toContain("'comic_page'");
    expect(storageSamples).toContain("'revision_cover_suggestion'");
    expect(storageSamples).toContain('from prose_images');
    expect(storageSamples).toContain('from comic_pages');
    expect(storageSamples).toContain('from revision_cover_suggestions');
    expect(storageSamples).toContain('with (format csv, header true)');
    expect(storageSamples).toContain('collate "C"');

    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const emittedSampleKinds = new Set(
      Array.from(
        storageSamples.matchAll(/select\s+'(?<kind>[a-z_]+)'::text\s+as\s+sample_kind/giu),
        (match) => match.groups?.kind ?? ''
      ).filter(Boolean)
    );
    expect([...emittedSampleKinds].sort()).toEqual([
      'comic_page',
      'cover',
      'prose_image',
      'revision_cover_suggestion',
      'revision_original'
    ]);
    const operationalSections = [
      markdownSection(storageRunbook, 'Coordinated backup'),
      markdownSection(storageRunbook, 'Isolated restore rehearsal')
    ];
    const operationalPowerShell = operationalSections
      .flatMap((section) => fencedCodeBlocks(section, 'powershell'))
      .join('\n');
    const operationalShell = operationalSections
      .flatMap((section) => fencedCodeBlocks(section, 'sh'))
      .join('\n');
    const powerShellAllowlists = Array.from(
      operationalPowerShell.matchAll(/sample_kind\s+-notin\s+@\((?<kinds>[^)]*)\)/giu),
      (match) => new Set(Array.from(match.groups?.kinds.matchAll(/'([a-z_]+)'/gu) ?? [], (kind) => kind[1]))
    );
    const shellAllowlists = Array.from(
      operationalShell.matchAll(/case "\$sample_kind" in (?<kinds>[a-z_|]+)\)/gu),
      (match) => new Set((match.groups?.kinds ?? '').split('|').filter(Boolean))
    );
    expect(powerShellAllowlists).toHaveLength(2);
    expect(shellAllowlists).toHaveLength(2);
    for (const allowlist of [...powerShellAllowlists, ...shellAllowlists]) {
      expect([...allowlist].sort()).toEqual([...emittedSampleKinds].sort());
    }

    const restoreChecks = markdownSection(financialRunbook, 'Coordinated backup and restore');
    const documentedStructuralChecks = new Set(
      Array.from(
        restoreChecks.matchAll(
          /\bselect\s+'(?<name>[a-z][a-z0-9_]*)'(?:\s+as\s+check_name)?\s*,\s*count\(/giu
        ),
        (match) => match.groups?.name ?? ''
      ).filter((name) => name && !name.startsWith('failed_running_scan_'))
    );
    expect(documentedStructuralChecks.size).toBeGreaterThan(20);
    for (const checkName of documentedStructuralChecks) {
      expect(financialVerifier, checkName).toContain(`'${checkName}'`);
    }
    for (const checkName of [
      'credential_authority_missing_or_mismatched',
      'credential_authority_duplicate_account',
      'credential_authority_orphan_hash',
      'credential_authority_invalid_pending_reset',
      'financial_projection_singleton',
      'financial_payout_discovery_singleton',
      'financial_projection_tip_ambiguity',
      'financial_classification_decision_ambiguity',
      'financial_schema_object_manifest',
      'financial_unknown_classification_issue',
      'allocation_set_detail_classification',
      'financial_item_allocation_parent',
      'financial_item_allocation_semantic_component',
      'financial_fee_detail_semantic_classification',
      'financial_fee_component_conservation',
      'refund_reporting_correction_item_semantics',
      'refund_reporting_correction_history_semantics',
      'dispute_v2_reinstatement_component_parity',
      'dispute_presentment_child_cardinality',
      'dispute_first_withdrawal_source_principal',
      'pending_replay_child_count_mismatch',
      'pending_replay_child_version_mismatch',
      'pending_replay_child_incomplete',
      'pending_replay_child_retry_exhausted',
      'pending_replay_child_permanent',
      'combined_refund_dispute_chronology_capacity',
      'refund_component_chronology_capacity',
      'refund_component_deterministic_split',
      'payout_membership_currency',
      'source_evidence_projection_parity',
      'financial_title_allocation_determinism',
      'resolved_issue_audit_provenance'
    ]) {
      expect(financialVerifier).toContain(`'${checkName}'`);
    }
    expect(restoreChecks).toContain("'financial_payout_discovery_singleton'");
    expect(restoreChecks).toContain("'combined_refund_dispute_chronology_capacity'");
    const verifierConservationSql = financialVerifier.match(
      /with fee_sums as \([\s\S]*?from conservation_counts\r?\norder by check_name;/u
    )?.[0];
    const documentedConservationSql = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore signed-conservation check'),
      'sql'
    )[0];
    expect(verifierConservationSql).toBeDefined();
    expect(documentedConservationSql?.trim()).toBe(verifierConservationSql?.trim());
    const verifierStructuralSql = financialVerifier.match(
      /with allowed_issue_triples\(resource_type, safe_code, impact\) as \(values[\s\S]*?from orphan_counts\s+where violation_count <> 0\s+order by check_name;/u
    )?.[0];
    const documentedStructuralSql = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore orphan check'),
      'sql'
    )[0];
    expect(verifierStructuralSql).toBeDefined();
    expect(documentedStructuralSql?.trim()).toBe(verifierStructuralSql?.trim());
    const verifierScanSql = financialVerifier.match(
      /with pending_replay_children as \([\s\S]*?from scan_checks\r?\norder by check_name;/u
    )?.[0];
    const documentedScanSql = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore scan-checkpoint check'),
      'sql'
    )[0];
    expect(verifierScanSql).toBeDefined();
    expect(documentedScanSql?.trim()).toBe(verifierScanSql?.trim());
    for (const [marker, heading] of [
      ['financial_schema_object_manifest', 'Post-restore executable schema-object check'],
      ['financial_admin_claim_job_authority', 'Post-restore financial administrator claim check'],
      ['source_evidence_projection_parity', 'Post-restore source evidence projection check'],
      ['financial_title_allocation_determinism', 'Post-restore deterministic title allocation check'],
      ['resolved_issue_audit_provenance', 'Post-restore resolved issue audit check']
    ] as const) {
      const verifierBlock = financialVerifier.match(
        new RegExp(`-- BEGIN ${marker}\\r?\\n(?<sql>[\\s\\S]*?)\\r?\\n-- END ${marker}`, 'u')
      )?.groups?.sql;
      const documentedBlock = fencedCodeBlocks(
        markdownSection(financialRunbook, heading),
        'sql'
      )[0];
      expect(verifierBlock, marker).toBeDefined();
      expect(documentedBlock?.trim(), heading).toBe(verifierBlock?.trim());
    }
    for (const requiredObject of [
      'current_financial_projection_heads',
      'current_financial_projection_items',
      'plan6b_reject_history_mutation',
      'plan6b_validate_unknown_classification_issue',
      'plan6b_guard_financial_issue_subject_mutation',
      'resolve_financial_issue_after_worker_recompute',
      'financial_classification_versions_unknown_issue_required',
      'payments_financial_issue_subject_guard',
      'refunds_financial_issue_subject_guard',
      'disputes_financial_issue_subject_guard',
      'financial_allocation_sets_immutable',
      'stripe_payouts_narrow_update',
      'financial_reconciliation_issues_semantic_impact',
      'financial_reconciliation_issues_immutable_classification_open',
      'financial_allocation_sets_supersedes_graph_fk',
      'financial_item_allocations_set_item_component_unique'
    ]) {
      expect(financialVerifier, requiredObject).toContain(`'${requiredObject}'`);
    }
    expect(financialVerifier).toContain('pg_catalog.pg_trigger');
    expect(financialVerifier).toContain('pg_catalog.pg_proc');
    expect(financialVerifier).toContain('pg_catalog.pg_constraint');
    expect(financialVerifier).toContain('pg_catalog.pg_index');
    const runningScanResumeSql = verifierScanSql?.match(
      /select 'running_scan_resume_job_missing'[\s\S]*?(?=\s+union all\s+select 'running_scan_cursor_integrity')/u
    )?.[0];
    expect(runningScanResumeSql).toBeDefined();
    expect(runningScanResumeSql).toContain(
      "and (j.status <> 'pending' or j.attempts < j.max_attempts)"
    );
    expect(financialVerifier).toMatch(
      /combined_refund_events[\s\S]*r\.status = 'succeeded'[\s\S]*r\.allocation_status in \('finalized', 'exception'\)/u
    );
    expect(financialVerifier).toContain(
      'r.id as source_internal_id, ra.id as local_event_id'
    );
    expect(financialVerifier).not.toContain(
      'r.id as source_internal_id, c.id as local_event_id'
    );
    expect(financialVerifier).toContain(
      'bt.provider_created_at, bt.provider_id, d.id as source_internal_id,'
    );
    expect(financialVerifier).toContain(
      'a.id as local_event_id, a.effect, a.reverses_allocation_id'
    );
    expect(financialVerifier).toMatch(
      /combined_current_dispute_events[\s\S]*s\.classifier_version = active\.classifier_version[\s\S]*s\.algorithm_version = active\.allocation_algorithm_version[\s\S]*successor\.supersedes_set_id = s\.id[\s\S]*successor\.classifier_version = s\.classifier_version[\s\S]*successor\.algorithm_version = s\.algorithm_version/u
    );
    expect(financialVerifier).toContain(
      'order by event.provider_created_at, event.provider_id collate "C",'
    );
    expect(financialVerifier).toContain(
      'event.source_internal_id, event.local_event_id'
    );
    expect(financialVerifier).toContain(
      'reinstatement.reversal_of_set_id <> withdrawal.allocation_set_id'
    );
    expect(financialVerifier).toContain(
      'reinstatement.order_item_id <> withdrawal.order_item_id'
    );
    expect(financialVerifier).toContain(
      'reinstatement.presentment_currency <> withdrawal.presentment_currency'
    );
    expect(financialVerifier).toContain('reinstatement.current_reversal_count <> 1');
    expect(financialVerifier).toContain(
      'reinstatement.subtotal_delta_minor > -withdrawal.subtotal_delta_minor'
    );
    expect(financialVerifier).toContain(
      'reinstatement.tax_delta_minor > -withdrawal.tax_delta_minor'
    );
    expect(financialVerifier).toMatch(
      /combined_duplicate_chronology[\s\S]*group by payment_id, order_item_id, presentment_currency, provider_created_at,[\s\S]*provider_id, source_internal_id, local_event_id[\s\S]*having count\(\*\) > 1/u
    );
    expect(financialVerifier).toContain(
      'remaining_subtotal_minor not between 0 and original_subtotal_minor'
    );
    expect(financialVerifier).toContain(
      'remaining_tax_minor not between 0 and original_tax_minor'
    );
    expect(financialVerifier).toContain("'allocation_set_parent_or_chain'");
    expect(financialVerifier).toMatch(
      /classification_subject[\s\S]*c\.source_fingerprint_sha256 is distinct from bt\.fingerprint_sha256[\s\S]*c\.source_fingerprint_sha256 is distinct from fd\.fingerprint_sha256[\s\S]*fee_parent_classification\.id is null/u
    );
    expect(financialVerifier).toMatch(
      /allocation_set_parent_or_chain[\s\S]*parent_classification\.id is null[\s\S]*parent_classification\.classification = 'unknown'/u
    );
    expect(financialVerifier).toMatch(
      /allocation_set_detail_classification[\s\S]*stripe_balance_transaction_fee_details allocation_detail[\s\S]*allocation_detail_classification\.classifier_version = s\.classifier_version[\s\S]*allocation_detail_classification\.source_fingerprint_sha256 =\s*allocation_detail\.fingerprint_sha256[\s\S]*allocation_detail_classification\.id is null[\s\S]*allocation_detail_classification\.classification = 'unknown'/u
    );
    expect(financialVerifier).toMatch(
      /financial_item_allocation_parent[\s\S]*s\.scope <> 'title'[\s\S]*i\.currency <> s\.currency[\s\S]*payment_source\.order_id[\s\S]*refund_payment\.order_id[\s\S]*dispute_payment\.order_id/u
    );
    expect(financialVerifier).toMatch(
      /financial_item_allocation_semantic_component[\s\S]*component_parent_classification[\s\S]*component_detail_classification/u
    );
    for (const componentRule of [
      "component_parent_classification.classification = 'charge'",
      "i.component in ('sale_subtotal', 'sale_tax')",
      "component_parent_classification.classification in ('refund', 'refund_failure')",
      "i.component in ('refund_subtotal', 'refund_tax')",
      "component_parent_classification.classification = 'dispute_withdrawal'",
      "i.component in ('dispute_subtotal', 'dispute_tax')",
      "component_parent_classification.classification = 'dispute_reinstatement'",
      "component_parent_classification.classification = 'fee_credit'",
      "i.component = 'fee_credit'",
      'component_detail_classification.classification::text = i.component::text'
    ]) {
      expect(financialVerifier, componentRule).toContain(componentRule);
    }
    expect(financialVerifier).toMatch(
      /component_parent_classification\.classification = 'dispute_reinstatement'[\s\S]*s\.algorithm_version = 1[\s\S]*i\.component = 'dispute_reinstatement'[\s\S]*s\.algorithm_version = 2[\s\S]*i\.component in \('dispute_reinstatement', 'dispute_tax'\)/u
    );
    expect(financialVerifier).toMatch(
      /financial_title_allocation_determinism[\s\S]*classification\.classification = 'dispute_reinstatement'[\s\S]*case original_item\.component[\s\S]*when 'dispute_subtotal' then 'dispute_reinstatement'::financial_component[\s\S]*else 'dispute_tax'::financial_component[\s\S]*original_item\.component in \('dispute_subtotal', 'dispute_tax'\)/u
    );
    expect(financialVerifier).toMatch(
      /financial_title_allocation_determinism[\s\S]*classification\.classification = 'dispute_withdrawal'[\s\S]*join dispute_item_allocations presentment[\s\S]*'dispute_subtotal'[\s\S]*presentment\.subtotal_effect_minor[\s\S]*'dispute_tax'[\s\S]*presentment\.tax_effect_minor/u
    );
    for (const v2DisputeRule of [
      "'dispute_v2_withdrawal_item_sign'",
      "'dispute_v2_withdrawal_component_membership'",
      'item.effect_minor > 0',
      'settlement.tie_break_key is distinct from case settlement.component',
      'presentment_component.effect_minor <> 0'
    ]) {
      expect(financialVerifier, v2DisputeRule).toContain(v2DisputeRule);
    }
    expect(financialVerifier).toMatch(
      /component_detail_classification\.source_fingerprint_sha256\s*=\s*component_detail\.fingerprint_sha256/u
    );
    expect(financialVerifier).toMatch(
      /financial_fee_detail_semantic_classification[\s\S]*fee_detail_classification\.source_fingerprint_sha256\s*=\s*fee_detail\.fingerprint_sha256[\s\S]*fee_parent_classification\.classification = 'charge'[\s\S]*fee_detail_classification\.classification in \([\s\S]*'processing_fee'[\s\S]*fee_parent_classification\.classification in \('refund', 'refund_failure'\)[\s\S]*'refund_fee'[\s\S]*fee_parent_classification\.classification in \([\s\S]*'dispute_withdrawal', 'dispute_reinstatement'[\s\S]*'dispute_fee'/u
    );
    expect(financialVerifier).toMatch(
      /financial_fee_detail_semantic_classification[\s\S]*fee_set\.scope = 'title'[\s\S]*fee_set\.scope = 'unresolved'[\s\S]*fee_set\.source_kind = 'refund'[\s\S]*fee_parent_classification\.classification = 'refund'/u
    );
    expect(financialVerifier).toMatch(
      /fee_set\.scope = 'unresolved'\s+and fee_set\.source_kind = 'refund'\)\s+\)\s+and not coalesce\(\([\s\S]*fee_set\.source_kind = 'refund'[\s\S]*fee_set\.scope = 'title'[\s\S]*fee_parent_classification\.classification in \('refund', 'refund_failure'\)[\s\S]*fee_set\.scope = 'unresolved'[\s\S]*fee_parent_classification\.classification = 'refund'/u
    );
    for (const feeComponentRule of [
      "'financial_fee_component_conservation'",
      '-sum(detail.amount_minor)::bigint as expected_component_minor',
      'sum(item.effect_minor)::bigint as actual_component_minor',
      'detail_classification.source_fingerprint_sha256 = detail.fingerprint_sha256',
      'coalesce(actual.actual_component_minor, 0) is distinct from',
      'coalesce(expected.expected_component_minor, 0)'
    ]) {
      expect(financialVerifier, feeComponentRule).toContain(feeComponentRule);
    }
    expect(financialVerifier).toMatch(
      /refund_reporting_correction_item_semantics[\s\S]*i\.domain = 'presentment'[\s\S]*i\.component in \('refund_subtotal', 'refund_tax'\)[\s\S]*source_set\.source_kind = 'refund'[\s\S]*source_set\.scope = 'title'[\s\S]*source_classification\.classification = 'refund'[\s\S]*source_set\.basis = 'gross_amount'[\s\S]*source_set\.basis = 'fee'/u
    );
    expect(financialVerifier).toMatch(
      /refund_reporting_correction_history_semantics[\s\S]*approved_absolute_minor::bigint[\s\S]*base_item\.effect_minor[\s\S]*delta_minor::bigint[\s\S]*missing_settlement_base[\s\S]*missing_presentment_base[\s\S]*capacity_minor/u
    );
    const correctionHistorySql = financialVerifier.match(
      /select 'refund_reporting_correction_history_semantics'[\s\S]*?(?=\s+union all\s+select 'refund_finalization_effect_graph')/u
    )?.[0];
    expect(correctionHistorySql).toBeDefined();
    for (const forbiddenHistoryFilter of [
      'financial_projection_versions',
      'current_financial_projection_heads',
      'eligible_allocation_sets',
      'predecessor_correction_set_id',
      'supersedes_set_id'
    ]) {
      expect(correctionHistorySql, forbiddenHistoryFilter).not.toContain(forbiddenHistoryFilter);
    }
    for (const providerSourceRule of [
      "s.source_fingerprint_sha256 is distinct from source_bt.fingerprint_sha256",
      "payment_source.stripe_latest_charge_id is null",
      "source_bt.source_family is distinct from 'charge'",
      'source_bt.source_id is distinct from payment_source.stripe_latest_charge_id',
      "source_bt.source_family is distinct from 'refund'",
      'source_bt.source_id is distinct from refund_source.stripe_refund_id',
      "source_bt.source_family is distinct from 'dispute'",
      'source_bt.source_id is distinct from dispute_source.stripe_dispute_id',
      "source_bt.source_family is distinct from 'payout'",
      'source_bt.source_id is distinct from payout_source.provider_id',
      's.source_internal_id <> s.balance_transaction_id'
    ]) {
      expect(financialVerifier, providerSourceRule).toContain(providerSourceRule);
    }
    expect(financialVerifier).toMatch(
      /s\.source_kind = 'payout'[\s\S]*?source_bt\.source_family is distinct from 'payout'[\s\S]*?source_bt\.source_id is distinct from payout_source\.provider_id[\s\S]*?s\.scope <> 'account'/u
    );
    expect(financialVerifier).toMatch(
      /allocation_set_semantic_source[\s\S]*source_bt\.exchange_rate[\s\S]*source_bt\.exchange_source_currency[\s\S]*source_bt\.exchange_target_currency[\s\S]*payment_source\.currency[\s\S]*refund_source\.currency[\s\S]*dispute_source\.currency/u
    );
    const providerSourceSql = financialVerifier.match(
      /select 'allocation_set_semantic_source'[\s\S]*?(?=\s+union all\s+select 'financial_item_allocation_parent')/u
    )?.[0];
    expect(providerSourceSql).toBeDefined();
    expect(providerSourceSql).toMatch(
      /source_classification\.classification is distinct from 'charge'[\s\S]*?payment_source\.currency = source_bt\.currency[\s\S]*?source_bt\.amount_minor <> payment_source\.amount_minor/u
    );
    expect(providerSourceSql).toMatch(
      /source_classification\.classification not in \('refund', 'refund_failure'\)[\s\S]*?source_classification\.classification = 'refund'[\s\S]*?refund_source\.currency = source_bt\.currency[\s\S]*?source_bt\.amount_minor <> -refund_source\.amount_minor/u
    );
    expect(providerSourceSql).not.toMatch(
      /source_classification\.classification = 'refund_failure'[\s\S]*?source_bt\.amount_minor <> -refund_source\.amount_minor/u
    );
    const firstDisputePrincipalSql = financialVerifier.match(
      /select 'dispute_first_withdrawal_source_principal'[\s\S]*?(?=\s+union all\s+select 'refund_allocation_draft_graph')/u
    )?.[0];
    expect(firstDisputePrincipalSql).toBeDefined();
    expect(firstDisputePrincipalSql).toContain("classification.classification = 'dispute_withdrawal'");
    expect(firstDisputePrincipalSql).toContain('earlier_balance.provider_created_at');
    expect(firstDisputePrincipalSql).toContain('earlier_balance.provider_id collate "C"');
    expect(firstDisputePrincipalSql).toContain('sum(presentment.total_effect_minor)');
    expect(firstDisputePrincipalSql).toMatch(/<>\s+-dispute\.amount_minor/u);
    expect(firstDisputePrincipalSql).not.toContain("'dispute_reinstatement'");
    expect(firstDisputePrincipalSql).not.toContain("'fee_credit'");
    const sourceParitySql = financialVerifier.match(
      /-- BEGIN source_evidence_projection_parity\r?\n(?<sql>[\s\S]*?)\r?\n-- END source_evidence_projection_parity/u
    )?.groups?.sql;
    expect(sourceParitySql).toBeDefined();
    expect(sourceParitySql).toContain('direct_source_principal_state as materialized');
    expect(sourceParitySql).toContain('first_dispute_withdrawal_balance as materialized');
    expect(sourceParitySql).toContain('current_dispute_principal_state as materialized');
    expect(sourceParitySql).toContain('all_source_principals_consistent');
    expect(sourceParitySql).toContain('has_canonical_source_principal');
    expect(sourceParitySql).not.toMatch(
      /reporting_category = 'dispute_reversal'[\s\S]*?source_amount_minor/u
    );
    expect(sourceParitySql).not.toMatch(/reporting_category = 'fee'[\s\S]*?source_amount_minor/u);
    for (const witness of [
      'same-currency payment source-principal corruption',
      'same-currency primary-refund source-principal corruption',
      'first dispute withdrawal presentment/source-principal corruption',
      'later dispute withdrawal settlement remains independent'
    ]) expect(restoreVerifierWitness, witness).toContain(witness);
    expect(financialVerifier).toMatch(
      /source_classification\.classification = 'fee_credit'\s+and source_bt\.reporting_category = 'fee'\s+and source_bt\.raw_type in \('stripe_fee', 'stripe_fx_fee'\)\s+and source_bt\.amount_minor > 0\s+and \([\s\S]*source_bt\.exchange_rate is null[\s\S]*source_bt\.exchange_source_currency = dispute_source\.currency[\s\S]*source_bt\.exchange_target_currency = source_bt\.currency/u
    );
    for (const feeCreditEvidenceRule of [
      "source_bt.reporting_category = 'fee'",
      "source_bt.raw_type in ('stripe_fee', 'stripe_fx_fee')",
      'source_bt.amount_minor > 0'
    ]) {
      expect(financialVerifier, feeCreditEvidenceRule).toContain(feeCreditEvidenceRule);
    }
    expect(financialVerifier).toMatch(
      /s\.source_kind = 'adjustment'[\s\S]*?s\.source_internal_id <> s\.balance_transaction_id[\s\S]*?s\.scope <> 'account'/u
    );
    expect(financialVerifier).toMatch(
      /dispute_presentment_child_cardinality[\s\S]*dispute_withdrawal[\s\S]*dispute_reinstatement[\s\S]*fee_credit[\s\S]*financial_item_allocations/u
    );
    expect(financialVerifier).toContain("s.scope <> 'title'");
    expect(financialVerifier).toContain('select distinct settlement.order_item_id');
    expect(financialVerifier).toContain("presentment.effect <> 'withdrawal'");
    expect(financialVerifier).toContain("presentment.effect <> 'reinstatement'");
    expect(financialVerifier).toContain('presentment.reverses_allocation_id is not null');
    expect(financialVerifier).toContain('presentment.reverses_allocation_id is null');
    expect(financialVerifier).toContain(
      's.reversal_of_set_id is distinct from reversal.gross_allocation_set_id'
    );
    expect(financialVerifier).toContain(
      'candidate_reversal.reverses_allocation_id = a.reverses_allocation_id'
    );
    expect(financialVerifier).toContain(
      'oi.order_id is distinct from dispute_payment.order_id'
    );
    expect(financialVerifier).toMatch(
      /dispute_item_allocation_graph[\s\S]*?s\.source_kind <> 'dispute'[\s\S]*?s\.basis <> 'gross_amount'[\s\S]*?s\.scope <> 'title'/u
    );
    expect(financialVerifier).toContain('a.currency is distinct from d.currency');
    const disputeItemGraphSql = financialVerifier.match(
      /select 'dispute_item_allocation_graph'[\s\S]*?(?=\s+union all\s+select 'dispute_presentment_child_cardinality')/u
    )?.[0];
    expect(disputeItemGraphSql).toBeDefined();
    expect(disputeItemGraphSql).not.toMatch(
      /s\.currency = a\.currency[\s\S]*?settlement\.effect_minor/u
    );
    expect(disputeItemGraphSql).toMatch(
      /s\.currency <> a\.currency[\s\S]*?a\.effect = 'withdrawal'[\s\S]*?sum\(presentment\.total_effect_minor\)[\s\S]*?<>\s*-d\.amount_minor/u
    );
    expect(financialVerifier).toContain(
      's.expected_effect_minor is distinct from -reversed_set.expected_effect_minor'
    );
    expect(financialVerifier).toMatch(
      /a\.effect = 'reinstatement'[\s\S]*sum\(reinstatement_presentment\.total_effect_minor\)[\s\S]*sum\(withdrawal_presentment\.total_effect_minor\)/u
    );
    expect(financialVerifier).toContain(
      'a.subtotal_effect_minor > -reversal.subtotal_effect_minor'
    );
    expect(financialVerifier).toContain(
      'a.tax_effect_minor > -reversal.tax_effect_minor'
    );
    expect(financialVerifier).toMatch(
      /classification\.classification in \('dispute_withdrawal', 'fee_credit'\)[\s\S]*?s\.reversal_of_set_id is not null[\s\S]*?classification\.classification = 'dispute_reinstatement'[\s\S]*?s\.reversal_of_set_id is null/u
    );
    expect(financialVerifier).toContain('presentment.total_effect_minor >= 0');
    expect(financialVerifier).toContain('presentment.total_effect_minor <= 0');
    expect(financialVerifier).toContain('event.total_delta_minor >= 0');
    expect(financialVerifier).toContain('not coalesce((');
    expect(financialVerifier).toContain('parent_classification.id is not null');
    expect(financialVerifier).not.toContain('on commit drop');
    expect(financialVerifier).not.toContain('financial_projection_state');
    expect(financialVerifier).not.toContain('financial_classification_decisions');
    expect(financialVerifier).toMatch(
      /with active as \([\s\S]*from financial_projection_versions[\s\S]*active_sets as \([\s\S]*from financial_allocation_sets[\s\S]*successor\.supersedes_set_id = s\.id[\s\S]*group by s\.balance_transaction_id, s\.basis[\s\S]*where tip_count > 1/iu
    );
    expect(financialVerifier).toMatch(
      /from financial_classification_versions[\s\S]*group by subject_type, subject_id, classifier_version, source_fingerprint_sha256/iu
    );
    expect(financialVerifier).toContain("replay.state is distinct from 'running'");
    expect(financialVerifier).toContain(
      "replay.phase not in ('classification_replay_page', 'classification_replay_finalize')"
    );
    expect(financialVerifier).toMatch(/raise exception[\s\S]*violation/iu);
    expect(financialVerifier).toMatch(/violation_count\s*<>\s*0/iu);

    const migrationFiles = (await readdir(new URL('../drizzle/', import.meta.url)))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name));
    const migrations = (
      await Promise.all(migrationFiles.map((name) => source(`drizzle/${name}`)))
    ).join('\n');
    const financialSchemaManifest = financialVerifier.match(
      /-- BEGIN financial_schema_object_manifest\r?\n(?<sql>[\s\S]*?)\r?\n-- END financial_schema_object_manifest/u
    )?.groups?.sql;
    expect(financialSchemaManifest).toBeDefined();
    const protectedMigrationFiles = await protectedPlan6bMigrationFiles();
    expect(protectedMigrationFiles).toEqual([
      '0007_plan6b_financial_reconciliation.sql',
      '0008_plan6b_worker_issue_resolution.sql',
      '0009_plan6b_worker_authority_and_commerce_integrity.sql',
      '0010_plan6b_guest_claim_authority.sql',
      '0011_plan6b_storage_cleanup_authority.sql',
      '0012_plan6bii_admin_command_authority.sql',
      '0013_plan6bii_reporting_correction_authority.sql',
      '0014_plan6bii_issue_transition_fail_closed.sql'
    ]);
    const plan6bSchemaMigrations = (
      await Promise.all(
        protectedMigrationFiles.map((name) => source(`drizzle/${name}`))
      )
    ).join('\n');
    const requiredFinancialSchemaObjects = new Set(
      Array.from(
        plan6bSchemaMigrations.matchAll(
          /(?:create (?:or replace )?function\s+(?:(?:"public"\.)?)|create (?:constraint )?trigger\s+|create view\s+"public"\.|create (?:unique )?index\s+|add constraint\s+)"(?<name>[a-z_][a-z0-9_]*)"/giu
        ),
        (match) => match.groups?.name ?? ''
      ).filter((name) => name && (
        name.startsWith('financial_') ||
        name.startsWith('plan6b_') ||
        name.startsWith('refund_') ||
        name.startsWith('stripe_') ||
        name.startsWith('dispute_') ||
        name.startsWith('payout_') ||
        name.startsWith('entitlement_grants_') ||
        name === 'grants_source_consistent' ||
        name === 'jobs_rerun_requires_running' ||
        name === 'enforce_financial_allocation_supersession_lineage' ||
        name === 'current_financial_projection_heads' ||
        name === 'current_financial_projection_items' ||
        name === 'resolve_financial_reconciliation_issue' ||
        name === 'resolve_financial_issue_after_worker_recompute'
      ))
    );
    for (const objectName of requiredFinancialSchemaObjects) {
      expect(financialSchemaManifest, objectName).toContain(`'${objectName}'`);
    }
    expect(financialSchemaManifest).toMatch(
      /unexpected_protected_objects as \([\s\S]*?routine\.proname = 'resolve_financial_reconciliation_issue'/u
    );
    const physicalTables = new Set(
      Array.from(
        migrations.matchAll(/create (?:table|view)\s+(?:"public"\.)?"(?<name>[a-z_][a-z0-9_]*)"/giu),
        (match) => match.groups?.name ?? ''
      ).filter(Boolean)
    );
    const cteNames = new Set(
      Array.from(
        financialVerifier.matchAll(
          /(?:\bwith|,)\s*(?<name>[a-z_][a-z0-9_]*)(?:\([^)]*\))?\s+as\s+(?:materialized\s+)?\(/giu
        ),
        (match) => match.groups?.name ?? ''
      ).filter(Boolean)
    );
    const relationReferences = Array.from(
      financialVerifier.matchAll(
        /^\s*(?:from|(?:(?:left|right|inner|full|cross)\s+)?join)\s+(?<name>[a-z_][a-z0-9_]*)\b/gimu
      ),
      (match) => match.groups?.name ?? ''
    ).filter(
      (name) =>
        name &&
        !cteNames.has(name) &&
        !['lateral', 'pg_catalog', 'restore_financial_checks'].includes(name)
    );
    expect(
      [...new Set(relationReferences.filter((name) => !physicalTables.has(name)))].sort()
    ).toEqual([]);
  });

  it('pins one versioned exact catalog contract for every protected financial object kind', async () => {
    const [
      financialVerifier,
      financialRunbook,
      verifierWitness,
      issueTransitionFailClosedMigration
    ] =
      await Promise.all([
        source('scripts/verify-financial-restore.sql'),
        source('docs/stripe-financial-reconciliation.md'),
        source('scripts/execute-financial-restore-verifier.ts'),
        source('drizzle/0014_plan6bii_issue_transition_fail_closed.sql')
      ]);
    const financialWitnessHarnessSource = await source(
      'scripts/financial-restore-witness-harness.ts'
    );
    const financialSchemaManifest = financialVerifier.match(
      /-- BEGIN financial_schema_object_manifest\r?\n(?<sql>[\s\S]*?)\r?\n-- END financial_schema_object_manifest/u
    )?.groups?.sql ?? '';
    const documentedManifest = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore executable schema-object check'),
      'sql'
    )[0] ?? '';
    const plan6bMigrationFiles = await protectedPlan6bMigrationFiles();
    const plan6bMigrations = (
      await Promise.all(plan6bMigrationFiles.map((name) => source(`drizzle/${name}`)))
    ).join('\n');
    const requiredEnumLabels = new Map(
      Array.from(
        plan6bMigrations.matchAll(
          /create type\s+(?:(?:"public"\.)?)"(?<name>[a-z_][a-z0-9_]*)"\s+as enum\((?<labels>[^;]+)\)/giu
        ),
        (match) => [
          match.groups?.name ?? '',
          Array.from(
            (match.groups?.labels ?? '').matchAll(/'(?<label>[^']+)'/gu),
            (labelMatch) => labelMatch.groups?.label ?? ''
          ).filter(Boolean)
        ] as const
      ).filter(([name]) => Boolean(name))
    );
    const requiredLegacyColumnKeys = new Set([
      ...Array.from(
        plan6bMigrations.matchAll(
          /alter table\s+(?:(?:"public"\.)?)"(?<table>[a-z_][a-z0-9_]*)"\s+add column\s+"(?<column>[a-z_][a-z0-9_]*)"/giu
        ),
        (match) => `${match.groups?.table ?? ''}:${match.groups?.column ?? ''}`
      ),
      ...Array.from(
        plan6bMigrations.matchAll(
          /alter table\s+(?:(?:"public"\.)?)"(?<table>[a-z_][a-z0-9_]*)"\s+alter column\s+"(?<column>[a-z_][a-z0-9_]*)"/giu
        ),
        (match) => `${match.groups?.table ?? ''}:${match.groups?.column ?? ''}`
      )
    ].filter((key) => key !== ':'));
    const forbiddenLegacyColumnKeys = new Set(
      Array.from(
        plan6bMigrations.matchAll(
          /alter table\s+(?:(?:"public"\.)?)"(?<table>[a-z_][a-z0-9_]*)"\s+drop column\s+"(?<column>[a-z_][a-z0-9_]*)"/giu
        ),
        (match) => `${match.groups?.table ?? ''}:${match.groups?.column ?? ''}`
      ).filter((key) => key !== ':')
    );
    const forbiddenRetiredTypeNames = new Set(
      Array.from(
        plan6bMigrations.matchAll(
          /drop type\s+(?:(?:"public"\.)?)"(?<name>[a-z_][a-z0-9_]*)"/giu
        ),
        (match) => match.groups?.name ?? ''
      ).filter(Boolean)
    );
    const requiredTableNames = new Set(
      Array.from(
        plan6bMigrations.matchAll(
          /create table\s+(?:(?:"public"\.)?)"(?<name>[a-z_][a-z0-9_]*)"/giu
        ),
        (match) => match.groups?.name ?? ''
      ).filter(Boolean)
    );
    const requiredFunctionNames = new Set(
      Array.from(
        plan6bMigrations.matchAll(
        /create (?:or replace )?function\s+(?:(?:"public"\.)?)"(?<name>[a-z_][a-z0-9_]*)"\s*\(/giu
        ),
        (match) => match.groups?.name ?? ''
      ).filter((name) => name && name !== 'resolve_financial_reconciliation_issue')
    );
    requiredFunctionNames.add('reject_audit_event_mutation');
    const requiredTriggerKeys = new Set(
      Array.from(
        plan6bMigrations.matchAll(
          /create (?:constraint )?trigger\s+"(?<name>[a-z_][a-z0-9_]*)"(?<body>[\s\S]*?);--> statement-breakpoint/giu
        ),
        (match) => {
          const parent = match.groups?.body.match(
            /\bon\s+(?:(?:"public"\.)?)"(?<name>[a-z_][a-z0-9_]*)"/iu
          )?.groups?.name;
          return parent && match.groups?.name ? `${parent}:${match.groups.name}` : '';
        }
      ).filter(Boolean)
    );

    expect(documentedManifest).toBe(financialSchemaManifest);
    expect(financialSchemaManifest).toMatch(
      /catalog_contract_version\s*\(\s*contract_version\s*\)\s+as\s*\(\s*values\s*\(\s*'plan6b-financial-catalog-v4'\s*\)/iu
    );
    expect(financialSchemaManifest).toMatch(
      /required_catalog_objects\s*\(\s*object_kind\s*,\s*schema_name\s*,\s*parent_name\s*,\s*object_name\s*,\s*identity_arguments\s*,\s*expected_fingerprint_sha256\s*,\s*expected_catalog\s*\)/iu
    );
    for (const catalogPrimitive of [
      'pg_get_viewdef',
      'pg_attribute',
      'reloptions',
      'pg_get_userbyid',
      'aclexplode',
      'pg_get_functiondef',
      'pg_get_function_identity_arguments',
      'proconfig',
      'pg_get_triggerdef',
      'pg_get_indexdef',
      'indisvalid',
      'indisready',
      'pg_get_constraintdef',
      'convalidated',
      'condeferrable',
      'condeferred',
      'duplicate_contract_objects',
      'duplicate_truncated_constraint_keys',
      'duplicate_actual_objects',
      'missing_or_mismatched_objects',
      'unexpected_protected_objects',
      'unexpected_protected_routine_kinds',
      'catalog_table_object_inventory',
      'catalog_column_descriptors',
      'catalog_type_acl',
      'disabled_protected_constraint_triggers',
      'forbidden_retired_types',
      'unexpected_forbidden_types',
      'forbidden_retired_columns',
      'unexpected_forbidden_columns',
      'conindid',
      'conenforced',
      'confrelid',
      'pg_enum',
      'pg_rewrite',
      'pg_get_ruledef',
      'pg_inherits',
      'inhdetachpending',
      'relispartition',
      'relpersistence',
      'relrowsecurity',
      'relforcerowsecurity'
    ]) {
      expect(financialSchemaManifest, catalogPrimitive).toContain(catalogPrimitive);
    }
    for (const catalogField of [
      "'definition'",
      "'columns'",
      "'relkind'",
      "'persistence'",
      "'row_security'",
      "'force_row_security'",
      "'is_partition'",
      "'constraints'",
      "'referencing_foreign_keys'",
      "'explicit_indexes'",
      "'triggers'",
      "'rules'",
      "'inheritance_edges'",
      "'internal_trigger_modes'",
      "'labels'",
      "'primary_key'",
      "'reloptions'",
      "'owner'",
      "'acl'",
      "'identity_arguments'",
      "'kind'",
      "'config'",
      "'enabled'",
      "'valid'",
      "'ready'",
      "'validated'",
      "'enforced'",
      "'deferrable'",
      "'initially_deferred'",
      "'DATABASE_OWNER'"
    ]) {
      expect(financialSchemaManifest, catalogField).toContain(catalogField);
    }
    expect(financialSchemaManifest).toMatch(
      /'definition',\s*pg_catalog\.replace\(pg_catalog\.replace\(\s*pg_catalog\.pg_get_functiondef\(routine\.oid\),\s*E'\\r\\n',\s*E'\\n'\s*\),\s*E'\\r',\s*E'\\n'\)/u
    );

    const catalogRows = Array.from(
      financialSchemaManifest.matchAll(
        /\(\s*'(?<kind>table|view|function|trigger|index|constraint|column|enum|sensitive_relation_state)'\s*,\s*'public'\s*,\s*(?<parent>null|'[a-z_][a-z0-9_]*')\s*,\s*'(?<name>[a-z_][a-z0-9_]*)'\s*,\s*(?<arguments>null|'[^']*')\s*,\s*'(?<fingerprint>[0-9a-f]{64})'\s*,\s*\$catalog\$(?<catalog>[\s\S]*?)\$catalog\$::jsonb\s*\)/gu
      ),
      (match) => ({
        arguments: match.groups?.arguments ?? '',
        catalog: match.groups?.catalog ?? '',
        fingerprint: match.groups?.fingerprint ?? '',
        kind: match.groups?.kind ?? '',
        name: match.groups?.name ?? '',
        parent: match.groups?.parent ?? ''
      })
    );
    expect(catalogRows.length).toBeGreaterThan(100);
    expect(catalogRows).toHaveLength(275);
    expect(new Set(catalogRows.map((row) =>
      `${row.kind}:${row.parent}:${row.name}:${row.arguments}`
    )).size).toBe(catalogRows.length);
    expect(catalogRows.every((row) => /^[0-9a-f]{64}$/u.test(row.fingerprint))).toBe(true);
    expect(catalogRows.some((row) => /^0{64}$/u.test(row.fingerprint))).toBe(false);
    expect(catalogRows.some((row) => row.catalog === '{}')).toBe(false);
    expect(catalogRows.every((row) =>
      createHash('sha256').update(row.catalog, 'utf8').digest('hex') === row.fingerprint
    )).toBe(true);
    const issueTransitionRows = catalogRows.filter((row) =>
      row.kind === 'function' &&
      row.parent === 'null' &&
      row.name === 'plan6b_validate_issue_transition' &&
      row.arguments === "''"
    );
    expect(issueTransitionRows).toHaveLength(1);
    const issueTransitionCatalog = JSON.parse(
      issueTransitionRows[0]!.catalog
    ) as Record<string, unknown>;
    expect(Object.keys(issueTransitionCatalog).sort()).toEqual([
      'acl',
      'config',
      'definition',
      'identity_arguments',
      'kind',
      'language',
      'leakproof',
      'owner',
      'parallel',
      'result',
      'security_definer',
      'strict',
      'volatility'
    ]);
    expect(issueTransitionCatalog).toMatchObject({
      identity_arguments: '',
      kind: 'f',
      language: 'plpgsql',
      leakproof: false,
      owner: 'DATABASE_OWNER',
      parallel: 'u',
      result: 'trigger',
      security_definer: false,
      strict: false,
      volatility: 'v'
    });
    const rawIssueTransitionDefinition = issueTransitionCatalog.definition;
    expect(typeof rawIssueTransitionDefinition).toBe('string');
    const issueTransitionDefinition = typeof rawIssueTransitionDefinition === 'string'
      ? rawIssueTransitionDefinition
      : '';
    const migrationFunctionBody = issueTransitionFailClosedMigration.match(
      /CREATE OR REPLACE FUNCTION "public"\."plan6b_validate_issue_transition"\(\) RETURNS trigger\r?\nLANGUAGE plpgsql AS \$plan6bii_issue_transition_fail_closed\$\r?\n(?<body>[\s\S]*?)\r?\n\$plan6bii_issue_transition_fail_closed\$;--> statement-breakpoint/u
    )?.groups?.body.replace(/\r\n?/gu, '\n');
    const catalogFunctionBody = issueTransitionDefinition.match(
      /AS \$function\$\n(?<body>[\s\S]*?)\n\$function\$\n$/u
    )?.groups?.body;
    expect(migrationFunctionBody).toBeDefined();
    expect(catalogFunctionBody).toBe(migrationFunctionBody);
    expect(issueTransitionDefinition).toContain(
      ") ~ '^[0-9a-f-]{36}$',\n        false\n      ) AND COALESCE("
    );
    expect(issueTransitionDefinition).not.toContain(
      `{36}, "volatility": "v"`
    );
    for (const settingName of [
      'pale_orbit.financial_worker_issue_resolution',
      'pale_orbit.plan6bii_financial_admin_issue_resolution_issue_id',
      'pale_orbit.plan6bii_financial_admin_issue_resolution_command_id',
      'pale_orbit.plan6bii_financial_admin_issue_resolution_actor_id'
    ]) {
      expect(issueTransitionDefinition.split(settingName), settingName).toHaveLength(2);
    }
    for (const relationRow of catalogRows.filter((row) =>
      row.kind === 'table' || row.kind === 'view'
    )) {
      const descriptor = JSON.parse(relationRow.catalog) as Record<string, unknown>;
      expect(descriptor.relkind, relationRow.name).toBe(
        relationRow.kind === 'table' ? 'r' : 'v'
      );
      expect(descriptor.persistence, relationRow.name).toBe('p');
      expect(descriptor.row_security, relationRow.name).toBe(false);
      expect(descriptor.force_row_security, relationRow.name).toBe(false);
      if (relationRow.kind === 'table') {
        expect(descriptor.is_partition, relationRow.name).toBe(false);
        expect(Array.isArray(descriptor.constraints), relationRow.name).toBe(true);
        expect(Array.isArray(descriptor.referencing_foreign_keys), relationRow.name).toBe(true);
        expect(Array.isArray(descriptor.explicit_indexes), relationRow.name).toBe(true);
        expect(Array.isArray(descriptor.triggers), relationRow.name).toBe(true);
        expect(Array.isArray(descriptor.rules), relationRow.name).toBe(true);
        expect(Array.isArray(descriptor.inheritance_edges), relationRow.name).toBe(true);
        const constraintInventory = descriptor.constraints as Array<Record<string, unknown>>;
        expect(constraintInventory.length, relationRow.name).toBeGreaterThan(0);
        expect(
          constraintInventory.every((constraint) => constraint.enforced === true),
          relationRow.name
        ).toBe(true);
        for (const inventory of [
          constraintInventory,
          descriptor.explicit_indexes as Array<Record<string, unknown>>,
          descriptor.triggers as Array<Record<string, unknown>>
        ]) {
          const names = inventory.map((entry) => entry.name);
          expect(names.every((name) => typeof name === 'string'), relationRow.name).toBe(true);
          expect(names, relationRow.name).toEqual([...names].sort());
        }
        if (relationRow.name === 'commerce_claim_issuances') {
          expect(descriptor.explicit_indexes).toHaveLength(3);
          expect(descriptor.triggers).toHaveLength(0);
        }
        expect(descriptor.primary_key, relationRow.name).toEqual(expect.objectContaining({
          deferrable: false,
          definition: expect.stringMatching(/^PRIMARY KEY \(.+\)$/u),
          enforced: true,
          initially_deferred: false,
          name: expect.stringMatching(/_pkey$/u),
          validated: true
        }));
      } else {
        expect(descriptor, relationRow.name).not.toHaveProperty('primary_key');
      }
    }
    expect((financialSchemaManifest.match(
      /order by\s+\w+_row\.\w+\s+collate\s+"C"/gu
    ) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(financialSchemaManifest).toMatch(
      /constraint_row\.conname\s*=\s*pg_catalog\.left\(required\.object_name,\s*63\)/u
    );
    expect(financialSchemaManifest).toMatch(
      /disabled_protected_constraint_triggers[\s\S]*trigger_row\.tgconstraint\s*<>\s*0[\s\S]*trigger_row\.tgenabled\s*<>\s*'O'/u
    );
    expect(new Set(catalogRows.map((row) => row.kind))).toEqual(
      new Set([
        'table',
        'view',
        'function',
        'trigger',
        'index',
        'constraint',
        'column',
        'enum',
        'sensitive_relation_state'
      ])
    );
    expect(Object.fromEntries(
      [
        'table',
        'view',
        'function',
        'trigger',
        'index',
        'constraint',
        'column',
        'enum',
        'sensitive_relation_state'
      ].map((kind) => [kind, catalogRows.filter((row) => row.kind === kind).length])
    )).toEqual({
      table: requiredTableNames.size,
      view: 2,
      function: requiredFunctionNames.size,
      trigger: requiredTriggerKeys.size,
      index: 62,
      constraint: 67,
      column: requiredLegacyColumnKeys.size,
      enum: requiredEnumLabels.size,
      sensitive_relation_state: 4
    });
    expect(requiredTableNames.size).toBe(23);
    expect(requiredFunctionNames.size).toBe(46);
    expect(requiredTriggerKeys.size).toBe(39);
    expect(requiredLegacyColumnKeys.size).toBe(7);
    expect(requiredEnumLabels.size).toBe(25);
    expect(catalogRows.filter((row) =>
      row.kind === 'index' && row.parent === "'financial_admin_commands'"
    )).toHaveLength(3);
    expect(catalogRows.filter((row) =>
      row.kind === 'constraint' && row.parent === "'financial_admin_commands'"
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'financial_admin_commands_actor_user_id_user_id_fk' }),
      expect.objectContaining({ name: 'financial_admin_commands_job_id_jobs_id_fk' })
    ]));
    expect(catalogRows.some((row) =>
      row.kind === 'constraint' &&
      row.parent === "'financial_admin_job_claims'" &&
      row.name === 'financial_admin_job_claims_job_id_jobs_id_fk'
    )).toBe(true);
    expect(forbiddenLegacyColumnKeys).toEqual(new Set([
      'disputes:reconciliation_status',
      'payments:reconciliation_status',
      'refunds:reconciliation_status'
    ]));
    expect(forbiddenRetiredTypeNames).toEqual(new Set([
      'entitlement_grant_source_legacy',
      'financial_reconciliation_status'
    ]));
    expect(catalogRows.filter((row) =>
      row.kind === 'constraint' && row.parent === "'commerce_claim_issuances'"
    )).toHaveLength(10);
    expect(catalogRows.filter((row) =>
      row.kind === 'index' && row.parent === "'commerce_claim_issuances'"
    )).toHaveLength(3);
    for (const claimMigrationTrigger of [
      'guest_identities:guest_identities_plan6b_update_guard',
      'payout_import_run_entries:payout_import_run_entries_immutable'
    ]) {
      expect(catalogRows.some((row) =>
        row.kind === 'trigger' && `${row.parent.slice(1, -1)}:${row.name}` ===
          claimMigrationTrigger
      ), claimMigrationTrigger).toBe(true);
    }
    for (const tableName of requiredTableNames) {
      expect(
        catalogRows.some((row) => row.kind === 'table' && row.name === tableName),
        tableName
      ).toBe(true);
    }
    for (const [enumName, labels] of requiredEnumLabels) {
      const enumRow = catalogRows.find((row) =>
        row.kind === 'enum' && row.name === enumName
      );
      expect(enumRow, enumName).toBeDefined();
      expect(JSON.parse(enumRow?.catalog ?? '{}'), enumName).toEqual(expect.objectContaining({
        acl: expect.any(Array),
        labels,
        owner: 'DATABASE_OWNER'
      }));
    }
    for (const legacyColumnKey of requiredLegacyColumnKeys) {
      const [tableName, columnName] = legacyColumnKey.split(':');
      expect(catalogRows.some((row) =>
        row.kind === 'column' && row.parent === `'${tableName}'` && row.name === columnName
      ), legacyColumnKey).toBe(true);
    }
    for (const relationName of [
      'outbox_messages',
      'guest_identities',
      'entitlement_grants',
      'entitlements'
    ]) {
      const relationStateRow = catalogRows.find((row) =>
        row.kind === 'sensitive_relation_state' && row.name === relationName
      );
      expect(relationStateRow, relationName).toBeDefined();
      expect(JSON.parse(relationStateRow?.catalog ?? '{}'), relationName).toEqual({
        force_row_security: false,
        persistence: 'p',
        relkind: 'r',
        row_security: false
      });
    }
    for (const functionName of requiredFunctionNames) {
      const functionRow = catalogRows.find((row) =>
        row.kind === 'function' && row.name === functionName
      );
      expect(functionRow, functionName).toBeDefined();
      expect(JSON.parse(functionRow?.catalog ?? '{}'), functionName).toEqual(
        expect.objectContaining({ kind: 'f' })
      );
    }
    for (const triggerKey of requiredTriggerKeys) {
      expect(
        catalogRows.some((row) =>
          row.kind === 'trigger' && `${row.parent.slice(1, -1)}:${row.name}` === triggerKey
        ),
        triggerKey
      ).toBe(true);
    }

    const descriptorFor = (kind: string, name: string): Record<string, unknown> => {
      const row = catalogRows.find((candidate) =>
        candidate.kind === kind && candidate.name === name
      );
      expect(row, `${kind}:${name}`).toBeDefined();
      return JSON.parse(row?.catalog ?? '{}') as Record<string, unknown>;
    };
    const commandsDescriptor = descriptorFor('table', 'financial_admin_commands');
    const claimsDescriptor = descriptorFor('table', 'financial_admin_job_claims');
    const commandsColumns = commandsDescriptor.columns as Array<Record<string, unknown>>;
    const claimsColumns = claimsDescriptor.columns as Array<Record<string, unknown>>;
    expect(commandsDescriptor.owner).toBe('DATABASE_OWNER');
    expect(claimsDescriptor.owner).toBe('DATABASE_OWNER');
    const workerCommandUpdateColumns = new Set([
      'status',
      'safe_result_code',
      'safe_result',
      'updated_at',
      'completed_at'
    ]);
    const workerCommandUpdateAcl = {
      grantee: 'pale_orbit_financial_worker',
      grantor: 'DATABASE_OWNER',
      grantable: false,
      privilege: 'UPDATE'
    };
    expect(commandsColumns.filter((column) =>
      Array.isArray(column.acl) && column.acl.length > 0
    ).map((column) => column.name).sort()).toEqual(
      [...workerCommandUpdateColumns].sort()
    );
    for (const column of commandsColumns) {
      expect(column.acl, String(column.name)).toEqual(
        workerCommandUpdateColumns.has(String(column.name))
          ? [workerCommandUpdateAcl]
          : []
      );
    }
    expect(claimsColumns.map((column) => column.name)).not.toContain('capability_token');
    expect(claimsColumns.every((column) =>
      Array.isArray(column.acl) && column.acl.length === 0
    )).toBe(true);
    const databaseOwnerExecuteAcl = {
      grantee: 'DATABASE_OWNER',
      grantor: 'DATABASE_OWNER',
      grantable: false,
      privilege: 'EXECUTE'
    };
    expect(claimsDescriptor.acl).toEqual([
      'DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES',
      'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'
    ].map((privilege) => ({
      grantee: 'DATABASE_OWNER',
      grantor: 'DATABASE_OWNER',
      grantable: false,
      privilege
    })));
    expect((commandsDescriptor.acl as Array<Record<string, unknown>>).filter((acl) =>
      acl.grantee !== 'DATABASE_OWNER'
    )).toEqual([{
      grantee: 'pale_orbit_financial_worker',
      grantor: 'DATABASE_OWNER',
      grantable: false,
      privilege: 'SELECT'
    }]);
    expect(financialSchemaManifest).toMatch(
      /\('relation',\s*'public',\s*null,\s*'jobs',\s*null,\s*null,\s*'pale_orbit_financial_worker',\s*'SELECT',\s*false\)/u
    );
    for (const runtimeJobSelectColumn of ['id', 'deduplication_key']) {
      expect(financialSchemaManifest, runtimeJobSelectColumn).toMatch(new RegExp(
        String.raw`\('column',\s*'public',\s*'jobs',\s*'jobs',\s*null,\s*'${runtimeJobSelectColumn}',\s*'pale_orbit_runtime',\s*'SELECT',\s*false\)`,
        'u'
      ));
    }
    expect(Array.from(
      financialSchemaManifest.matchAll(
        /\('column',\s*'public',\s*'jobs',\s*'jobs',\s*null,\s*'(?<column>[a-z_][a-z0-9_]*)',\s*'pale_orbit_runtime',\s*'SELECT',\s*false\)/gu
      ),
      (match) => match.groups?.column ?? ''
    ).sort()).toEqual(['deduplication_key', 'id']);

    const newRuntimeRoutines = new Set([
      'submit_financial_admin_command',
      'financial_admin_command_status',
      'append_financial_issue_view_audit',
      'append_financial_refund_review_view_audit',
      'append_financial_payout_view_audit',
      'append_financial_sales_export_audit'
    ]);
    const newWorkerRoutines = new Set([
      'resolve_financial_issue_after_admin_command',
      'resolve_financial_issue_after_reporting_correction_command',
      'transition_administrative_recovery_grant_after_admin_command'
    ]);
    const expectedBaseDirectAcl = financialSchemaManifest.match(
      /\), expected_base_direct_acl\([\s\S]*?\) as \(values(?<rows>[\s\S]*?)\), expected_direct_acl\(/u
    )?.groups?.rows ?? '';
    const expectedApplicationExecuteRows = Array.from(
      expectedBaseDirectAcl.matchAll(
        /\(\s*'function'\s*,\s*'public'\s*,\s*null\s*,\s*'(?<name>[a-z_][a-z0-9_]*)'\s*,\s*'(?<arguments>[^']*)'\s*,\s*null\s*,\s*'(?<grantee>pale_orbit_runtime|pale_orbit_financial_worker)'\s*,\s*'EXECUTE'\s*,\s*false\s*\)/gu
      ),
      (match) => ({
        grantee: match.groups?.grantee ?? '',
        signature: `${match.groups?.name ?? ''}(${
          (match.groups?.arguments ?? '').replace(/,\s*/gu, ',')
        })`
      })
    );
    expect(expectedApplicationExecuteRows.filter((row) =>
      row.grantee === 'pale_orbit_runtime'
    ).map((row) => row.signature).sort()).toEqual([
      'append_financial_issue_view_audit(uuid,uuid,text,text,text)',
      'append_financial_payout_view_audit(uuid,uuid,text,text,text)',
      'append_financial_refund_review_view_audit(uuid,uuid,text,text,text)',
      'append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)',
      'authorize_commerce_claim_issuance(text,text)',
      'claim_guest_purchases_after_authorization(text,text)',
      'financial_admin_command_status(uuid,uuid)',
      'outbox_message_deduplication_metadata(text,text,jsonb)',
      'outbox_message_exists_by_deduplication_key(text)',
      'rearm_pending_stripe_event_job(uuid)',
      'submit_financial_admin_command(uuid,text,text,text,text,jsonb)'
    ]);
    expect(expectedApplicationExecuteRows.filter((row) =>
      row.grantee === 'pale_orbit_financial_worker'
    ).map((row) => row.signature).sort()).toEqual([
      'purge_commerce_claim_issuances()',
      'register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)',
      'resolve_financial_issue_after_admin_command(uuid,uuid)',
      'resolve_financial_issue_after_reporting_correction_command(uuid,uuid)',
      'resolve_financial_issue_after_worker_recompute(uuid,text)',
      'transition_administrative_recovery_grant_after_admin_command(uuid)'
    ]);
    expect(expectedBaseDirectAcl).not.toMatch(
      /\('relation',\s*'public',\s*null,\s*'jobs',\s*null,\s*null,\s*'pale_orbit_runtime',\s*'SELECT'/u
    );
    expect(expectedBaseDirectAcl).not.toMatch(
      /\('column',\s*'public',\s*'jobs',\s*'jobs',\s*null,\s*'payload',\s*'pale_orbit_runtime',\s*'SELECT'/u
    );
    expect(financialSchemaManifest).toMatch(
      /select 'function'[\s\S]*?from pg_catalog\.pg_proc routine[\s\S]*?where namespace_row\.nspname = 'public'\s+and \(\s*grantee\.role_label in \(\s*'pale_orbit_runtime', 'pale_orbit_financial_worker'/u
    );
    const roleLabelSql = financialSchemaManifest.match(
      /\), role_labels\(role_oid, role_label\) as \((?<sql>[\s\S]*?)\), catalog_relation_acl/u
    )?.groups?.sql ?? '';
    expect(roleLabelSql).toContain('database_row.datdba');
    expect(roleLabelSql).not.toContain('session_user');
    expect(roleLabelSql).not.toMatch(/rolname[^\n]*pg_database_owner/u);
    expect(financialSchemaManifest).toMatch(
      /namespace_row\.nspname = 'public'[\s\S]*?pg_catalog\.pg_get_userbyid\(namespace_row\.nspowner\) = 'pg_database_owner'[\s\S]*?acl\.grantor = namespace_row\.nspowner then 'DATABASE_OWNER'/u
    );
    for (const row of catalogRows.filter((candidate) =>
      candidate.kind === 'function' &&
      (newRuntimeRoutines.has(candidate.name) || newWorkerRoutines.has(candidate.name))
    )) {
      const descriptor = JSON.parse(row.catalog) as {
        acl: Array<Record<string, unknown>>;
        config: readonly string[];
        kind: string;
        owner: string;
        security_definer: boolean;
        volatility: string;
      };
      const applicationGrantee = newRuntimeRoutines.has(row.name)
        ? 'pale_orbit_runtime'
        : 'pale_orbit_financial_worker';
      expect(descriptor, row.name).toEqual(expect.objectContaining({
        config: ['search_path=pg_catalog'],
        kind: 'f',
        owner: 'DATABASE_OWNER',
        security_definer: true,
        volatility: 'v'
      }));
      expect(descriptor.acl, row.name).toEqual([
        databaseOwnerExecuteAcl,
        {
          grantee: applicationGrantee,
          grantor: 'DATABASE_OWNER',
          grantable: false,
          privilege: 'EXECUTE'
        }
      ].sort((left, right) => String(left.grantee).localeCompare(String(right.grantee))));
    }
    const newPrivateHelperSecurity = new Map<string, boolean>([
      ['plan6bii_assert_financial_admin_job_lease', true],
      ['plan6bii_guard_financial_admin_job_lease', true],
      ['plan6bii_guard_financial_admin_command_update', true],
      ['plan6bii_guard_financial_admin_command_delete', true],
      ['plan6bii_guard_administrative_grant_transition', false],
      ['plan6bii_sync_failed_financial_admin_command', true]
    ]);
    for (const [privateRoutine, securityDefiner] of newPrivateHelperSecurity) {
      const descriptor = descriptorFor('function', privateRoutine);
      expect(descriptor, privateRoutine).toEqual(expect.objectContaining({
        acl: [databaseOwnerExecuteAcl],
        config: ['search_path=pg_catalog'],
        kind: 'f',
        owner: 'DATABASE_OWNER',
        security_definer: securityDefiner,
        volatility: 'v'
      }));
    }
    for (const [changedGuard, securityDefiner, config] of [
      ['plan6b_guard_job_insert', true, ['search_path=pg_catalog']],
      ['plan6b_guard_audit_insert', false, ['search_path=pg_catalog']],
      ['plan6b_validate_issue_transition', false, []]
    ] as const) {
      const descriptor = descriptorFor('function', changedGuard);
      expect(descriptor, changedGuard).toEqual(expect.objectContaining({
        acl: [databaseOwnerExecuteAcl],
        config,
        kind: 'f',
        owner: 'DATABASE_OWNER',
        security_definer: securityDefiner,
        volatility: 'v'
      }));
    }
    expect(financialSchemaManifest).not.toContain("'capability_token'");
    for (const defaultAclPrimitive of [
      'actual_default_acl_identity',
      'expected_default_acl_identity',
      'raw_explicit_default_acl',
      'implicit_owner_default_acl',
      'normalized_effective_default_acl',
      'expected_default_acl',
      'default_acl_identity_delta',
      'default_acl_delta'
    ]) {
      expect(financialSchemaManifest, defaultAclPrimitive).toContain(defaultAclPrimitive);
    }
    expect(financialSchemaManifest.match(/except all/giu)).toHaveLength(4);
    const expectedDefaultAclTuples = financialSchemaManifest.match(
      /expected_default_acl\([\s\S]*?\)\s+as\s*\(values(?<tuples>[\s\S]*?)\)\s*,\s*default_acl_delta/u
    )?.groups?.tuples ?? '';
    const normalizedDefaultAclTuples = expectedDefaultAclTuples.replace(/\s+/gu, ' ');
    expect(expectedDefaultAclTuples.match(/\('DATABASE_OWNER'/gu)).toHaveLength(16);
    for (const [namespaceName, objectType, granteeName, privileges] of [
      ['public', 'r', 'DATABASE_OWNER', [
        'INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
        'TRIGGER', 'MAINTAIN'
      ]],
      ['public', 'r', 'pale_orbit_runtime', ['SELECT']],
      ['public', 'S', 'DATABASE_OWNER', ['USAGE', 'SELECT', 'UPDATE']],
      ['public', 'S', 'pale_orbit_runtime', ['USAGE', 'SELECT', 'UPDATE']],
      ['global', 'f', 'DATABASE_OWNER', ['EXECUTE']]
    ] as const) {
      for (const privilege of privileges) {
        expect(
          normalizedDefaultAclTuples,
          `${namespaceName}:${objectType}:${granteeName}:${privilege}`
        ).toContain(
          `('DATABASE_OWNER', '${namespaceName}', '${objectType}', 'DATABASE_OWNER', ` +
          `'${granteeName}', '${privilege}', false)`
        );
      }
    }
    for (const leaseTrigger of [
      'jobs_plan6bii_financial_admin_lease_guard',
      'jobs_plan6bii_financial_admin_terminal_sync'
    ]) {
      expect(financialSchemaManifest, leaseTrigger).toContain(`'${leaseTrigger}'`);
    }
    expect(
      'jobs_plan6bii_financial_admin_lease_guard'.localeCompare(
        'jobs_plan6bii_financial_admin_terminal_sync',
        'en'
      )
    ).toBeLessThan(0);

    expect(financialSchemaManifest).toMatch(
      /\(\s*'table'\s*,\s*'public'\s*,\s*null\s*,\s*'commerce_claim_issuances'/u
    );
    for (const claimColumn of [
      'claim_proof_sha256',
      'auth_token_sha256',
      'normalized_email',
      'anchor_order_id',
      'kind',
      'state',
      'authorized_user_id',
      'issued_at',
      'expires_at',
      'authorized_at',
      'consumed_at',
      'result_disposition',
      'result_changed',
      'result_order_count',
      'result_title_count'
    ]) {
      expect(financialSchemaManifest, claimColumn).toContain(`'${claimColumn}'`);
    }
    for (const claimObject of [
      'commerce_claim_issuances_pkey',
      'commerce_claim_issuances_claim_proof_sha256_valid',
      'commerce_claim_issuances_auth_token_sha256_valid',
      'commerce_claim_issuances_email_normalized',
      'commerce_claim_issuances_kind_valid',
      'commerce_claim_issuances_lifecycle_consistent',
      'commerce_claim_issuances_result_valid',
      'commerce_claim_issuances_timestamp_order',
      'commerce_claim_issuances_anchor_order_id_orders_id_fk',
      'commerce_claim_issuances_authorized_user_id_user_id_fk',
      'commerce_claim_issuances_auth_token_sha256_unique',
      'commerce_claim_issuances_live_email_idx',
      'commerce_claim_issuances_retention_idx'
    ]) {
      expect(financialSchemaManifest, claimObject).toContain(`'${claimObject}'`);
    }
    expect(financialSchemaManifest).toContain(
      'Constraint-owned indexes are represented by their constraints'
    );
    expect(financialSchemaManifest).not.toMatch(
      /\(\s*'index'\s*,\s*'public'\s*,\s*'commerce_claim_issuances'\s*,\s*'commerce_claim_issuances_pkey'/u
    );
    for (const cleanupObject of [
      'title_revisions_staging_storage_key_idx',
      'title_revisions_original_storage_key_idx',
      'titles_cover_storage_key_idx',
      'jobs_active_ingest_revision_identity_idx',
      'storage_cleanup_referenced_keys'
    ]) {
      expect(financialSchemaManifest, cleanupObject).toContain(`'${cleanupObject}'`);
    }
    for (const authorityPrimitive of [
      'expected_direct_acl',
      'actual_direct_acl',
      'grantor_name',
      'expected_lock_only_worker_columns',
      'STORAGE_CLEANUP_LOGIN',
      'pale_orbit_storage_cleanup',
      'pg_database_owner',
      'datdba',
      'pg_auth_members',
      'admin_option',
      'inherit_option',
      'set_option',
      'has_schema_privilege',
      'has_table_privilege',
      'has_any_column_privilege',
      'has_function_privilege',
      'storage_cleanup_effective_authority'
    ]) {
      expect(financialSchemaManifest, authorityPrimitive).toContain(authorityPrimitive);
    }
    expect(verifierWitness).toContain('--print-financial-catalog-contract');
    const catalogCalibrationExtraction = verifierWitness.match(
      /function financialCatalogCalibrationContractSql[\s\S]*?function financialCatalogCalibrationSql/u
    )?.[0] ?? '';
    expect(catalogCalibrationExtraction).not.toBe('');
    expect(catalogCalibrationExtraction).toContain(
      "() => 'null::jsonb'"
    );
    expect(catalogCalibrationExtraction).toMatch(
      /contract\.replace\([\s\S]*?\(\) => 'null::jsonb'[\s\S]*?\)/u
    );
    expect(catalogCalibrationExtraction).toContain(
      "calibrationContract.includes('$catalog$')"
    );
    expect(catalogCalibrationExtraction).not.toMatch(
      /replace\([^\n]+,\s*'null::jsonb'\)/u
    );
    expect(verifierWitness).toContain('JSON.parse(row.actual_catalog_json)');
    expect(verifierWitness).toContain(
      'alter table public.entitlement_grants disable trigger all'
    );
    expect(verifierWitness).toContain(
      'alter table public.entitlement_grants enable trigger all'
    );
    expect(financialWitnessHarnessSource).toContain('directNodeHarnessEnvironment()');
    const boundedHarnessTimeout = ['financial', 'WitnessHarnessTimeoutMs'].join('');
    const boundedHarnessRunner = ['runBounded', 'FinancialWitnessHarness'].join('');
    const timeoutCleanup = ['cleanupTimedOut', 'FinancialWitnessHarness'].join('');
    const timeoutLiteral = ['1', '_200_000'].join('');
    expect(financialWitnessHarnessSource).toContain(
      `const ${boundedHarnessTimeout} = ${timeoutLiteral}`
    );
    expect(financialWitnessHarnessSource).toContain(`async function ${boundedHarnessRunner}`);
    expect(financialWitnessHarnessSource).toContain(`function ${timeoutCleanup}`);
    expect(financialWitnessHarnessSource).toContain(['task', 'kill.exe'].join(''));
    expect(financialWitnessHarnessSource).toContain(
      ["'down'", "'--volumes'", "'--remove-orphans'"].join(', ')
    );
    expect(financialWitnessHarnessSource).toContain(
      ['pale-orbit-test-', 'storage-'].join('')
    );
    expect(financialWitnessHarnessSource).toContain(
      'npm_execpath is required for the direct Node test-database harness'
    );
    const lockOnlyWorkerColumns = Array.from(
      financialSchemaManifest.matchAll(
        /\(\s*'pale_orbit_financial_worker'\s*,\s*'(?<table>[a-z_][a-z0-9_]*)'\s*,\s*'id'\s*,\s*'UPDATE'\s*\)/gu
      ),
      (match) => match.groups?.table ?? ''
    ).filter(Boolean);
    expect(new Set(lockOnlyWorkerColumns).size).toBe(11);
    expect(financialSchemaManifest).toMatch(
      /actual_direct_acl[\s\S]*acl\.privilege_type = 'UPDATE'[\s\S]*expected_lock_only_worker_columns/u
    );
    expect(financialSchemaManifest).toMatch(
      /expected_direct_acl[\s\S]*'DATABASE_OWNER'[\s\S]*actual_direct_acl[\s\S]*grantor\.role_label/u
    );
    for (const databaseGroup of [
      'pale_orbit_runtime',
      'pale_orbit_financial_worker',
      'pale_orbit_storage_cleanup'
    ]) {
      expect(financialSchemaManifest, `${databaseGroup} database CONNECT`).toMatch(
        new RegExp(
          `'database'\\s*,\\s*null\\s*,\\s*null\\s*,\\s*'CURRENT_DATABASE'\\s*,\\s*null\\s*,\\s*null\\s*,\\s*'${databaseGroup}'\\s*,\\s*'CONNECT'\\s*,\\s*false`,
          'u'
        )
      );
    }
    for (const publicDatabasePrivilege of ['CONNECT', 'TEMPORARY']) {
      expect(financialSchemaManifest, `PUBLIC database ${publicDatabasePrivilege}`).toMatch(
        new RegExp(
          `'database'\\s*,\\s*null\\s*,\\s*null\\s*,\\s*'CURRENT_DATABASE'\\s*,\\s*null\\s*,\\s*null\\s*,\\s*'PUBLIC'\\s*,\\s*'${publicDatabasePrivilege}'\\s*,\\s*false`,
          'u'
        )
      );
    }
    expect(financialSchemaManifest).toMatch(
      /actual_direct_acl[\s\S]*pg_catalog\.pg_database[\s\S]*pg_catalog\.aclexplode\(database_row\.datacl\)[\s\S]*database_row\.datname = pg_catalog\.current_database\(\)[\s\S]*acl\.grantee <> database_row\.datdba/u
    );
    expect(financialSchemaManifest).toMatch(
      /database_direct_acl_count_mismatch[\s\S]*actual_direct_acl[\s\S]*object_kind = 'database'[\s\S]*<> 5/u
    );
    expect(financialSchemaManifest).toMatch(
      /missing-cleanup-connect[\s\S]*has_database_privilege\([\s\S]*pg_catalog\.current_database\(\)[\s\S]*'CONNECT'/u
    );
    expect(financialSchemaManifest).toMatch(
      /cleanup-login-direct-database-acl[\s\S]*pg_catalog\.pg_database[\s\S]*pg_catalog\.aclexplode\(database_row\.datacl\)[\s\S]*database_row\.datname = pg_catalog\.current_database\(\)[\s\S]*acl\.grantee = login\.oid/u
    );
    expect(financialSchemaManifest).toMatch(
      /relation_row\.relname in \([\s\S]*?'guest_identities'[\s\S]*?'outbox_messages'[\s\S]*?'entitlement_grants'[\s\S]*?'entitlements'[\s\S]*?'jobs'[\s\S]*?'financial_admin_commands'[\s\S]*?'financial_admin_job_claims'[\s\S]*?\)/u
    );
    for (const forbiddenTypeName of forbiddenRetiredTypeNames) {
      expect(financialSchemaManifest, forbiddenTypeName).toContain(`'${forbiddenTypeName}'`);
    }
    for (const forbiddenColumnKey of forbiddenLegacyColumnKeys) {
      const [tableName, columnName] = forbiddenColumnKey.split(':');
      expect(financialSchemaManifest, forbiddenColumnKey).toMatch(
        new RegExp(`'${tableName}'\\s*,\\s*'${columnName}'`, 'u')
      );
    }
    for (const columnName of [
      'id',
      'topic',
      'payload',
      'deduplication_key',
      'dispatch_job_id'
    ]) {
      expect(financialSchemaManifest, `runtime outbox INSERT ${columnName}`).toMatch(
        new RegExp(
          `'outbox_messages'\\s*,\\s*'outbox_messages'\\s*,\\s*null\\s*,\\s*'${columnName}'\\s*,\\s*'pale_orbit_runtime'\\s*,\\s*'INSERT'`,
          'u'
        )
      );
    }
    for (const columnName of ['status', 'last_error', 'delivered_at', 'updated_at']) {
      expect(financialSchemaManifest, `worker outbox UPDATE ${columnName}`).toMatch(
        new RegExp(
          `'outbox_messages'\\s*,\\s*'outbox_messages'\\s*,\\s*null\\s*,\\s*'${columnName}'\\s*,\\s*'pale_orbit_financial_worker'\\s*,\\s*'UPDATE'`,
          'u'
        )
      );
    }

    for (const constraintName of [
      'financial_reconciliation_issues_occurrence_positive',
      'financial_reconciliation_issues_resolution_consistent',
      'financial_reconciliation_issues_safe_vocabulary',
      'financial_reconciliation_issues_observation_order'
    ]) {
      expect(financialSchemaManifest, constraintName).toMatch(
        new RegExp(
          `\\(\\s*'constraint'\\s*,\\s*'public'\\s*,\\s*'financial_reconciliation_issues'\\s*,\\s*'${constraintName}'`,
          'u'
        )
      );
      expect(verifierWitness, constraintName).toContain(constraintName);
    }
    const financialAdminWitnessLabelAllowlist = [
      'financial administrator four-claim one-row capability matrix',
      'financial administrator current lease renewal',
      'financial administrator terminal lease invalidation',
      'cross-job financial administrator capability rejection',
      'financial command enum order drift',
      'financial command enum order repair',
      'financial command table descriptor drift',
      'financial command table descriptor repair',
      'financial claim table descriptor drift',
      'financial claim table descriptor repair',
      'financial claim protected table owner drift',
      'financial claim protected table owner repair',
      'financial claim protected table persistence drift',
      'financial claim protected table persistence repair',
      'financial claim clear capability column',
      'financial claim clear capability column repair',
      'financial claim capability digest constraint drift',
      'financial claim capability digest constraint repair',
      'financial claim lifecycle constraint drift',
      'financial claim lifecycle constraint repair',
      'financial claim generation attempt constraint drift',
      'financial claim generation attempt constraint repair',
      'financial claim pending rerun authority',
      'financial claim job attempt authority drift',
      'financial claim job attempt authority repair',
      'financial claim pending rerun cleanup',
      'financial claim helper definition drift',
      'financial claim helper definition repair',
      'financial claim helper owner drift',
      'financial claim helper owner repair',
      'financial claim helper SECURITY DEFINER drift',
      'financial claim helper SECURITY DEFINER repair',
      'financial claim helper search_path drift',
      'financial claim helper search_path repair',
      'financial claim helper direct EXECUTE drift',
      'financial claim helper direct EXECUTE repair',
      'financial claim helper PUBLIC EXECUTE drift',
      'financial claim helper PUBLIC EXECUTE repair',
      'financial lease trigger disabled',
      'financial lease trigger enabled repair',
      'financial lease terminal trigger order drift',
      'financial lease terminal trigger order repair',
      'financial job guard definition drift',
      'financial job guard definition repair',
      'financial audit guard definition drift',
      'financial audit guard definition repair',
      'financial command runtime jobs.payload SELECT',
      'financial command runtime jobs.payload SELECT repair',
      'financial command runtime private input SELECT',
      'financial command runtime private input SELECT repair',
      'financial command worker private input UPDATE',
      'financial command worker private input UPDATE repair',
      'financial claim application table privilege',
      'financial claim application table privilege repair',
      'financial routine PUBLIC EXECUTE',
      'financial routine PUBLIC EXECUTE repair',
      'financial routine direct login EXECUTE',
      'financial routine direct login EXECUTE repair',
      'unexpected runtime routine EXECUTE',
      'unexpected runtime routine EXECUTE repair',
      'unexpected worker routine EXECUTE',
      'unexpected worker routine EXECUTE repair',
      'financial direct login database ACL',
      'financial direct login database ACL repair',
      'missing runtime financial routine EXECUTE',
      'missing runtime financial routine EXECUTE repair',
      'missing worker financial routine EXECUTE',
      'missing worker financial routine EXECUTE repair',
      'missing reporting-correction resolver',
      'missing reporting-correction resolver repair',
      'excess reporting-correction resolver overload',
      'excess reporting-correction resolver overload repair',
      'reporting-correction resolver owner drift',
      'reporting-correction resolver owner repair',
      'reporting-correction resolver security drift',
      'reporting-correction resolver security repair',
      'reporting-correction resolver search_path drift',
      'reporting-correction resolver search_path repair',
      'reporting-correction resolver definition drift',
      'reporting-correction resolver definition repair',
      'PUBLIC reporting-correction resolver EXECUTE',
      'PUBLIC reporting-correction resolver EXECUTE repair',
      'runtime reporting-correction resolver EXECUTE',
      'runtime reporting-correction resolver EXECUTE repair',
      'direct-login reporting-correction resolver EXECUTE',
      'direct-login reporting-correction resolver EXECUTE repair',
      'reporting-correction resolver worker grant-option drift',
      'reporting-correction resolver worker grant-option repair',
      'financial routine SECURITY DEFINER search_path drift',
      'financial routine SECURITY DEFINER search_path repair',
      'financial routine owner drift',
      'financial routine owner repair',
      'missing runtime future table SELECT',
      'runtime future table SELECT repair',
      'missing runtime future sequence privileges',
      'runtime future sequence privileges repair',
      'excess worker default table privilege',
      'excess worker default table privilege repair',
      'excess storage default privilege',
      'excess storage default privilege repair',
      'excess direct-login default privilege',
      'excess direct-login default privilege repair',
      'reintroduced PUBLIC default routine EXECUTE',
      'PUBLIC default routine EXECUTE repair',
      'default ACL namespace object-type drift',
      'default ACL namespace object-type repair',
      'default ACL grant option drift',
      'default ACL grant option repair',
      'default ACL owner drift',
      'default ACL owner drift repair',
      'default ACL grantor drift',
      'default ACL grantor drift repair',
      'inherited runtime SELECT on protected financial table',
      'inherited runtime SELECT on protected financial table repair',
      'inherited application EXECUTE on private lease helper',
      'inherited application EXECUTE on private lease helper repair',
      'column-compatible false required view',
      'required view definition repair',
      'required function definition mismatch',
      'required function definition repair',
      'fail-open financial issue transition predecessor',
      'fail-closed financial issue transition repair',
      'unexpected protected function overload',
      'unexpected protected function overload repair',
      'required trigger definition mismatch',
      'required trigger definition repair',
      'required index definition mismatch',
      'required index definition repair',
      'omitted financial issue constraint definition mismatch',
      'omitted financial issue constraint definition repair',
      'claim function definition mismatch',
      'claim function definition repair',
      'claim function direct ACL mismatch',
      'claim function direct ACL repair',
      'database fixed-group CONNECT grant option mismatch',
      'database fixed-group CONNECT grant option repair',
      'unexpected fixed-group database TEMPORARY ACL',
      'unexpected fixed-group database TEMPORARY ACL repair',
      'unexpected claim function overload',
      'unexpected claim function overload repair',
      'claim constraint definition mismatch',
      'claim constraint definition repair',
      'claim index definition mismatch',
      'claim index definition repair',
      'sensitive relation direct ACL mismatch',
      'sensitive relation direct ACL repair',
      'active ingest index definition mismatch',
      'active ingest index definition repair',
      'PUBLIC cleanup function execute',
      'PUBLIC cleanup function execute repair',
      'missing cleanup group schema USAGE',
      'cleanup group schema USAGE repair',
      'cleanup login direct grantable CONNECT',
      'cleanup login direct grantable CONNECT repair',
      'cleanup login direct TEMPORARY',
      'cleanup login direct TEMPORARY repair',
      'unsafe cleanup membership flags',
      'cleanup membership flags repair',
      'unsafe cleanup role attributes',
      'cleanup role attributes repair',
      'inherited cleanup relation authority via PUBLIC SELECT',
      'inherited cleanup relation authority repair',
      'unexpected protected constraint',
      'unexpected protected constraint repair',
      'unexpected protected explicit index',
      'unexpected protected explicit index repair',
      'unexpected protected trigger',
      'unexpected protected trigger repair',
      'protected table RLS drift',
      'protected table RLS drift repair',
      'disabled protected constraint triggers',
      'disabled protected constraint triggers repair',
      'enum label inventory drift',
      'enum label inventory drift repair',
      'touched legacy column descriptor drift',
      'touched legacy column descriptor drift repair',
      'forbidden retired type',
      'forbidden retired type repair',
      'forbidden retired column',
      'forbidden retired column repair',
      'sensitive relation physical state drift',
      'sensitive relation physical state drift repair',
      'inbound protected foreign key',
      'inbound protected foreign key repair',
      'protected table rule inventory drift',
      'protected table rule inventory drift repair',
      'protected table inheritance edge',
      'protected table inheritance edge repair',
      'missing runtime outbox INSERT ACL',
      'missing runtime outbox INSERT ACL repair',
      'excess worker outbox UPDATE ACL',
      'excess worker outbox UPDATE ACL repair'
    ] as const;
    for (const witnessLabel of financialAdminWitnessLabelAllowlist) {
      expect(verifierWitness, witnessLabel).toContain(witnessLabel);
    }
    const financialAdminCatalogWitnessRegion = verifierWitness.match(
      /async function exerciseFinancialAdminCatalogWitnesses[\s\S]*?\r?\n\}\r?\n\r?\nasync function exerciseInvariantWitnesses/u
    )?.[0] ?? '';
    const implementedFinancialAdminCatalogWitnessLabels = Array.from(
      financialAdminCatalogWitnessRegion.matchAll(
        /await expect(?:Pass|Rejection|RejectionChecks)\(\s*'(?<label>[^']+)'/gu
      ),
      (match) => match.groups?.label ?? ''
    ).filter(Boolean);
    expect(implementedFinancialAdminCatalogWitnessLabels.length).toBeGreaterThan(0);
    for (const implementedLabel of implementedFinancialAdminCatalogWitnessLabels) {
      expect(financialAdminWitnessLabelAllowlist, implementedLabel).toContain(
        implementedLabel
      );
    }
    const clearCapabilityPersistenceScan = verifierWitness.match(
      /const clearPersistenceTargets = await pool\.query[\s\S]*?financial administrator clear capability was persisted/u
    )?.[0] ?? '';
    expect(clearCapabilityPersistenceScan).toContain('pg_catalog.pg_class');
    expect(clearCapabilityPersistenceScan).toContain('pg_catalog.pg_namespace');
    expect(clearCapabilityPersistenceScan).toContain('pg_catalog.pg_attribute');
    expect(clearCapabilityPersistenceScan).toContain("namespace.nspname = 'public'");
    expect(clearCapabilityPersistenceScan).toContain("relation.relkind in ('r', 'p')");
    expect(clearCapabilityPersistenceScan).toContain('attribute.attnum > 0');
    expect(clearCapabilityPersistenceScan).toContain('not attribute.attisdropped');
    expect(clearCapabilityPersistenceScan).toContain(
      "pg_catalog.format('%I.%I', namespace.nspname, relation.relname)"
    );
    expect(clearCapabilityPersistenceScan).toContain(
      "pg_catalog.format('%I', attribute.attname)"
    );
    expect(clearCapabilityPersistenceScan).toContain(
      'for (const target of clearPersistenceTargets.rows)'
    );
    expect(clearCapabilityPersistenceScan).toContain('${target.quotedColumn}::text');
    expect(clearCapabilityPersistenceScan).toContain(
      'select pg_catalog.count(*)::text as match_count'
    );
    expect(clearCapabilityPersistenceScan).toContain('$1::text[]');
    expect(clearCapabilityPersistenceScan).toContain('pg_catalog.strpos(');
    expect(clearCapabilityPersistenceScan).not.toContain('pg_catalog.position(');
    expect(clearCapabilityPersistenceScan).toContain('coalesce(');
    expect(clearCapabilityPersistenceScan).not.toContain('pg_catalog.coalesce(');
    expect(clearCapabilityPersistenceScan).not.toContain('persisted_values');
    expect(clearCapabilityPersistenceScan).not.toContain('job.payload::text');
    expect(clearCapabilityPersistenceScan).not.toMatch(/console\.(?:debug|info|log|warn|error)/u);
    for (const jobsColumn of ['last_error', 'locked_by', 'deduplication_key']) {
      expect(clearCapabilityPersistenceScan, `jobs.${jobsColumn}`).toContain(
        `'${jobsColumn}'`
      );
    }
    expect(verifierWitness).toMatch(
      /alter function public\.financial_admin_command_status\(uuid,uuid\)[\s\S]{0,100}?security invoker[\s\S]{0,200}?alter function public\.financial_admin_command_status\(uuid,uuid\)[\s\S]{0,100}?set search_path = 'public'/u
    );
    expect(verifierWitness).not.toMatch(
      /create or replace function public\.financial_admin_command_status\(uuid,uuid\)[\s\S]{0,100}?returns table/u
    );
  });

  it('mirrors the exact financial issue resource, code, and impact triples into restore checks', async () => {
    const [migration, financialVerifier, financialRunbook, verifierWitness] = await Promise.all([
      source('drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql'),
      source('scripts/verify-financial-restore.sql'),
      source('docs/stripe-financial-reconciliation.md'),
      source('scripts/execute-financial-restore-verifier.ts')
    ]);
    const migrationPairs = migrationFinancialIssuePairs(migration);
    const expectedTriples = expectedFinancialIssueTriples(migrationPairs);
    const verifierTriples = verifierFinancialIssueTriples(financialVerifier);
    const documentedOrphanSql = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore orphan check'),
      'sql'
    )[0];
    const semanticImpactConstraint = migration.match(
      /add constraint "financial_reconciliation_issues_semantic_impact" check \((?<expression>[\s\S]*?)\);--> statement-breakpoint/iu
    )?.groups?.expression;

    expect(migrationPairs).toHaveLength(48);
    expect(expectedTriples).toHaveLength(48);
    expect(expectedTriples.filter((triple) => triple.endsWith(':pending'))).toHaveLength(8);
    expect(expectedTriples.filter((triple) => triple.endsWith(':exception'))).toHaveLength(40);
    expect(expectedTriples.some((triple) => triple.endsWith(':informational'))).toBe(false);
    expect(verifierTriples).toEqual(expectedTriples);
    expect(verifierFinancialIssueTriples(documentedOrphanSql ?? '')).toEqual(expectedTriples);
    expect(semanticImpactConstraint).toBeDefined();
    expect(semanticImpactConstraint).toContain("'allocation_incomplete'");
    expect(semanticImpactConstraint).toContain("'missing_source'");
    expect(semanticImpactConstraint).toContain("'pending'");
    expect(semanticImpactConstraint).toContain("'exception'");
    expect(semanticImpactConstraint).not.toContain("'informational'");
    const financialSchemaManifest = financialVerifier.match(
      /-- BEGIN financial_schema_object_manifest\r?\n(?<sql>[\s\S]*?)\r?\n-- END financial_schema_object_manifest/u
    )?.groups?.sql;
    for (const constraintName of [
      'financial_reconciliation_issues_semantic_identity',
      'financial_reconciliation_issues_semantic_impact',
      'financial_reconciliation_issues_immutable_classification_open'
    ]) {
      expect(financialSchemaManifest, constraintName).toMatch(
        new RegExp(
          `\\(\\s*'constraint'\\s*,\\s*'public'\\s*,\\s*'financial_reconciliation_issues'\\s*,\\s*'${constraintName}'`,
          'u'
        )
      );
    }
    for (const objectName of [
      'plan6b_validate_unknown_classification_issue',
      'plan6b_guard_financial_issue_subject_mutation',
      'financial_classification_versions_unknown_issue_required',
      'payments_financial_issue_subject_guard',
      'refunds_financial_issue_subject_guard',
      'disputes_financial_issue_subject_guard'
    ]) {
      expect(financialSchemaManifest, objectName).toContain(`'${objectName}'`);
    }
    for (const objectName of [
      'plan6b_validate_unknown_classification_issue',
      'plan6b_guard_financial_issue_subject_mutation',
      'financial_classification_versions_unknown_issue_required',
      'payments_financial_issue_subject_guard'
    ]) {
      expect(verifierWitness, objectName).toContain(objectName);
    }
    for (const witnessLabel of [
      'missing unknown-classification companion trigger',
      'unknown-classification companion trigger repair',
      'missing payment financial issue subject guard',
      'payment financial issue subject guard repair',
      'impossible financial issue impact',
      'financial issue semantic impact repair'
    ]) {
      expect(verifierWitness, witnessLabel).toContain(witnessLabel);
    }
  });

  it('accepts only canonical worker and scoped administrator resolution audits', async () => {
    const [financialVerifier, financialRunbook, verifierWitness] = await Promise.all([
      source('scripts/verify-financial-restore.sql'),
      source('docs/stripe-financial-reconciliation.md'),
      source('scripts/execute-financial-restore-verifier.ts')
    ]);
    const verifierAuditSql = financialVerifier.match(
      /-- BEGIN resolved_issue_audit_provenance\r?\n(?<sql>[\s\S]*?)\r?\n-- END resolved_issue_audit_provenance/u
    )?.groups?.sql ?? '';
    const documentedAuditSql = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore resolved issue audit check'),
      'sql'
    )[0] ?? '';
    const expectedLegacyPairs = [
      'allocation_set:allocation_mismatch',
      'allocation_set:classification_fork',
      'allocation_set:correction_rebase_required',
      'allocation_set:currency_mismatch',
      'allocation_set:immutable_mismatch',
      'allocation_set:source_linkage_mismatch',
      'allocation_set:unsupported_category',
      'dispute:allocation_fork',
      'dispute:allocation_incomplete',
      'dispute:allocation_mismatch',
      'dispute:classification_fork',
      'dispute:correction_rebase_required',
      'dispute:currency_mismatch',
      'dispute:immutable_mismatch',
      'dispute:missing_source',
      'dispute:source_linkage_mismatch',
      'dispute:unsupported_category'
    ].sort();

    expect(legacyCommerceWorkerIssuePairs(verifierAuditSql)).toEqual(expectedLegacyPairs);
    expect(legacyCommerceWorkerIssuePairs(documentedAuditSql)).toEqual(expectedLegacyPairs);
    expect(documentedAuditSql.trim().replace(/\s+/gu, ' ')).toBe(
      verifierAuditSql.trim().replace(/\s+/gu, ' ')
    );
    expect(verifierAuditSql).toContain("audit.actor_id = 'financial-worker'");
    expect(verifierAuditSql).toContain("audit.actor_id = 'commerce-worker'");
    for (const auditSql of [verifierAuditSql, documentedAuditSql]) {
      expect(auditSql).toContain('audit.before is null');
      expect(auditSql).toContain('audit.request_metadata is null');
      expect(auditSql).toContain("audit.after - 'commandId'");
      expect(auditSql).toContain(
        "jsonb_typeof(audit.after -> 'commandId') = 'string'"
      );
      expect(auditSql).toContain(
        "pg_input_is_valid(audit.after ->> 'commandId', 'uuid')"
      );
      expect(auditSql).toContain('from financial_admin_commands command');
      expect(auditSql).toContain(
        "command.id::text = audit.after ->> 'commandId'"
      );
      expect(auditSql).toContain(
        'command.actor_user_id = issue.resolved_by_admin_id'
      );
      expect(auditSql).toContain(
        'command.correlation_id = audit.correlation_id'
      );
      expect(auditSql).toContain("command.status = 'succeeded'");
      expect(auditSql).toContain("command.kind = 'refund_allocation_finalize'");
      expect(auditSql).toContain(
        "command.kind = 'refund_reporting_correction_create'"
      );
    }
    for (const witnessLabel of [
      'administrator command-bound resolution audit',
      'administrator resolution audit rejects an unrelated command',
      'administrator resolution audit command repair',
      'resolution audit rejects a before payload',
      'resolution audit before payload repair',
      'resolution audit rejects request metadata',
      'resolution audit request metadata repair',
      'legacy commerce-worker dispute resolution audit',
      'legacy commerce-worker allocation-set resolution audit',
      'commerce-worker cannot resolve a payout issue',
      'commerce-worker cannot resolve an unrelated allocation-set issue',
      'legacy commerce-worker audit witness repair'
    ]) {
      expect(verifierWitness, witnessLabel).toContain(witnessLabel);
    }
  });

  it('rejects foreign exact-name restore resources before any Compose or volume mutation', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');

    for (const service of [
      'postgres',
      'app',
      'worker',
      'migrate',
      'database-role-provision',
      'bootstrap-admin',
      'storage-cleanup',
      'caddy'
    ]) {
      expect(restorePowerShell).toContain(`\${restoreProject}-${service}-1`);
      expect(restoreShell).toContain(`\${restore_project}-${service}-1`);
    }
    for (const resource of [
      'default',
      'postgres_data',
      'book_storage',
      'caddy_data',
      'caddy_config'
    ]) {
      expect(restorePowerShell).toContain(`\${restoreProject}_${resource}`);
      expect(restoreShell).toContain(`\${restore_project}_${resource}`);
    }
    expect(restorePowerShell).toContain("--filter \"name=$exactName\"");
    expect(restorePowerShell).toContain("--format '{{.Names}}'");
    expect(restorePowerShell).toContain("--format '{{.Name}}'");
    expect(restoreShell).toContain('--filter "name=$exact_name"');
    expect(restoreShell).toContain("--format '{{.Names}}'");
    expect(restoreShell).toContain("--format '{{.Name}}'");

    const powerShellPreflight = restorePowerShell.indexOf(
      '$preflightInventory = Get-RestoreProjectInventory'
    );
    const shellPreflight = restoreShell.indexOf(
      'preflight_inventory="$(get_restore_project_inventory)"'
    );
    expect(powerShellPreflight).toBeGreaterThan(-1);
    expect(shellPreflight).toBeGreaterThan(-1);
    expect(powerShellPreflight).toBeLessThan(restorePowerShell.indexOf('up --detach --wait postgres'));
    expect(shellPreflight).toBeLessThan(restoreShell.indexOf('compose_restore up --detach --wait postgres'));
    expect(powerShellPreflight).toBeLessThan(restorePowerShell.indexOf('_book_storage:/restore'));
    expect(shellPreflight).toBeLessThan(restoreShell.indexOf('_book_storage:/restore'));
  });

  it('authenticates deterministic source baselines and checks source invariants while quiesced', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const backupPowerShell = fencedCodeBlocks(backupSection, 'powershell').join('\n');
    const backupShell = fencedCodeBlocks(backupSection, 'sh').join('\n');
    const sourceRequiredFiles = [
      'database.dump',
      'storage.tar.gz',
      'migration-journal.csv',
      'application-image.json',
      'restore-row-counts.csv',
      'storage-samples.csv',
      'source-docker-engine.json',
      'financial-operational-diagnostics.csv',
      'verify-financial-restore.sql'
    ];

    for (const requiredFile of sourceRequiredFiles) {
      expect(backupSection, requiredFile).toContain(requiredFile);
      expect(integritySection, requiredFile).toContain(requiredFile);
    }
    expect(backupSection).toContain('exactly nine required plaintext files');
    expect(integritySection).toContain('containing the nine required files');
    for (const script of [backupPowerShell, backupShell]) {
      const stopIndex = script.indexOf('stop app worker');
      const verifierIndex = script.lastIndexOf('verify-financial-restore.sql');
      const rowCountIndex = script.lastIndexOf('restore-row-counts.csv');
      const sampleIndex = script.lastIndexOf('storage-samples.csv');
      expect(stopIndex).toBeGreaterThan(-1);
      expect(verifierIndex).toBeGreaterThan(stopIndex);
      expect(rowCountIndex).toBeGreaterThan(stopIndex);
      expect(sampleIndex).toBeGreaterThan(stopIndex);
      expect(script).toContain('capture-restore-row-counts.sql');
      expect(script).toContain('capture-storage-samples.sql');
      expect(script).toMatch(/verify-financial-restore\.sql[^\n]*(?:ON_ERROR_STOP|psql)/u);
    }
    expect(backupPowerShell).toContain('ConvertTo-CanonicalBackupText');
    expect(backupPowerShell).toContain(
      '$utf8NoBom = [System.Text.UTF8Encoding]::new($false)'
    );
    for (const canonicalTextFile of [
      'migration-journal.csv',
      'restore-row-counts.csv',
      'storage-samples.csv',
      'application-image.json',
      'source-docker-engine.json'
    ]) {
      expect(backupPowerShell, canonicalTextFile).toMatch(
        new RegExp(`WriteAllText\\([^\\n]*${canonicalTextFile.replaceAll('.', '\\.')}`, 'u')
      );
    }
    expect(backupPowerShell).not.toMatch(/Set-Content[^\n]*-Encoding utf8\b/u);
    expect(backupShell).toContain('LC_ALL=C');
    expect(backupSection).not.toMatch(/\bup\b[^\n]*\bworker\b/u);
  });

  it('confines the executable verifier witness to a disposable local test database', () => {
    for (const identity of ['Web', 'Worker', 'StorageCleanup'] as const) {
      expect(ownerRestoreVerifierLauncher).toContain(`migration${identity}User`);
      expect(ownerRestoreVerifierLauncher).toContain(
        `ownerEnvironment.DATABASE_MIGRATION_${
          identity === 'StorageCleanup' ? 'STORAGE_CLEANUP' : identity.toUpperCase()
        }_USER = migration${identity}User`
      );
    }
    expect(ownerRestoreVerifierLauncher.indexOf('const migrationWebUser'))
      .toBeLessThan(
        ownerRestoreVerifierLauncher.indexOf(
          "const ownerEnvironment = databaseEnvironmentForRole"
        )
      );
    expect(ownerRestoreVerifierLauncher).not.toMatch(/console\.(?:info|log).*migration\w+User/u);

    const baseEnvironment = {
      ...process.env,
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '1',
      DATABASE_NAME: 'pale_orbit_test',
      DATABASE_USER: 'pale_orbit_test',
      DATABASE_PASSWORD: 'not-used'
    };
    const productionAttempt = spawnSync(
      process.execPath,
      ['--import', 'tsx', restoreVerifierWitnessPath],
      { encoding: 'utf8', env: { ...baseEnvironment, APP_ENV: 'production' } }
    );
    expect(productionAttempt.status).not.toBe(0);
    expect(productionAttempt.stderr).toContain(
      '[restore-verifier] refusing a non-disposable test database'
    );
    expect(productionAttempt.stderr).not.toContain('ECONNREFUSED');

    const unsupportedArgument = spawnSync(
      process.execPath,
      ['--import', 'tsx', restoreVerifierWitnessPath, '--unexpected-mutation'],
      { encoding: 'utf8', env: { ...baseEnvironment, APP_ENV: 'test' } }
    );
    expect(unsupportedArgument.status).not.toBe(0);
    expect(unsupportedArgument.stderr).toContain(
      '[restore-verifier] unsupported command-line arguments'
    );
    expect(unsupportedArgument.stderr).not.toContain('ECONNREFUSED');

    const malformedPort = spawnSync(
      process.execPath,
      ['--import', 'tsx', restoreVerifierWitnessPath],
      {
        encoding: 'utf8',
        env: { ...baseEnvironment, APP_ENV: 'test', DATABASE_PORT: '1garbage' }
      }
    );
    expect(malformedPort.status).not.toBe(0);
    expect(malformedPort.stderr).toContain('[restore-verifier] DATABASE_PORT is invalid');
    expect(malformedPort.stderr).not.toContain('ECONNREFUSED');

    const sourceExtractorSmoke = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        restoreVerifierWitnessPath,
        '--print-financial-catalog-contract'
      ],
      {
        encoding: 'utf8',
        env: {
          ...baseEnvironment,
          APP_ENV: 'test',
          DATABASE_OWNER_USER: 'pale_orbit_test',
          DATABASE_MIGRATION_WEB_USER: 'pale_orbit_test_web',
          DATABASE_MIGRATION_WORKER_USER: 'pale_orbit_test_worker',
          DATABASE_MIGRATION_STORAGE_CLEANUP_USER: 'pale_orbit_test_storage_cleanup'
        }
      }
    );
    expect(sourceExtractorSmoke.status).not.toBe(0);
    expect(sourceExtractorSmoke.stderr).toContain('ECONNREFUSED');
    expect(sourceExtractorSmoke.stderr).not.toContain('expected one canonical');
  }, 20_000);

  it('times and scopes every verifier expectation on one transaction-recovered session', async () => {
    const [verifierWitness, financialVerifier] = await Promise.all([
      source('scripts/execute-financial-restore-verifier.ts'),
      source('scripts/verify-financial-restore.sql')
    ]);
    const verifierOutcomeSource = verifierWitness.match(
      /async function verifierOutcome[\s\S]*?\r?\n\}\r?\n\r?\nfunction financialCatalogContractSql/u
    )?.[0] ?? '';
    const invariantWitnessSource = verifierWitness.match(
      /async function exerciseInvariantWitnesses\(\): Promise<void> \{[\s\S]*?\r?\n\}\r?\n\r?\ntry \{/u
    )?.[0] ?? '';
    expect(verifierOutcomeSource).not.toContain('new Pool(');
    expect(verifierOutcomeSource).toContain('persistentVerifierClient()');
    expect(verifierOutcomeSource).toContain("client.query('rollback')");
    expect(verifierOutcomeSource).toContain(
      "client.query('drop table if exists pg_temp.restore_financial_checks')"
    );
    expect(verifierOutcomeSource.indexOf("client.query('rollback')")).toBeLessThan(
      verifierOutcomeSource.indexOf(
        "client.query('drop table if exists pg_temp.restore_financial_checks')"
      )
    );
    expect(verifierWitness).toContain('[restore-verifier] BEGIN expectation');
    expect(verifierWitness).toContain('[restore-verifier] END expectation');
    expect(verifierWitness.match(/verifierOutcome\(name, scope\)/gu)).toHaveLength(4);
    expect(verifierWitness).toContain('release(true)');
    expect(verifierWitness).toContain('function exactVerifierFailureList(');
    expect(verifierWitness).toContain('function parsedVerifierFailureList(');
    expect(verifierWitness).toContain('actualFailures.length !== expectedFailures.length');
    expect(verifierWitness).toContain(
      'new Set(actualFailures).size !== actualFailures.length'
    );
    expect(verifierWitness).toContain(
      'new Set(expectedFailures).size !== expectedFailures.length'
    );
    expect(verifierWitness).toContain('const failWitness = (message: string): never =>');
    expect(verifierWitness).toContain('expected verifier failures ${expected} but received ${actual}');
    expect(invariantWitnessSource).toMatch(
      /if \(outcome\.error\) \{\s*const actualFailures = parsedVerifierFailureList\(outcome\.error\);\s*if \(actualFailures !== null\) \{\s*failWitness\(`\$\{name\} unexpectedly failed with \$\{actualFailures\.join\(', '\)\}`\);\s*\}\s*failWitness\(`\$\{name\} unexpectedly failed`\);\s*\}/u
    );
    expect(verifierWitness).not.toContain('failures.push(');
    expect(verifierWitness).not.toContain('calibrationMismatches');
    expect(verifierWitness).not.toContain('restore-verifier-calibration');
    expect(invariantWitnessSource).not.toContain('.message');
    expect(invariantWitnessSource).not.toContain('failures.length');
    expect(invariantWitnessSource).not.toContain('failures.join(');
    expect(verifierWitness).not.toContain(': ${outcome.error.message}');
    expect(verifierWitness).not.toContain(': ${error.message}');
    expect(verifierOutcomeSource).not.toContain('recoveryError.message');
    expect(verifierOutcomeSource).not.toContain('String(recoveryError)');
    expect(verifierWitness).not.toContain('error.message.includes(checkName)');
    expect(verifierWitness).not.toContain(
      "error.message.includes('credential_authority_missing_or_mismatched=1')"
    );
    expect(verifierWitness).toContain(
      "exactVerifierFailureList(actualFailures, ['credential_authority_missing_or_mismatched=1'])"
    );
    expect(verifierWitness).not.toMatch(/['"][a-z_][a-z0-9_]*=['"]/u);
    const exactWitnessFailureList = (witnessName: string): string[] => {
      const witnessLiteral = `'${witnessName}'`;
      expect(verifierWitness.split(witnessLiteral), witnessName).toHaveLength(2);
      const witnessIndex = verifierWitness.indexOf(witnessLiteral);
      const expectationStart = verifierWitness.lastIndexOf('await expectRejection', witnessIndex);
      const expectationEnd = verifierWitness.indexOf(');', witnessIndex);
      expect(expectationStart, witnessName).toBeGreaterThan(-1);
      expect(expectationEnd, witnessName).toBeGreaterThan(witnessIndex);
      return Array.from(
        verifierWitness
          .slice(expectationStart, expectationEnd)
          .matchAll(/'(?<failure>[a-z_][a-z0-9_]*=[1-9][0-9]*)'/gu),
        (match) => match.groups?.failure ?? ''
      ).filter(Boolean).sort();
    };
    for (const [witnessName, exactFailures] of [
      ['financial claim helper direct EXECUTE drift', ['financial_schema_object_manifest=1']],
      ['financial claim helper PUBLIC EXECUTE drift', [
        'financial_schema_object_manifest=1',
        'storage_cleanup_effective_authority=1'
      ]],
      ['financial lease trigger disabled', ['financial_schema_object_manifest=1']],
      ['financial lease terminal trigger order drift', ['financial_schema_object_manifest=1']],
      ['financial command runtime jobs.payload SELECT', ['financial_schema_object_manifest=1']],
      ['financial routine PUBLIC EXECUTE', [
        'financial_schema_object_manifest=1',
        'storage_cleanup_effective_authority=1'
      ]],
      ['financial routine direct login EXECUTE', ['financial_schema_object_manifest=1']],
      ['missing runtime financial routine EXECUTE', ['financial_schema_object_manifest=1']],
      ['missing worker financial routine EXECUTE', ['financial_schema_object_manifest=1']],
      ['missing reporting-correction resolver', ['financial_schema_object_manifest=1']],
      ['excess reporting-correction resolver overload', [
        'financial_schema_object_manifest=1'
      ]],
      ['reporting-correction resolver owner drift', [
        'financial_schema_object_manifest=1'
      ]],
      ['reporting-correction resolver security drift', [
        'financial_schema_object_manifest=1'
      ]],
      ['reporting-correction resolver search_path drift', [
        'financial_schema_object_manifest=1'
      ]],
      ['reporting-correction resolver definition drift', [
        'financial_schema_object_manifest=1'
      ]],
      ['PUBLIC reporting-correction resolver EXECUTE', [
        'financial_schema_object_manifest=1',
        'storage_cleanup_effective_authority=1'
      ]],
      ['runtime reporting-correction resolver EXECUTE', [
        'financial_schema_object_manifest=1'
      ]],
      ['direct-login reporting-correction resolver EXECUTE', [
        'financial_schema_object_manifest=1'
      ]],
      ['reporting-correction resolver worker grant-option drift', [
        'financial_schema_object_manifest=1'
      ]],
      ['missing runtime future table SELECT', ['financial_schema_object_manifest=10']],
      ['missing runtime future sequence privileges', ['financial_schema_object_manifest=7']],
      ['reintroduced PUBLIC default routine EXECUTE', ['financial_schema_object_manifest=2']],
      ['inherited application EXECUTE on private lease helper', [
        'financial_schema_object_manifest=1'
      ]],
      ['fail-open financial issue transition predecessor', [
        'financial_schema_object_manifest=1'
      ]],
      ['claim function direct ACL mismatch', [
        'financial_schema_object_manifest=1',
        'storage_cleanup_effective_authority=1'
      ]],
      ['disabled protected constraint triggers', ['financial_schema_object_manifest=4']],
      ['cleanup login direct grantable CONNECT', [
        'financial_schema_object_manifest=2',
        'storage_cleanup_effective_authority=1'
      ]],
      ['cleanup login direct TEMPORARY', [
        'financial_schema_object_manifest=2',
        'storage_cleanup_effective_authority=1'
      ]],
      ['itemless account allocation still requires an exact parent decision', [
        'allocation_set_detail_classification=1',
        'allocation_set_parent_or_chain=1'
      ]],
      ['itemless account allocation cannot depend on an exact unknown parent', [
        'allocation_set_detail_classification=1',
        'allocation_set_parent_or_chain=1'
      ]],
      ['published payout run ahead of authority', [
        'published_membership_count=1',
        'run_generation_order=1'
      ]],
      ['charge gross allocation cannot masquerade as another component', [
        'financial_item_allocation_semantic_component=1',
        'financial_title_allocation_determinism=1'
      ]],
      ['same-currency payment source-principal corruption', [
        'allocation_set_provider_target=1',
        'allocation_set_semantic_source=2',
        'financial_title_allocation_determinism=1',
        'source_evidence_projection_parity=1'
      ]],
      ['refund component chronology exceeds a bucket capacity', [
        'combined_refund_dispute_chronology_capacity=1',
        'refund_component_chronology_capacity=1',
        'refund_component_deterministic_split=1'
      ]],
      ['same-currency primary-refund source-principal corruption', [
        'allocation_set_provider_target=1',
        'allocation_set_semantic_source=2'
      ]],
      ['pending refund gross correction cannot masquerade as a fee component', [
        'refund_reporting_correction_history_semantics=1',
        'refund_reporting_correction_item_semantics=1'
      ]],
      ['pending correction must cover every nonzero touched settlement base', [
        'refund_reporting_correction_history_semantics=1',
        'reporting_correction_zero_sum=1'
      ]],
      ['pending correction item must retain its source currency', [
        'refund_reporting_correction_history_semantics=1',
        'reporting_correction_zero_sum=2'
      ]],
      ['balanced algorithm-v2 reinstatement tax redistribution is not deterministic', [
        'dispute_v2_reinstatement_component_parity=1',
        'financial_title_allocation_determinism=1'
      ]],
      ['first dispute withdrawal presentment/source-principal corruption', [
        'combined_refund_dispute_chronology_capacity=2',
        'dispute_first_withdrawal_source_principal=1',
        'dispute_item_allocation_graph=1'
      ]],
      ['allocation set names an unrelated existing provider source owner', [
        'allocation_set_parent_or_chain=1',
        'allocation_set_semantic_source=1',
        'combined_refund_dispute_chronology_capacity=3',
        'dispute_item_allocation_graph=1',
        'financial_item_allocation_parent=1'
      ]],
      ['allocation item belongs to an unrelated existing order graph', [
        'dispute_presentment_child_cardinality=1',
        'financial_item_allocation_parent=1'
      ]],
      ['withdrawal current tip has no required dispute presentment child', [
        'dispute_first_withdrawal_source_principal=1',
        'dispute_presentment_child_cardinality=1'
      ]],
      ['withdrawal dispute presentment child cannot have a zero effect', [
        'combined_refund_dispute_chronology_capacity=1',
        'dispute_first_withdrawal_source_principal=1',
        'dispute_presentment_child_cardinality=1'
      ]],
      ['reinstatement cannot cross an immutable withdrawal graph or reverse it twice', [
        'combined_refund_dispute_chronology_capacity=2',
        'dispute_item_allocation_graph=2'
      ]],
      ['refund and dispute events duplicate the full durable chronology tuple', [
        'combined_refund_dispute_chronology_capacity=3'
      ]],
      ['pending-version withdrawal history cannot contain a zero presentment effect', [
        'dispute_presentment_child_cardinality=1',
        'dispute_v2_withdrawal_component_membership=1',
        'financial_title_allocation_determinism=1'
      ]],
      ['algorithm-v2 same-currency reinstatement presentment must match settlement components', [
        'dispute_v2_reinstatement_component_parity=1'
      ]],
      ['reinstatement crosses its withdrawal order item', [
        'combined_refund_dispute_chronology_capacity=1',
        'dispute_item_allocation_graph=1'
      ]],
      ['refund component violates the deterministic two-bucket split', [
        'combined_refund_dispute_chronology_capacity=1',
        'refund_component_deterministic_split=1'
      ]]
    ] as const) {
      expect(exactWitnessFailureList(witnessName), witnessName).toEqual(
        [...exactFailures].sort()
      );
    }
    expect(verifierWitness).toMatch(
      /Each verifier transaction uses READ COMMITTED[\s\S]*committed witness mutations/u
    );

    const beginMarker = '-- BEGIN financial_schema_object_manifest';
    const endMarker = '-- END financial_schema_object_manifest';
    expect(financialVerifier.split(beginMarker)).toHaveLength(2);
    expect(financialVerifier.split(endMarker)).toHaveLength(2);
    const manifestBegin = financialVerifier.indexOf(beginMarker);
    const manifestEnd = financialVerifier.indexOf(endMarker) + endMarker.length;
    const formatterStart = financialVerifier.indexOf('do $restore_verifier$');
    expect(manifestBegin).toBeGreaterThan(-1);
    expect(manifestEnd).toBeGreaterThan(manifestBegin);
    expect(formatterStart).toBeGreaterThan(manifestEnd);
    const prelude = financialVerifier.slice(0, manifestBegin);
    const manifest = financialVerifier.slice(manifestBegin, manifestEnd);
    const nonCatalogBody = financialVerifier.slice(manifestEnd, formatterStart);
    const formatter = financialVerifier.slice(formatterStart);
    const checkNames = (sql: string) => Array.from(
      sql.matchAll(/^\s*select\s+'(?<name>[a-z_][a-z0-9_]*)'\s*,/gimu),
      (match) => match.groups?.name ?? ''
    ).filter(Boolean);
    const nonCatalogChecks = checkNames(nonCatalogBody);
    expect(nonCatalogChecks.length).toBeGreaterThan(20);
    expect(new Set(checkNames(`${prelude}\n${nonCatalogBody}\n${formatter}`))).toEqual(
      new Set(nonCatalogChecks)
    );
    expect(manifest).toContain("select 'financial_schema_object_manifest'");
    expect(manifest).toContain("select 'storage_cleanup_effective_authority'");
    for (const diagnostic of [
      'failed_running_scan_permanent',
      'failed_running_scan_retry_exhausted',
      'pending_replay_child_incomplete',
      'pending_replay_child_permanent',
      'pending_replay_child_retry_exhausted'
    ]) {
      expect(formatter, diagnostic).toContain(`'${diagnostic}'`);
    }
    expect(formatter.trimEnd()).toMatch(/rollback;$/u);
    expect(verifierWitness).toContain('catalogOnlyVerifierSql');
    expect(verifierWitness).toContain('dataOnlyVerifierSql');
    expect(verifierWitness).toContain('zeroCatalogChecksSql');
    expect(verifierWitness).toContain('zeroOperationalDiagnosticsSql');
    for (const fullExpectation of [
      'fresh financial schema-object manifest',
      'payment financial issue subject guard repair',
      'known but impossible financial issue identity',
      'financial issue semantic identity repair',
      'impossible financial issue impact',
      'financial issue semantic impact repair',
      'refund component violates the deterministic two-bucket split'
    ]) {
      expect(verifierWitness, fullExpectation).toMatch(
        new RegExp(`${fullExpectation.replaceAll(' ', '\\s+')}[\\s\\S]{0,300}?'full'`, 'u')
      );
    }
    expect(verifierWitness).toMatch(
      /fresh financial schema-object manifest[\s\S]{0,200}?exerciseFinancialAdminClaimMatrix/u
    );
    expect(verifierWitness).toContain(
      "../drizzle/0014_plan6bii_issue_transition_fail_closed.sql"
    );
    expect(verifierWitness).toMatch(
      /const vulnerableFinancialIssueTransitionStatement\s*=\s*requiredAdminCommandAuthorityStatement\([\s\S]{0,300}?'CREATE OR REPLACE FUNCTION "public"\."plan6b_validate_issue_transition"\(\)'/u
    );
    expect(verifierWitness).toMatch(
      /const failClosedFinancialIssueTransitionStatement\s*=\s*requiredIssueTransitionFailClosedStatement\([\s\S]{0,300}?'CREATE OR REPLACE FUNCTION "public"\."plan6b_validate_issue_transition"\(\)'/u
    );
    const issueTransitionStartupGuard = verifierWitness.match(
      /const failClosedFinancialIssueTransitionSettingPredicates[\s\S]*?\[restore-verifier\] financial issue transition predecessor\/fix contract is invalid/u
    )?.[0] ?? '';
    expect(issueTransitionStartupGuard).not.toBe('');
    expect(issueTransitionStartupGuard.match(/current_setting/gu) ?? []).toHaveLength(4);
    for (const settingName of [
      'pale_orbit.financial_worker_issue_resolution',
      'pale_orbit.plan6bii_financial_admin_issue_resolution_issue_id',
      'pale_orbit.plan6bii_financial_admin_issue_resolution_command_id',
      'pale_orbit.plan6bii_financial_admin_issue_resolution_actor_id'
    ]) {
      expect(
        issueTransitionStartupGuard.split(settingName.replaceAll('.', '\\.')),
        settingName
      ).toHaveLength(2);
    }
    expect(issueTransitionStartupGuard).toContain(
      'failClosedFinancialIssueTransitionSettingPredicates.some'
    );
    expect(issueTransitionStartupGuard).toContain(
      'IF NOT COALESCE(worker_resolution OR admin_resolution, false) THEN'
    );
    expect(issueTransitionStartupGuard).not.toContain(
      'IF (worker_resolution OR admin_resolution) IS NOT TRUE THEN'
    );
    expect(verifierWitness).toMatch(
      /pool\.query\(vulnerableFinancialIssueTransitionStatement\)[\s\S]{0,300}?fail-open financial issue transition predecessor[\s\S]{0,200}?financial_schema_object_manifest=1[\s\S]{0,300}?pool\.query\(failClosedFinancialIssueTransitionStatement\)[\s\S]{0,300}?fail-closed financial issue transition repair/u
    );
    for (const [witnessName, expectedCount] of [
      ['missing financial transition trigger', 2],
      ['required trigger definition mismatch', 2],
      ['missing financial lookup index', 2],
      ['required index definition mismatch', 2],
      ['claim constraint definition mismatch', 2],
      ['claim index definition mismatch', 2],
      ['financial claim clear capability column', 1],
      ['database fixed-group CONNECT grant option mismatch', 1],
      ['unexpected fixed-group database TEMPORARY ACL', 2],
      ['cleanup login direct grantable CONNECT', 2],
      ['cleanup login direct TEMPORARY', 2],
      ['disabled protected constraint triggers', 4],
      ['enum label inventory drift', 4],
      ['sensitive relation direct ACL mismatch', 2],
      ['unsafe cleanup membership flags', 3],
      ['missing unknown-classification companion trigger', 2],
      ['known but impossible financial issue identity', 2],
      ['impossible financial issue impact', 2]
    ] as const) {
      expect(verifierWitness, witnessName).toMatch(
        new RegExp(
          `${witnessName.replaceAll(' ', '\\s+')}[\\s\\S]{0,300}?(?:financial_schema_object_manifest|storage_cleanup_effective_authority)=${expectedCount}`,
          'u'
        )
      );
    }
    expect(verifierWitness).toMatch(
      /omitted financial issue constraint definition mismatch[\s\S]{0,300}?financial_schema_object_manifest=2/u
    );
    expect(verifierWitness).toMatch(
      /set safe_code = 'payout_membership_conflict'[\s\S]{0,500}?drop constraint financial_reconciliation_issues_semantic_identity[\s\S]{0,300}?pool\.query\(semanticIdentityConstraintStatement\)[\s\S]{0,300}?financial issue semantic identity repair/u
    );
    expect(verifierWitness).toMatch(
      /set impact = 'exception'[\s\S]{0,500}?drop constraint financial_reconciliation_issues_semantic_impact[\s\S]{0,300}?pool\.query\(semanticImpactConstraintStatement\)[\s\S]{0,300}?financial issue semantic impact repair/u
    );
    expect(verifierWitness).not.toMatch(
      /validate constraint financial_reconciliation_issues_semantic_(?:identity|impact)/u
    );
    expect(verifierWitness).toMatch(
      /payment financial issue subject guard repair[\s\S]{0,200}?verifierScope = 'data'/u
    );
    expect(verifierWitness).toMatch(
      /if \(outcome\.error\) await client\.query\('rollback'\)[\s\S]*?drop table if exists pg_temp\.restore_financial_checks/u
    );
    expect(verifierWitness).toMatch(
      /if \(verifierClient === client\) verifierClient = null;[\s\S]*?client\.release\(true\)/u
    );
    expect(verifierWitness).toMatch(
      /verifierClient\.release\(\);[\s\S]*?Promise\.all\(\[pool\.end\(\), verifierPool\.end\(\)\]\)/u
    );
    expect(verifierWitness).toMatch(
      /verifierOutcome\([\s\S]{0,200}?'clean executable restore check'[\s\S]{0,100}?'full'/u
    );
  });

  it('restores semantic constraints only from their canonical 0009 source statements', async () => {
    const [verifierWitness, migration] = await Promise.all([
      source('scripts/execute-financial-restore-verifier.ts'),
      source('drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql')
    ]);
    const constraintNames = [
      'financial_reconciliation_issues_semantic_identity',
      'financial_reconciliation_issues_semantic_impact'
    ] as const;
    for (const constraintName of constraintNames) {
      const matches = Array.from(migration.matchAll(new RegExp(
        `ALTER TABLE "financial_reconciliation_issues" ADD CONSTRAINT "${constraintName}" CHECK \\([\\s\\S]*?\\);--> statement-breakpoint`,
        'gu'
      )));
      expect(matches, constraintName).toHaveLength(1);
    }
    expect(verifierWitness).toContain(
      'drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql'
    );
    expect(verifierWitness).toContain('requiredMigrationCheckConstraintStatement');
    expect(verifierWitness).toContain('semanticIdentityConstraintStatement');
    expect(verifierWitness).toContain('semanticImpactConstraintStatement');
    const semanticWitnessRegion = verifierWitness.match(
      /const resolvedIssueId[\s\S]*?resolve_financial_issue_after_worker_recompute/u
    )?.[0] ?? '';
    expect(semanticWitnessRegion).not.toContain('pg_get_constraintdef');
    expect(semanticWitnessRegion).toContain('${semanticIdentityConstraintStatement} not valid');
    expect(semanticWitnessRegion).toContain('pool.query(semanticIdentityConstraintStatement)');
    expect(semanticWitnessRegion).toContain('${semanticImpactConstraintStatement} not valid');
    expect(semanticWitnessRegion).toContain('pool.query(semanticImpactConstraintStatement)');
    for (const forbiddenDiagnosticSymbol of [
      ['financialCatalogMismatch', 'DiagnosticSql'].join(''),
      ['semantic constraint catalog', ' diagnostic'].join(''),
      ['--diagnose', 'semantic-constraint-repair'].join('-')
    ]) {
      expect(verifierWitness).not.toContain(forbiddenDiagnosticSymbol);
    }
  });

  it('refuses ambiguous financial witness timeout cleanup targets', () => {
    expect(
      financialWitnessTestTimeoutMs - financialWitnessHarnessTimeoutMs
    ).toBeGreaterThanOrEqual(120_000);
    expect(assertFinancialHarnessProjectOwned.toString()).toContain(
      'projectResources.length === 0'
    );
    expect(assertFinancialHarnessProjectOwned.toString()).toContain('ids.length > 1');
    const resource = (
      id: string,
      project: string
    ): FinancialHarnessDockerResource => ({
      id,
      kind: 'container',
      labels: { 'com.docker.compose.project': project }
    });
    const baseline = new Map<string, FinancialHarnessDockerResource>([
      ['container:baseline', resource('baseline', 'unrelated-project')]
    ]);
    const oneProject = new Map(baseline);
    oneProject.set(
      'container:new-one',
      resource('new-one', 'pale-orbit-test-1111111111111111')
    );
    expect(exactNewFinancialHarnessProject(baseline, oneProject)).toBe(
      'pale-orbit-test-1111111111111111'
    );

    const noProject = new Map(baseline);
    expect(() => exactNewFinancialHarnessProject(baseline, noProject)).toThrow(
      'expected exactly one new test project, found 0'
    );
    const twoProjects = new Map(oneProject);
    twoProjects.set(
      'container:new-two',
      resource('new-two', 'pale-orbit-test-2222222222222222')
    );
    expect(() => exactNewFinancialHarnessProject(baseline, twoProjects)).toThrow(
      'expected exactly one new test project, found 2'
    );

    const baselineStorage = new Set(['C:\\temp\\pale-orbit-test-storage-baseline']);
    expect(exactNewFinancialHarnessStorageDirectory(
      baselineStorage,
      new Set([...baselineStorage, 'C:\\temp\\pale-orbit-test-storage-one'])
    )).toBe('C:\\temp\\pale-orbit-test-storage-one');
    expect(() => exactNewFinancialHarnessStorageDirectory(
      baselineStorage,
      new Set([
        ...baselineStorage,
        'C:\\temp\\pale-orbit-test-storage-one',
        'C:\\temp\\pale-orbit-test-storage-two'
      ])
    )).toThrow('refusing ambiguous new test storage directories');
  });

  it('bounds financial witness process-tree termination before timeout cleanup', async () => {
    const closed: FinancialWitnessHarnessClose = { signal: null, status: 0 };
    await expect(waitForFinancialWitnessHarnessClose(
      Promise.resolve(closed),
      50
    )).resolves.toEqual(closed);
    await expect(waitForFinancialWitnessHarnessClose(
      new Promise<FinancialWitnessHarnessClose>(() => undefined),
      1
    )).resolves.toBeNull();

    const supervisor = runBoundedFinancialWitnessHarness.toString();
    expect(supervisor.match(/terminateFinancialWitnessHarnessProcessTree/gmu)).toHaveLength(2);
    expect(supervisor).toMatch(/child\.kill\(["']SIGKILL["']\)/u);
    expect(supervisor).toContain('!treeKillSucceeded');
    expect(supervisor).toContain('exact process-tree termination was not confirmed');
    expect(supervisor.indexOf('closedAfterTermination')).toBeLessThan(
      supervisor.indexOf('cleanupTimedOutFinancialWitnessHarness')
    );
    expect(supervisor.indexOf('!treeKillSucceeded')).toBeLessThan(
      supervisor.indexOf('cleanupTimedOutFinancialWitnessHarness')
    );
    expect(financialWitnessTestTimeoutMs - financialWitnessHarnessTimeoutMs)
      .toBe(300_000);
  });

  it('allows only inert fail-closed psql meta-commands in executable restore SQL', async () => {
    const scripts = await Promise.all([
      source('scripts/capture-restore-row-counts.sql'),
      source('scripts/capture-storage-samples.sql'),
      source('scripts/verify-financial-restore.sql')
    ]);
    for (const script of scripts) {
      const metaCommands = script
        .split(/\r?\n/u)
        .filter((line) => /^\s*\\/u.test(line))
        .map((line) => line.trimStart());
      expect(metaCommands).toEqual(['\\set ON_ERROR_STOP on', '\\set QUIET on']);
    }
  });

  it('binds source and restore Docker engines and the exact application image before mutation', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const sourcePowerShell = fencedCodeBlocks(backupSection, 'powershell').join('\n');
    const sourceShell = fencedCodeBlocks(backupSection, 'sh').join('\n');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');

    expect(sourcePowerShell).toContain('APPROVED_SOURCE_DOCKER_CONTEXT');
    expect(sourcePowerShell).toContain('EXPECTED_SOURCE_DOCKER_ENGINE_ID');
    expect(sourceShell).toContain('APPROVED_SOURCE_DOCKER_CONTEXT');
    expect(sourceShell).toContain('EXPECTED_SOURCE_DOCKER_ENGINE_ID');
    expect(restorePowerShell).toContain('APPROVED_RESTORE_DOCKER_CONTEXT');
    expect(restorePowerShell).toContain('EXPECTED_RESTORE_DOCKER_ENGINE_ID');
    expect(restoreShell).toContain('APPROVED_RESTORE_DOCKER_CONTEXT');
    expect(restoreShell).toContain('EXPECTED_RESTORE_DOCKER_ENGINE_ID');

    for (const script of [sourcePowerShell, restorePowerShell]) {
      for (const line of script.split(/\r?\n/u)) {
        if (!/^\s*(?:&\s*|(?:\$\w+\s*=\s*)?@\(\s*&?\s*)?docker\b/iu.test(line)) continue;
        expect(line, `PowerShell Docker command lacks explicit context: ${line.trim()}`).toContain(
          '--context'
        );
      }
    }
    for (const script of [sourceShell, restoreShell]) {
      expect(script).toMatch(/docker --context "\$(?:source|restore)_docker_context" "\$@"/u);
      expect(script).not.toMatch(/^\s*docker (?!.*--context)/gmu);
    }

    for (const script of [sourcePowerShell, sourceShell]) {
      expect(script).toContain('source-docker-engine.json');
      expect(script).toMatch(/APP_IMAGE[^\n]*@sha256:\[0-9a-f\]\{64\}/u);
      expect(script).toMatch(/RepoDigests[\s\S]*APP_IMAGE/u);
    }
    for (const script of [restorePowerShell, restoreShell]) {
      const imageBindingIndex = script.indexOf('Assert-RestoreImageBinding');
      const shellImageBindingIndex = script.indexOf('assert_restore_image_binding');
      const bindingIndex = Math.max(imageBindingIndex, shellImageBindingIndex);
      expect(script).toContain('source-docker-engine.json');
      expect(script).toMatch(
        /(?:expectedRestoreDockerEngineId\s+-eq\s+\$sourceEngineRecord\.docker_engine_id|expected_restore_docker_engine_id"\s*!=\s*"\$source_production_engine_id)/u
      );
      expect(bindingIndex).toBeGreaterThan(-1);
      expect(bindingIndex).toBeLessThan(script.indexOf('create app'));
      expect(bindingIndex).toBeLessThan(script.indexOf('run --rm migrate'));
      expect(bindingIndex).toBeLessThan(script.indexOf('up --detach --wait app'));
    }
    expect(restorePowerShell).toContain('$imageRecord.RepoDigests -is [System.Array]');
    expect(restorePowerShell).toContain("$restoreRepoDigestJsonText.StartsWith('[')");
    expect(restorePowerShell).toContain("$restoreRepoDigestJsonText.EndsWith(']')");
  });

  it('binds the stopped production app and worker containers to the authenticated image', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const sourcePowerShell = fencedCodeBlocks(backupSection, 'powershell').join('\n');
    const sourceShell = fencedCodeBlocks(backupSection, 'sh').join('\n');

    for (const [script, assertion] of [
      [sourcePowerShell, 'Assert-SourceApplicationImageBinding'],
      [sourceShell, 'assert_source_application_image_binding']
    ] as const) {
      const stopIndex = script.indexOf('stop app worker');
      const assertionIndex = script.lastIndexOf(assertion);
      expect(stopIndex).toBeGreaterThan(-1);
      expect(assertionIndex).toBeGreaterThan(stopIndex);
      expect(assertionIndex).toBeLessThan(script.indexOf('storage.tar.gz'));
      expect(script).toContain("{{.Image}}");
      expect(script).toContain("{{.Id}}");
    }
    expect(sourcePowerShell).toContain("foreach ($service in @('app', 'worker'))");
    expect(sourcePowerShell).toContain('ps --all -q $service');
    expect(sourceShell).toContain('for service in app worker');
    expect(sourceShell).toContain('ps --all -q "$service"');
  });

  it('uses one authenticated immutable offline helper for every plaintext volume operation', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const operationalScripts = [
      ...fencedCodeBlocks(backupSection, 'powershell'),
      ...fencedCodeBlocks(backupSection, 'sh'),
      ...fencedCodeBlocks(restoreSection, 'powershell'),
      ...fencedCodeBlocks(restoreSection, 'sh')
    ];

    for (const script of operationalScripts) {
      expect(script).toContain('BACKUP_HELPER_IMAGE');
      expect(script).not.toContain('alpine:3.22');
      const helperRuns = script.split(/\r?\n/u).filter((line) =>
        /(?:docker|source_docker|restore_docker)[^\n]*\brun\b[^\n]*(?:sha256sum|\btar\b|find \/restore)/u.test(line)
      );
      expect(helperRuns.length).toBeGreaterThan(0);
      for (const line of helperRuns) {
        expect(line).toContain('--pull never');
        expect(line).toContain('--network none');
        expect(line).toContain('--read-only');
        expect(line).toContain('--cap-drop ALL');
        expect(line).toContain('--security-opt no-new-privileges');
        expect(line).toContain('BACKUP_HELPER_IMAGE');
      }
    }
    for (const script of [operationalScripts[0]!, operationalScripts[1]!]) {
      expect(script).toMatch(/BACKUP_HELPER_IMAGE[^\n]*@sha256:\[0-9a-f\]\{64\}/u);
      expect(script).toContain('application-image.json');
      expect(script).toMatch(/BACKUP_HELPER_IMAGE\s*(?:=|")/u);
    }
    for (const script of [operationalScripts[2]!, operationalScripts[3]!]) {
      expect(script).toMatch(/BACKUP_HELPER_IMAGE[^\n]*@sha256:\[0-9a-f\]\{64\}/u);
      expect(script).toContain('application-image.json');
      expect(script).toContain('BACKUP_HELPER_IMAGE');
    }
    expect(operationalScripts[0]).not.toContain('${backup}:/backup');
    expect(operationalScripts[1]).not.toContain('${backup}:/backup');
    expect(operationalScripts[2]).not.toContain('${verifiedRestore}:/backup:ro');
    expect(operationalScripts[3]).not.toContain('${verified_restore}:/backup:ro');
  });

  it('pins the restore PostgreSQL image and makes the rehearsal network internal', async () => {
    const [storageRunbook, productionCompose] = await Promise.all([
      source('docs/storage-ingestion-and-publication.md'),
      source('compose.prod.yaml')
    ]);
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const sourceScripts = [
      fencedCodeBlocks(backupSection, 'powershell').join('\n'),
      fencedCodeBlocks(backupSection, 'sh').join('\n')
    ];
    const restoreScripts = [
      fencedCodeBlocks(restoreSection, 'powershell').join('\n'),
      fencedCodeBlocks(restoreSection, 'sh').join('\n')
    ];

    expect(productionCompose).toContain(
      'image: ${POSTGRES_IMAGE:-postgres:18.4-alpine3.24}'
    );
    expect(productionCompose).toMatch(
      /networks:\s*\n\s+default:\s*\n\s+internal: \$\{COMPOSE_DEFAULT_NETWORK_INTERNAL:-false\}/u
    );
    for (const script of sourceScripts) {
      expect(script).toMatch(/POSTGRES_IMAGE[^\n]*@sha256:\[0-9a-f\]\{64\}/u);
      expect(script).toContain('application-image.json');
      expect(script).toContain('POSTGRES_IMAGE');
      expect(script).toContain("{{.Image}}");
      expect(script).toContain("{{.Id}}");
    }
    for (const script of restoreScripts) {
      const startupIndex = script.indexOf('up --detach --wait postgres');
      const internalNetworkIndex = script.indexOf('COMPOSE_DEFAULT_NETWORK_INTERNAL');
      expect(script).toMatch(/POSTGRES_IMAGE[^\n]*@sha256:\[0-9a-f\]\{64\}/u);
      expect(script).toContain('application-image.json');
      expect(script).toContain('POSTGRES_IMAGE');
      expect(internalNetworkIndex).toBeGreaterThan(-1);
      expect(internalNetworkIndex).toBeLessThan(startupIndex);
      expect(script.slice(0, startupIndex)).toMatch(
        /COMPOSE_DEFAULT_NETWORK_INTERNAL[^\n]*(?:true|'true')/u
      );
    }
  });

  it('does not let storage sample input or dump cleanup failures skip safety work', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const sourceShell = fencedCodeBlocks(backupSection, 'sh').join('\n');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');

    for (const script of [sourceShell, restoreShell]) {
      expect(script).not.toMatch(/tail[^\n]*\|\s*while\b/u);
      expect(script).toMatch(/IFS= read -r sample_header[\s\S]*\}\s*< "\$(?:backup|verified_restore)\/storage-samples\.csv"\s*\|\| return 1/u);
    }

    const finallyIndex = restorePowerShell.lastIndexOf('finally {');
    const finalizer = restorePowerShell.slice(finallyIndex);
    const dumpRemovalIndex = finalizer.indexOf('rm -f /tmp/database.dump');
    const firstRecordedCleanupError = finalizer.indexOf(
      '$cleanupErrors.Add($_.Exception)', dumpRemovalIndex
    );
    const preTeardownInventoryIndex = finalizer.indexOf(
      '$preTeardownInventory = Get-RestoreProjectInventory'
    );
    const teardownIndex = finalizer.indexOf('down --volumes');
    const preInventoryErrorIndex = finalizer.indexOf(
      '$cleanupErrors.Add($_.Exception)', preTeardownInventoryIndex
    );
    const postTeardownInventoryIndex = finalizer.indexOf(
      '$postTeardownInventory = Get-RestoreProjectInventory'
    );
    const teardownErrorIndex = finalizer.indexOf(
      '$cleanupErrors.Add($_.Exception)', teardownIndex
    );
    expect(dumpRemovalIndex).toBeGreaterThan(-1);
    expect(firstRecordedCleanupError).toBeGreaterThan(dumpRemovalIndex);
    expect(firstRecordedCleanupError).toBeLessThan(teardownIndex);
    expect(finalizer.slice(firstRecordedCleanupError, teardownIndex)).toMatch(/try\s*\{/u);
    expect(preTeardownInventoryIndex).toBeGreaterThan(firstRecordedCleanupError);
    expect(preInventoryErrorIndex).toBeGreaterThan(preTeardownInventoryIndex);
    expect(preInventoryErrorIndex).toBeLessThan(teardownIndex);
    expect(teardownErrorIndex).toBeGreaterThan(teardownIndex);
    expect(teardownErrorIndex).toBeLessThan(postTeardownInventoryIndex);
  });

  it('creates a synthetic non-routable rehearsal environment before isolated Compose startup', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');
    const powerShellBeforeStart = restorePowerShell.slice(
      0,
      restorePowerShell.indexOf('up --detach --wait postgres')
    );
    const shellBeforeStart = restoreShell.slice(0, restoreShell.indexOf('up --detach --wait postgres'));

    expect(powerShellBeforeStart).toContain('function New-RehearsalSecret');
    expect(
      powerShellBeforeStart.match(
        /\$env:(?:DATABASE_OWNER_PASSWORD|DATABASE_PASSWORD|DATABASE_WORKER_PASSWORD|DATABASE_STORAGE_CLEANUP_PASSWORD|AUTH_SECRET|SMTP_PASSWORD|BOOTSTRAP_ADMIN_PASSWORD) = New-RehearsalSecret/gmu
      )
    ).toHaveLength(7);
    expect(powerShellBeforeStart).toContain("$env:DATABASE_NAME = 'restore_rehearsal'");
    expect(powerShellBeforeStart).toContain(
      "$env:DATABASE_OWNER_USER = 'restore_rehearsal_owner'"
    );
    expect(powerShellBeforeStart).toContain("$env:DATABASE_USER = 'restore_rehearsal_web'");
    expect(powerShellBeforeStart).toContain(
      "$env:DATABASE_WORKER_USER = 'restore_rehearsal_worker'"
    );
    expect(powerShellBeforeStart).toContain(
      "$env:DATABASE_STORAGE_CLEANUP_USER = 'restore_rehearsal_storage_cleanup'"
    );
    expect(powerShellBeforeStart).toContain('Sort-Object -Unique).Count -ne 4');
    expect(powerShellBeforeStart).toContain(
      '($databaseRolePasswords | Sort-Object -Unique).Count -ne 4'
    );
    expect(powerShellBeforeStart).toContain("$env:ORIGIN = 'https://restore.invalid'");
    expect(powerShellBeforeStart).toContain("$env:SITE_ADDRESS = 'restore.invalid'");
    expect(powerShellBeforeStart).toContain("$env:SMTP_HOST = '127.0.0.1'");
    expect(powerShellBeforeStart).toContain("$env:SMTP_PORT = '1'");
    expect(powerShellBeforeStart).toContain('Env:STRIPE_SECRET_KEY');
    expect(powerShellBeforeStart).toContain('Env:STRIPE_WEBHOOK_SECRET');

    expect(shellBeforeStart).toContain('new_rehearsal_secret()');
    for (const secret of [
      'DATABASE_OWNER_PASSWORD',
      'DATABASE_PASSWORD',
      'DATABASE_WORKER_PASSWORD',
      'DATABASE_STORAGE_CLEANUP_PASSWORD',
      'AUTH_SECRET',
      'SMTP_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD'
    ]) {
      expect(shellBeforeStart).toContain(`${secret}="$(new_rehearsal_secret)"`);
      expect(shellBeforeStart).toContain(`export ${secret}`);
    }
    expect(shellBeforeStart).toContain('DATABASE_NAME=restore_rehearsal');
    expect(shellBeforeStart).toContain('DATABASE_OWNER_USER=restore_rehearsal_owner');
    expect(shellBeforeStart).toContain('DATABASE_USER=restore_rehearsal_web');
    expect(shellBeforeStart).toContain('DATABASE_WORKER_USER=restore_rehearsal_worker');
    expect(shellBeforeStart).toContain(
      'DATABASE_STORAGE_CLEANUP_USER=restore_rehearsal_storage_cleanup'
    );
    expect(shellBeforeStart).toContain('[ "$DATABASE_OWNER_USER" != "$DATABASE_USER" ]');
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_OWNER_USER" != "$DATABASE_WORKER_USER" ]'
    );
    expect(shellBeforeStart).toContain('[ "$DATABASE_USER" != "$DATABASE_WORKER_USER" ]');
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_OWNER_USER" != "$DATABASE_STORAGE_CLEANUP_USER" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_USER" != "$DATABASE_STORAGE_CLEANUP_USER" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_WORKER_USER" != "$DATABASE_STORAGE_CLEANUP_USER" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_OWNER_PASSWORD" != "$DATABASE_PASSWORD" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_OWNER_PASSWORD" != "$DATABASE_WORKER_PASSWORD" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_PASSWORD" != "$DATABASE_WORKER_PASSWORD" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_OWNER_PASSWORD" != "$DATABASE_STORAGE_CLEANUP_PASSWORD" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_PASSWORD" != "$DATABASE_STORAGE_CLEANUP_PASSWORD" ]'
    );
    expect(shellBeforeStart).toContain(
      '[ "$DATABASE_WORKER_PASSWORD" != "$DATABASE_STORAGE_CLEANUP_PASSWORD" ]'
    );
    expect(shellBeforeStart).toContain('ORIGIN=https://restore.invalid');
    expect(shellBeforeStart).toContain('SITE_ADDRESS=restore.invalid');
    expect(shellBeforeStart).toContain('SMTP_HOST=127.0.0.1');
    expect(shellBeforeStart).toContain('SMTP_PORT=1');
    expect(shellBeforeStart).toContain('unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET');

    for (const beforeStart of [powerShellBeforeStart, shellBeforeStart]) {
      expect(beforeStart).not.toMatch(/^\s*(?:source|\.)\s+[^\n]*\.env/gmu);
      expect(beforeStart).not.toMatch(/smtp\.(?:sendgrid|mailgun|amazonaws)\./iu);
    }
    expect(restoreSection).toContain('No production SMTP or provider credential may be present');
  });

  it('uses owner credentials for database administration and provisions runtime roles before app health', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const commandSets = [
      {
        body: [backupSection, restoreSection]
          .flatMap((section) => fencedCodeBlocks(section, 'powershell'))
          .join('\n'),
        ownerCredential: '$env:DATABASE_OWNER_USER'
      },
      {
        body: [backupSection, restoreSection]
          .flatMap((section) => fencedCodeBlocks(section, 'sh'))
          .join('\n'),
        ownerCredential: '"$DATABASE_OWNER_USER"'
      }
    ];

    for (const { body, ownerCredential } of commandSets) {
      const databaseAdministrationCommands = body
        .split(/\r?\n/u)
        .filter((line) => /\bpostgres\b[^\n]*\b(?:pg_dump|pg_restore|psql)\b/u.test(line));
      expect(databaseAdministrationCommands.length, ownerCredential).toBeGreaterThan(0);
      for (const command of databaseAdministrationCommands) {
        expect(command, command).toContain(`-U ${ownerCredential}`);
      }
    }

    for (const script of [
      fencedCodeBlocks(restoreSection, 'powershell').join('\n'),
      fencedCodeBlocks(restoreSection, 'sh').join('\n')
    ]) {
      const roleBootstrapMigrateIndex = script.indexOf('run --rm migrate');
      const restoreIndex = script.indexOf('pg_restore');
      const restoredStateMigrateIndex = script.indexOf(
        'run --rm migrate',
        roleBootstrapMigrateIndex + 1
      );
      const provisionIndex = script.indexOf('run --rm database-role-provision');
      const appStartIndex = script.indexOf('up --detach --wait app');
      const appHealthIndex = script.indexOf("fetch('http://127.0.0.1:3000'+path)");
      expect(roleBootstrapMigrateIndex).toBeGreaterThan(-1);
      expect(restoreIndex).toBeGreaterThan(roleBootstrapMigrateIndex);
      expect(restoredStateMigrateIndex).toBeGreaterThan(restoreIndex);
      expect(provisionIndex).toBeGreaterThan(restoredStateMigrateIndex);
      expect(appStartIndex).toBeGreaterThan(provisionIndex);
      expect(appHealthIndex).toBeGreaterThan(provisionIndex);
    }
  });

  it('revalidates the bound Docker engine before every documented mutation', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const scripts = [
      {
        body: fencedCodeBlocks(backupSection, 'powershell').join('\n'),
        assertion: 'Assert-SourceDockerEngineBinding',
        mutation: /(?:\bcompose\b.*\bstop\b|\bpg_dump\b|\bdocker\b.*\bcp\b|\brm -f \/tmp\/pale-orbit\.dump|\brun --rm\b.*\b(?:tar|sha256sum)\b)/u
      },
      {
        body: fencedCodeBlocks(backupSection, 'sh').join('\n'),
        assertion: 'assert_source_engine_binding',
        mutation: /(?:^compose_prod stop\b|\bpg_dump\b|^source_docker cp\b|\brm -f \/tmp\/pale-orbit\.dump|\bsource_docker run --rm\b.*\b(?:tar|sha256sum)\b)/u
      },
      {
        body: fencedCodeBlocks(restoreSection, 'powershell').join('\n'),
        assertion: 'Assert-RestoreDockerEngineBinding',
        mutation: /(?:\bcompose\b.*\b(?:up|create|pg_restore|migrate|storage-cleanup)\b|\bdocker\b.*\bcp\b|\brun --rm\b|\brm -f \/tmp\/database\.dump|\bdown --volumes\b)/u
      },
      {
        body: fencedCodeBlocks(restoreSection, 'sh').join('\n'),
        assertion: 'assert_restore_engine_binding',
        mutation: /(?:^compose_restore (?:up|create)\b|^restore_docker cp\b|\bpg_restore\b|^restore_docker run --rm\b|\brun --rm (?:migrate|database-role-provision|storage-cleanup)\b|\brm -f \/tmp\/database\.dump|\bdown --volumes\b)/u
      }
    ];

    for (const { body, assertion, mutation } of scripts) {
      const lines = body.split(/\r?\n/u);
      const mutationLines = lines
        .map((line, index) => ({ line: line.trim(), index }))
        .filter(({ line }) => mutation.test(line));
      expect(mutationLines.length, assertion).toBeGreaterThan(0);
      for (const { line, index } of mutationLines) {
        const preceding = lines
          .slice(Math.max(0, index - 3), index)
          .filter((candidate) => candidate.trim())
          .join('\n');
        expect(preceding, `engine binding does not dominate mutation: ${line}`).toContain(
          assertion
        );
      }
    }
  });

  it('compares every authenticated baseline and executes the verified SQL before app startup', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');

    for (const [script, appStart, markers] of [
      [
        restorePowerShell,
        'up --detach --wait app',
        [
          'Assert-RestoreMigrationJournal',
          'Assert-RestoreRowCounts',
          'Assert-RestoredStorageSamples',
          'Invoke-FinancialRestoreVerifier'
        ]
      ],
      [
        restoreShell,
        'up --detach --wait app',
        [
          'compare_migration_journal',
          'compare_restore_row_counts',
          'verify_restored_storage_samples',
          'run_financial_restore_verifier'
        ]
      ]
    ] as const) {
      const appStartIndex = script.indexOf(appStart);
      expect(appStartIndex).toBeGreaterThan(-1);
      for (const marker of markers) {
        const invocationIndex = script.lastIndexOf(marker, appStartIndex);
        expect(invocationIndex, marker).toBeGreaterThan(-1);
        expect(invocationIndex, marker).toBeLessThan(appStartIndex);
      }
      expect(script).toMatch(/verified(?:Restore|_restore)[^\n]*verify-financial-restore\.sql/u);
      expect(script).not.toMatch(/scripts[/\\]verify-financial-restore\.sql[^\n]*(?:psql|-f)/u);
    }
  });

  it('persists and blocks on strictly parsed financial operational diagnostics', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const sourcePowerShell = fencedCodeBlocks(backupSection, 'powershell').join('\n');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const sourceShell = fencedCodeBlocks(backupSection, 'sh').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');
    const financialVerifier = await source('scripts/verify-financial-restore.sql');

    for (const script of [sourcePowerShell, restorePowerShell]) {
      expect(script).toContain('function ConvertTo-FinancialOperationalDiagnostics');
      expect(script).toContain('function Write-FinancialOperationalDisposition');
      expect(script).toContain('financial-operational-diagnostics.csv');
      expect(script).toContain('OPERATIONAL_BLOCKER ');
      expect(script).toContain('PRODUCTION_REPLACEMENT_DISPOSITION=');
      expect(script).toContain('--csv');
    }
    const restorePowerShellVerifier = restorePowerShell.indexOf(
      '$productionReplacementBlocked = Invoke-FinancialRestoreVerifier'
    );
    const restorePowerShellApp = restorePowerShell.indexOf('up --detach --wait app');
    const restorePowerShellHealth = restorePowerShell.indexOf(
      "Promise.all(['/health/live','/health/ready']"
    );
    const restorePowerShellStopped = restorePowerShell.indexOf(
      'Assert-RestoreWorkerStopped',
      restorePowerShellHealth
    );
    const restorePowerShellGate = restorePowerShell.lastIndexOf(
      'if ($productionReplacementBlocked)'
    );
    const restorePowerShellSucceeded = restorePowerShell.indexOf(
      '$rehearsalSucceeded = $true'
    );
    for (const anchor of [
      restorePowerShellVerifier,
      restorePowerShellApp,
      restorePowerShellHealth,
      restorePowerShellStopped,
      restorePowerShellGate,
      restorePowerShellSucceeded
    ]) {
      expect(anchor).toBeGreaterThan(-1);
    }
    expect(restorePowerShellVerifier).toBeLessThan(restorePowerShellApp);
    expect(restorePowerShellHealth).toBeLessThan(restorePowerShellStopped);
    expect(restorePowerShellStopped).toBeLessThan(restorePowerShellGate);
    expect(restorePowerShellGate).toBeLessThan(restorePowerShellSucceeded);

    const restoreShellVerifier = restoreShell.indexOf(
      'run_financial_restore_verifier || exit 1'
    );
    const restoreShellApp = restoreShell.indexOf('up --detach --wait app');
    const restoreShellHealth = restoreShell.indexOf(
      "Promise.all(['/health/live','/health/ready']"
    );
    const restoreShellStopped = restoreShell.indexOf(
      'assert_restore_worker_stopped || exit 1',
      restoreShellHealth
    );
    const restoreShellGate = restoreShell.lastIndexOf(
      'if [ "$production_replacement_blocked" -eq 1 ]'
    );
    const restoreShellTeardown = restoreShell.indexOf('pre_teardown_inventory=');
    for (const anchor of [
      restoreShellVerifier,
      restoreShellApp,
      restoreShellHealth,
      restoreShellStopped,
      restoreShellGate,
      restoreShellTeardown
    ]) {
      expect(anchor).toBeGreaterThan(-1);
    }
    expect(restoreShellVerifier).toBeLessThan(restoreShellApp);
    expect(restoreShellHealth).toBeLessThan(restoreShellStopped);
    expect(restoreShellStopped).toBeLessThan(restoreShellGate);
    expect(restoreShellGate).toBeLessThan(restoreShellTeardown);
    const sourcePowerShellBlocked = sourcePowerShell.indexOf(
      'if ($sourceProductionReplacementBlocked)'
    );
    const sourcePowerShellContinues = sourcePowerShell.indexOf(
      'Assert-SourceDockerEngineBinding',
      sourcePowerShellBlocked
    );
    expect(sourcePowerShellBlocked).toBeGreaterThan(-1);
    expect(sourcePowerShellContinues).toBeGreaterThan(-1);
    expect(sourcePowerShellBlocked).toBeLessThan(sourcePowerShellContinues);
    expect(sourcePowerShell.slice(
      sourcePowerShellBlocked,
      sourcePowerShellContinues
    )).not.toContain('throw');
    const sourceShellBlocked = sourceShell.indexOf('source_production_replacement_blocked=1');
    const sourceShellContinues = sourceShell.indexOf(
      'source_docker run --rm',
      sourceShellBlocked
    );
    expect(sourceShellBlocked).toBeGreaterThan(-1);
    expect(sourceShellContinues).toBeGreaterThan(-1);
    expect(sourceShellBlocked).toBeLessThan(sourceShellContinues);
    for (const script of [sourceShell, restoreShell]) {
      expect(script).toContain('canonicalize_financial_operational_diagnostics');
      expect(script).toContain('report_financial_operational_disposition');
      expect(script).toContain('financial-operational-diagnostics.csv');
      expect(script).toContain('OPERATIONAL_BLOCKER ');
      expect(script).toContain('PRODUCTION_REPLACEMENT_DISPOSITION=');
      expect(script).toContain('--csv');
    }
    const structuralDo = financialVerifier.lastIndexOf('do $restore_verifier$');
    const operationalSelect = financialVerifier.lastIndexOf(
      'select check_name, violation_count'
    );
    const verifierRollback = financialVerifier.lastIndexOf('rollback;');
    expect(structuralDo).toBeGreaterThan(-1);
    expect(operationalSelect).toBeGreaterThan(-1);
    expect(verifierRollback).toBeGreaterThan(-1);
    expect(structuralDo).toBeLessThan(operationalSelect);
    expect(operationalSelect).toBeLessThan(verifierRollback);
    const operationalOutput = financialVerifier.slice(
      operationalSelect,
      verifierRollback
    );
    expect(operationalOutput).not.toContain('violation_count <> 0');
    let previousCheckIndex = -1;
    for (const checkName of [
      'failed_running_scan_permanent',
      'failed_running_scan_retry_exhausted',
      'pending_replay_child_incomplete',
      'pending_replay_child_permanent',
      'pending_replay_child_retry_exhausted'
    ]) {
      const checkIndex = operationalOutput.indexOf(`'${checkName}'`);
      expect(checkIndex).toBeGreaterThan(previousCheckIndex);
      previousCheckIndex = checkIndex;
    }

    const nonzeroDiagnostics = [
      'check_name,violation_count',
      'failed_running_scan_permanent,0',
      'failed_running_scan_retry_exhausted,0',
      'pending_replay_child_incomplete,2',
      'pending_replay_child_permanent,0',
      'pending_replay_child_retry_exhausted,1'
    ].join('\n');
    const zeroDiagnostics = nonzeroDiagnostics
      .replace('pending_replay_child_incomplete,2', 'pending_replay_child_incomplete,0')
      .replace('pending_replay_child_retry_exhausted,1', 'pending_replay_child_retry_exhausted,0');
    const reorderedLines = nonzeroDiagnostics.split('\n');
    [reorderedLines[3], reorderedLines[4]] = [reorderedLines[4]!, reorderedLines[3]!];
    const invalidDiagnostics = [
      nonzeroDiagnostics.split('\n').slice(0, -1).join('\n'),
      nonzeroDiagnostics.replace(
        'pending_replay_child_retry_exhausted,1',
        'pending_replay_child_permanent,0'
      ),
      `${nonzeroDiagnostics}\npending_replay_child_retry_exhausted,1`,
      reorderedLines.join('\n'),
      nonzeroDiagnostics.replace('pending_replay_child_incomplete,2', 'pending_replay_child_incomplete,-1'),
      nonzeroDiagnostics.replace('pending_replay_child_incomplete,2', 'pending_replay_child_incomplete,02'),
      nonzeroDiagnostics.replace(
        'pending_replay_child_incomplete,2',
        'pending_replay_child_incomplete,9223372036854775808'
      ),
      nonzeroDiagnostics.replace(
        'pending_replay_child_incomplete,2',
        '"pending_replay_child_incomplete",2'
      ),
      nonzeroDiagnostics.replace(
        'pending_replay_child_incomplete,2',
        'pending_replay_child_incomplete,2,SECRET_SENTINEL'
      ),
      nonzeroDiagnostics.replace('check_name,violation_count', 'Check_Name,violation_count'),
      nonzeroDiagnostics.replace(
        'pending_replay_child_incomplete,2',
        'Pending_replay_child_incomplete,2'
      )
    ];
    for (const [script, nextFunction] of [
      [sourceShell, 'cleanup_container_dump'],
      [restoreShell, 'verify_restored_storage_samples']
    ] as const) {
      const functions = documentedFinancialPosixFunctions(script, nextFunction);
      const runParser = (input: string, commands: readonly string[]) => spawnSync(
        posixShellPath(),
        ['-s'],
        {
          encoding: 'utf8',
          env: { ...process.env, FINANCIAL_DIAGNOSTICS_TEST_INPUT: input },
          input: ['set -eu', functions, ...commands].join('\n')
        }
      );
      const nonzeroResult = runParser(nonzeroDiagnostics, [
        'canonical="$(canonicalize_financial_operational_diagnostics "$FINANCIAL_DIAGNOSTICS_TEST_INPUT")"',
        'if report_financial_operational_disposition "$canonical"; then blocked=0; else status=$?; [ "$status" -eq 2 ] || exit 4; blocked=1; fi',
        'printf "BLOCKED_SCALAR_VALUE=%s\\n" "$blocked"',
        '[ "$blocked" -eq 1 ]'
      ]);
      expect(nonzeroResult.status).toBe(0);
      expect(nonzeroResult.stdout).toContain(
        'OPERATIONAL_BLOCKER pending_replay_child_incomplete=2'
      );
      expect(nonzeroResult.stdout).toContain(
        'OPERATIONAL_BLOCKER pending_replay_child_retry_exhausted=1'
      );
      expect(nonzeroResult.stdout).toContain('FINANCIAL_OPERATIONAL_DISPOSITION=blocked');
      expect(nonzeroResult.stdout).toContain('BLOCKED_SCALAR_VALUE=1');
      expect(nonzeroResult.stderr).toBe('');

      const zeroResult = runParser(zeroDiagnostics, [
        'canonical="$(canonicalize_financial_operational_diagnostics "$FINANCIAL_DIAGNOSTICS_TEST_INPUT")"',
        'if report_financial_operational_disposition "$canonical"; then blocked=0; else status=$?; [ "$status" -eq 2 ] || exit 4; blocked=1; fi',
        'printf "BLOCKED_SCALAR_VALUE=%s\\n" "$blocked"',
        '[ "$blocked" -eq 0 ]'
      ]);
      expect(zeroResult.status).toBe(0);
      expect(zeroResult.stdout).toContain('FINANCIAL_OPERATIONAL_DISPOSITION=clear');
      expect(zeroResult.stdout).toContain('BLOCKED_SCALAR_VALUE=0');
      expect(zeroResult.stdout).not.toContain('OPERATIONAL_BLOCKER ');
      expect(zeroResult.stderr).toBe('');

      for (const invalidInput of invalidDiagnostics) {
        const invalidResult = runParser(invalidInput, [
          'if canonicalize_financial_operational_diagnostics "$FINANCIAL_DIAGNOSTICS_TEST_INPUT" >/dev/null; then exit 3; fi',
          "printf '%s\\n' GENERIC_FINANCIAL_DIAGNOSTIC_REJECTION"
        ]);
        expect(invalidResult.status).toBe(0);
        expect(invalidResult.stdout.trim()).toBe('GENERIC_FINANCIAL_DIAGNOSTIC_REJECTION');
        expect(invalidResult.stdout).not.toContain('SECRET_SENTINEL');
        expect(invalidResult.stderr).toBe('');
      }

      const directSinkResult = runParser(
        nonzeroDiagnostics.replace(
          'pending_replay_child_incomplete,2',
          'pending_replay_child_incomplete,2,SECRET_SENTINEL'
        ),
        [
          'if report_financial_operational_disposition "$FINANCIAL_DIAGNOSTICS_TEST_INPUT"; then exit 3; else status=$?; [ "$status" -eq 1 ] || exit 4; fi',
          "printf '%s\\n' GENERIC_FINANCIAL_DISPOSITION_REJECTION"
        ]
      );
      expect(directSinkResult.status).toBe(0);
      expect(directSinkResult.stdout.trim()).toBe('GENERIC_FINANCIAL_DISPOSITION_REJECTION');
      expect(directSinkResult.stdout).not.toContain('SECRET_SENTINEL');
      expect(directSinkResult.stderr).toBe('');

      const outputFailure = runParser(zeroDiagnostics, [
        'canonical="$(canonicalize_financial_operational_diagnostics "$FINANCIAL_DIAGNOSTICS_TEST_INPUT")"',
        "printf() { if [ \"${2-}\" = 'FINANCIAL_OPERATIONAL_DISPOSITION=clear' ]; then return 7; fi; command printf \"$@\"; }",
        'if report_financial_operational_disposition "$canonical"; then exit 3; else status=$?; [ "$status" -eq 1 ] || exit 4; fi'
      ]);
      expect(outputFailure.status).toBe(0);
      expect(outputFailure.stdout).toBe('');
    }

    if (process.platform !== 'win32') return;
    for (const script of [sourcePowerShell, restorePowerShell]) {
      const functions = [
        "$ErrorActionPreference = 'Stop'",
        documentedPowerShellFunction(script, 'ConvertTo-FinancialOperationalDiagnostics'),
        documentedPowerShellFunction(script, 'Write-FinancialOperationalDisposition')
      ].join('\n');
      const runParser = (input: string, commands: readonly string[]) => spawnSync(
        'powershell.exe',
        [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          [functions, ...commands].join('\n')
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, FINANCIAL_DIAGNOSTICS_TEST_INPUT: input }
        }
      );
      const nonzeroResult = runParser(nonzeroDiagnostics, [
        '$lines = @($env:FINANCIAL_DIAGNOSTICS_TEST_INPUT -split "`n")',
        '$canonical = ConvertTo-FinancialOperationalDiagnostics -Lines $lines',
        '$blocked = Write-FinancialOperationalDisposition -CanonicalDiagnostics $canonical',
        '[Console]::Out.WriteLine("BLOCKED_SCALAR_TYPE=$($blocked.GetType().FullName)")',
        '[Console]::Out.WriteLine("BLOCKED_SCALAR_VALUE=$blocked")',
        '[Console]::Out.Write($canonical)',
        'if (-not $blocked) { exit 3 }'
      ]);
      expect(nonzeroResult.status).toBe(0);
      expect(nonzeroResult.stdout).toContain(
        'OPERATIONAL_BLOCKER pending_replay_child_incomplete=2'
      );
      expect(nonzeroResult.stdout).toContain(
        'OPERATIONAL_BLOCKER pending_replay_child_retry_exhausted=1'
      );
      expect(nonzeroResult.stdout).toContain('FINANCIAL_OPERATIONAL_DISPOSITION=blocked');
      expect(nonzeroResult.stdout).toContain('BLOCKED_SCALAR_TYPE=System.Boolean');
      expect(nonzeroResult.stdout).toContain('BLOCKED_SCALAR_VALUE=True');
      expect(nonzeroResult.stdout).toContain(`${nonzeroDiagnostics}\n`);
      expect(nonzeroResult.stderr).toBe('');

      const zeroResult = runParser(zeroDiagnostics, [
        '$lines = @($env:FINANCIAL_DIAGNOSTICS_TEST_INPUT -split "`n")',
        '$canonical = ConvertTo-FinancialOperationalDiagnostics -Lines $lines',
        '$blocked = Write-FinancialOperationalDisposition -CanonicalDiagnostics $canonical',
        '[Console]::Out.WriteLine("BLOCKED_SCALAR_TYPE=$($blocked.GetType().FullName)")',
        '[Console]::Out.WriteLine("BLOCKED_SCALAR_VALUE=$blocked")',
        'if ($blocked) { exit 3 }'
      ]);
      expect(zeroResult.status).toBe(0);
      expect(zeroResult.stdout).toContain('FINANCIAL_OPERATIONAL_DISPOSITION=clear');
      expect(zeroResult.stdout).toContain('BLOCKED_SCALAR_TYPE=System.Boolean');
      expect(zeroResult.stdout).toContain('BLOCKED_SCALAR_VALUE=False');
      expect(zeroResult.stdout).not.toContain('OPERATIONAL_BLOCKER ');
      expect(zeroResult.stderr).toBe('');

      for (const invalidInput of invalidDiagnostics) {
        const invalidResult = runParser(invalidInput, [
          'try {',
          '  $lines = @($env:FINANCIAL_DIAGNOSTICS_TEST_INPUT -split "`n")',
          '  $null = ConvertTo-FinancialOperationalDiagnostics -Lines $lines',
          '  exit 3',
          '} catch {',
          "  [Console]::Out.WriteLine('GENERIC_FINANCIAL_DIAGNOSTIC_REJECTION')",
          '}'
        ]);
        expect(invalidResult.status).toBe(0);
        expect(invalidResult.stdout.trim()).toBe('GENERIC_FINANCIAL_DIAGNOSTIC_REJECTION');
        expect(invalidResult.stdout).not.toContain('SECRET_SENTINEL');
        expect(invalidResult.stderr).toBe('');
      }

      const directSinkResult = runParser(
        nonzeroDiagnostics.replace(
          'pending_replay_child_incomplete,2',
          'pending_replay_child_incomplete,2,SECRET_SENTINEL'
        ),
        [
          'try {',
          '  $null = Write-FinancialOperationalDisposition -CanonicalDiagnostics $env:FINANCIAL_DIAGNOSTICS_TEST_INPUT',
          '  exit 3',
          '} catch {',
          "  [Console]::Out.WriteLine('GENERIC_FINANCIAL_DISPOSITION_REJECTION')",
          '}'
        ]
      );
      expect(directSinkResult.status).toBe(0);
      expect(directSinkResult.stdout.trim()).toBe('GENERIC_FINANCIAL_DISPOSITION_REJECTION');
      expect(directSinkResult.stdout).not.toContain('SECRET_SENTINEL');
      expect(directSinkResult.stderr).toBe('');
    }

    expect(restorePowerShell).toContain('function Read-FinancialOperationalDiagnostics');
    const readerFunctions = [
      "$ErrorActionPreference = 'Stop'",
      documentedPowerShellFunction(
        restorePowerShell,
        'ConvertTo-FinancialOperationalDiagnostics'
      ),
      documentedPowerShellFunction(restorePowerShell, 'Read-FinancialOperationalDiagnostics')
    ].join('\n');
    const readerRoot = mkdtempSync(join(tmpdir(), 'pale-orbit-financial-diagnostics-'));
    const readerPath = join(readerRoot, 'financial-operational-diagnostics.csv');
    const runReader = (bytes: Buffer) => spawnSync(
      'powershell.exe',
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        [
          readerFunctions,
          '[System.IO.File]::WriteAllBytes($env:FINANCIAL_DIAGNOSTICS_TEST_PATH, [Convert]::FromBase64String($env:FINANCIAL_DIAGNOSTICS_TEST_BASE64))',
          'try {',
          '  $canonical = Read-FinancialOperationalDiagnostics -Path $env:FINANCIAL_DIAGNOSTICS_TEST_PATH',
          "  [Console]::Out.WriteLine('CANONICAL_FINANCIAL_DIAGNOSTICS')",
          '} catch {',
          "  [Console]::Out.WriteLine('GENERIC_FINANCIAL_BYTE_REJECTION')",
          '}'
        ].join('\n')
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FINANCIAL_DIAGNOSTICS_TEST_PATH: readerPath,
          FINANCIAL_DIAGNOSTICS_TEST_BASE64: bytes.toString('base64')
        }
      }
    );
    try {
      const canonicalBytes = Buffer.from(`${zeroDiagnostics}\n`, 'utf8');
      const validBytes = runReader(canonicalBytes);
      expect(validBytes.status).toBe(0);
      expect(validBytes.stdout.trim()).toBe('CANONICAL_FINANCIAL_DIAGNOSTICS');
      for (const bytes of [
        Buffer.from(`${zeroDiagnostics.replaceAll('\n', '\r\n')}\r\n`, 'utf8'),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonicalBytes]),
        Buffer.from(zeroDiagnostics, 'utf8'),
        Buffer.from(`${zeroDiagnostics}\n\n`, 'utf8'),
        Buffer.from([0xff])
      ]) {
        const invalidBytes = runReader(bytes);
        expect(invalidBytes.status).toBe(0);
        expect(invalidBytes.stdout.trim()).toBe('GENERIC_FINANCIAL_BYTE_REJECTION');
        expect(invalidBytes.stderr).toBe('');
      }
    } finally {
      rmSync(readerRoot, { force: true, recursive: true });
    }
  }, 40_000);

  it('rejects non-regular restored storage entries before verification or startup', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');

    for (const [script, archive, safety, sample, migrate, app] of [
      [
        restorePowerShell,
        'tar -C /restore -xzf /backup/storage.tar.gz',
        'find /restore -xdev ! -type d ! -type f -print -quit',
        'Assert-RestoredStorageSamples',
        'run --rm migrate',
        'up --detach --wait app'
      ],
      [
        restoreShell,
        'tar -C /restore -xzf /backup/storage.tar.gz',
        'find /restore -xdev ! -type d ! -type f -print -quit',
        'verify_restored_storage_samples',
        'run --rm migrate',
        'up --detach --wait app'
      ]
    ] as const) {
      const archiveIndex = script.indexOf(archive);
      const safetyIndex = script.indexOf(safety, archiveIndex);
      const appIndex = script.indexOf(app);
      expect(archiveIndex).toBeGreaterThan(-1);
      expect(safetyIndex).toBeGreaterThan(archiveIndex);
      expect(script.slice(safetyIndex)).toContain(
        'find /restore -xdev ! -type d ! -type f -print -quit)" || exit 1; test -z "$unsafe"'
      );
      expect(safetyIndex).toBeLessThan(script.indexOf(migrate, safetyIndex));
      expect(safetyIndex).toBeLessThan(script.lastIndexOf(sample, appIndex));
      expect(safetyIndex).toBeLessThan(appIndex);
    }
  });

  it('arms plaintext disposition and teardown guards before source or verified plaintext work', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const backupPowerShell = fencedCodeBlocks(backupSection, 'powershell').join('\n');
    const backupShell = fencedCodeBlocks(backupSection, 'sh').join('\n');
    const integrityPowerShell = fencedCodeBlocks(integritySection, 'powershell').join('\n');
    const integrityShell = fencedCodeBlocks(integritySection, 'sh').join('\n');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const restoreShell = fencedCodeBlocks(restoreSection, 'sh').join('\n');

    expect(backupPowerShell.indexOf('$sourceWorkspaceDispositionArmed = $true')).toBeLessThan(
      backupPowerShell.indexOf('stop app worker')
    );
    expect(backupPowerShell).toMatch(/try \{[\s\S]*finally \{[\s\S]*Invoke-PlaintextDisposition[^\n]*\$backup/u);
    expect(backupShell.indexOf("trap 'finish_source_backup")).toBeLessThan(
      backupShell.indexOf('stop app worker')
    );
    expect(backupShell).toMatch(/finish_source_backup\(\)[\s\S]*dispose_plaintext_workspace[^\n]*\$backup/u);
    for (const shell of [backupShell, integrityShell]) {
      const dispositionFunction = shell.slice(shell.indexOf('dispose_plaintext_workspace()'));
      expect(dispositionFunction.indexOf('[ ! -L "$1" ]')).toBeGreaterThan(-1);
      expect(dispositionFunction.indexOf('[ ! -L "$1" ]')).toBeLessThan(
        dispositionFunction.indexOf('readlink -f -- "$1"')
      );
      expect(dispositionFunction).toContain('[ "$disposition_workspace" = "$2" ]');
    }
    expect(backupShell).toContain('dispose_plaintext_workspace "$backup" "$backup"');
    expect(integrityShell).toContain(
      'dispose_plaintext_workspace "$verified_restore" "$verified_restore"'
    );
    expect(restoreShell).toContain(
      'dispose_plaintext_workspace "$verified_restore" "$verified_restore"'
    );

    const verifiedSessionIndex = integrityPowerShell.indexOf(
      'function Invoke-VerifiedRestoreSession'
    );
    const verifiedSessionTryIndex = integrityPowerShell.indexOf('try {', verifiedSessionIndex);
    const decryptIndex = integrityPowerShell.indexOf(
      'test-decrypt $destinationCiphertext $verifiedRestore',
      verifiedSessionIndex
    );
    const restoreActionIndex = integrityPowerShell.indexOf(
      '& $RestoreAction $verifiedRestore',
      decryptIndex
    );
    const verifiedSessionFinallyIndex = integrityPowerShell.indexOf(
      'finally {',
      restoreActionIndex
    );
    const synchronousDispositionIndex = integrityPowerShell.indexOf(
      'Invoke-PlaintextDisposition $verifiedRestore',
      verifiedSessionFinallyIndex
    );
    expect(verifiedSessionIndex).toBeGreaterThan(-1);
    expect(verifiedSessionTryIndex).toBeLessThan(decryptIndex);
    expect(decryptIndex).toBeLessThan(restoreActionIndex);
    expect(restoreActionIndex).toBeLessThan(verifiedSessionFinallyIndex);
    expect(verifiedSessionFinallyIndex).toBeLessThan(synchronousDispositionIndex);
    expect(integrityPowerShell).not.toContain('Register-EngineEvent');
    expect(integrityShell.indexOf("trap 'finish_verified_restore")).toBeLessThan(
      integrityShell.indexOf('test-decrypt "$destination_ciphertext" "$verified_restore"')
    );

    expect(restorePowerShell.trimStart().startsWith('Invoke-VerifiedRestoreSession {')).toBe(true);
    expect(restorePowerShell).toContain(
      'param([Parameter(Mandatory)][string]$verifiedRestore)'
    );
    const finallyIndex = restorePowerShell.lastIndexOf('finally {');
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(restorePowerShell.indexOf('try {')).toBeLessThan(
      restorePowerShell.indexOf("'APPROVED_RESTORE_DOCKER_CONTEXT'")
    );
    const finalizer = restorePowerShell.slice(finallyIndex);
    expect(finalizer).toContain('rm -f /tmp/database.dump');
    expect(finalizer).toContain('Assert-RestoreDockerEngineBinding');
    expect(finalizer).toContain('down --volumes');
    expect(finalizer).toContain('Assert-RestoreProjectAbsent');
    expect(finalizer).not.toContain('Invoke-PlaintextDisposition');
    expect(finalizer).not.toContain('Unregister-Event');
  });

  it('synchronously disposes verified Windows plaintext and surfaces disposition failure', async () => {
    if (process.platform !== 'win32') return;

    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const integrityPowerShell = fencedCodeBlocks(integritySection, 'powershell').join('\n');
    const harness = [
      integrityPowerShell,
      `
function New-RestrictedWorkspace {
  param([string]$Parent, [string]$Prefix)
  $workspace = Join-Path $env:RESTORE_TEST_ROOT 'verified'
  $null = New-Item -ItemType Directory -Path $workspace -ErrorAction Stop
  return [string]$workspace
}
function Mock-Retrieve {
  param([string]$Verb, [string]$Destination)
  [System.IO.File]::WriteAllText($Destination, 'ciphertext')
  $global:LASTEXITCODE = 0
}
function Mock-Decrypt {
  param([string]$Verb, [string]$Ciphertext, [string]$Workspace)
  $required = @(
    'database.dump', 'storage.tar.gz', 'migration-journal.csv', 'application-image.json',
    'restore-row-counts.csv', 'storage-samples.csv', 'source-docker-engine.json',
    'financial-operational-diagnostics.csv', 'verify-financial-restore.sql'
  )
  $manifest = foreach ($name in $required) {
    $path = Join-Path $Workspace $name
    [System.IO.File]::WriteAllText($path, "verified-$name")
    $digest = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    "$digest *$name"
  }
  [System.IO.File]::WriteAllLines((Join-Path $Workspace 'backup-file-manifest.sha256'), $manifest)
  $global:LASTEXITCODE = 0
}
function Invoke-PlaintextDisposition {
  param([string]$Workspace)
  [System.IO.File]::WriteAllText($env:RESTORE_DISPOSITION_MARKER, 'called')
  if ($env:RESTORE_DISPOSITION_FAIL -eq '1') { throw 'forced disposition failure' }
  Remove-Item -LiteralPath $Workspace -Recurse -Force -ErrorAction Stop
}
$global:LASTEXITCODE = 0
$env:BACKUP_SOURCE_CIPHERTEXT_SHA256 = '305531dcc50ebca31cf1d5b31e9fc76ed51f66b3b6dd5a030c6539ae6532f979'
$env:BACKUP_DESTINATION_CIPHERTEXT = Join-Path $env:RESTORE_TEST_ROOT 'ciphertext.bin'
$env:BACKUP_RETRIEVE_COMMAND = 'Mock-Retrieve'
$env:BACKUP_TEST_DECRYPT_COMMAND = 'Mock-Decrypt'
$env:PLAINTEXT_DISPOSITION_COMMAND = 'unused-by-harness'
Invoke-VerifiedRestoreSession {
  param([string]$verifiedRestore)
  if ($env:RESTORE_CALLBACK_FAIL -eq '1') { throw 'forced restore callback failure' }
}
`
    ].join('\n');

    const windowsPowerShellEnvironment = { ...process.env };
    // A PowerShell 7 parent may export a bundled, Core-only module path.
    // Let Windows PowerShell rebuild its own defaults before it autoloads
    // Microsoft.PowerShell.Utility for Get-FileHash.
    for (const key of Object.keys(windowsPowerShellEnvironment)) {
      if (key.toLowerCase() === 'psmodulepath') delete windowsPowerShellEnvironment[key];
    }

    const runHarness = (callbackFailure: boolean, dispositionFailure: boolean) => {
      const testRoot = mkdtempSync(join(tmpdir(), 'pale-orbit-restore-wrapper-'));
      const marker = join(testRoot, 'disposition-called');
      const result = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', harness],
        {
          encoding: 'utf8',
          env: {
            ...windowsPowerShellEnvironment,
            RESTORE_TEST_ROOT: testRoot,
            RESTORE_DISPOSITION_MARKER: marker,
            RESTORE_CALLBACK_FAIL: callbackFailure ? '1' : '0',
            RESTORE_DISPOSITION_FAIL: dispositionFailure ? '1' : '0'
          }
        }
      );
      return { marker, result, testRoot, workspace: join(testRoot, 'verified') };
    };

    const callbackFailure = runHarness(true, false);
    try {
      expect(callbackFailure.result.status).not.toBe(0);
      expect(callbackFailure.result.stderr).toContain('forced restore callback failure');
      expect(existsSync(callbackFailure.marker)).toBe(true);
      expect(existsSync(callbackFailure.workspace)).toBe(false);
    } finally {
      rmSync(callbackFailure.testRoot, { force: true, recursive: true });
    }

    const dispositionFailure = runHarness(false, true);
    try {
      expect(dispositionFailure.result.status).not.toBe(0);
      expect(dispositionFailure.result.stderr).toContain('forced disposition failure');
      expect(existsSync(dispositionFailure.marker)).toBe(true);
    } finally {
      rmSync(dispositionFailure.testRoot, { force: true, recursive: true });
    }
  }, 20_000);

  it('uses terminating PowerShell semantics and validates every SHA-256 value', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const operationalPowerShell = [
      markdownSection(storageRunbook, 'Coordinated backup'),
      markdownSection(storageRunbook, 'Integrity sampling'),
      markdownSection(storageRunbook, 'Isolated restore rehearsal')
    ]
      .flatMap((section) => fencedCodeBlocks(section, 'powershell'))
      .join('\n');

    expect(operationalPowerShell).toContain("$ErrorActionPreference = 'Stop'");
    for (const line of operationalPowerShell.split(/\r?\n/u)) {
      if (/\bGet-FileHash\b/u.test(line)) expect(line).toContain('-ErrorAction Stop');
    }
    expect(operationalPowerShell).toContain("'^[0-9a-f]{64}$'");
    expect(operationalPowerShell).toContain('@sha256:[0-9a-f]{64}$');
    expect(operationalPowerShell).toMatch(/actualDigest[^\n]*-notmatch '\^\[0-9a-f\]\{64\}\$'/u);
  });

  it('verifies every required file from the exact destination ciphertext before restore', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const requiredFileLists = [backupSection, integritySection].map(
      (section) =>
        section.match(/\$requiredBackupFiles\s*=\s*@\((?<files>[\s\S]*?)\r?\n\s*\)/u)?.groups
          ?.files
    );

    for (const requiredFiles of requiredFileLists) {
      expect(requiredFiles).toBeDefined();
      for (const requiredFile of [
        'database.dump',
        'storage.tar.gz',
        'migration-journal.csv',
        'application-image.json'
      ]) {
        expect(requiredFiles).toContain(`'${requiredFile}'`);
      }
    }
    expect(backupSection).toContain('backup-file-manifest.sha256');
    expect(integritySection).toContain('$sourceCiphertextSha256');
    expect(integritySection).toContain('$destinationCiphertextHash');
    expect(integritySection).toContain(
      '$destinationCiphertextHash -ne $sourceCiphertextSha256'
    );
    expect(integritySection).toContain('$destinationCiphertext');
    expect(integritySection).toContain('$verifiedRestore');
    expect(integritySection).toContain('test-decrypt');
    expect(integritySection).toMatch(
      /test-decrypt[^\n]*\$destinationCiphertext[^\n]*\$verifiedRestore/u
    );
    expect(integritySection.indexOf('$destinationCiphertextHash -ne')).toBeLessThan(
      integritySection.indexOf('test-decrypt $destinationCiphertext $verifiedRestore')
    );
    expect(integritySection).toContain('Compare-Object');
    expect(integritySection).toContain('$requiredBackupFiles + $manifestName');
    expect(integritySection).toContain('authenticated encrypted artifact');
    expect(storageRunbook).toContain('securely delete');
    expect(storageRunbook).toContain('access-controlled retention');
    expect(storageRunbook).toContain('verification plaintext');
    expect(integritySection).not.toContain(
      "or use the tool's documented full-archive authentication command"
    );
    expect(restoreSection).toContain("(Join-Path $verifiedRestore 'database.dump')");
    expect(restoreSection).toContain(
      "-v \"$(Join-Path $verifiedRestore 'storage.tar.gz'):/backup/storage.tar.gz:ro\""
    );
    expect(restoreSection).not.toContain("(Join-Path $backup 'database.dump')");
    expect(restoreSection).not.toContain('-v "${backup}:/backup:ro"');
  });

  it('fails closed after every native backup and restore command', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const backupSection = markdownSection(storageRunbook, 'Coordinated backup');
    const integritySection = markdownSection(storageRunbook, 'Integrity sampling');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const powerShell = [backupSection, integritySection, restoreSection]
      .flatMap((section) => fencedCodeBlocks(section, 'powershell'))
      .join('\n');

    expect(powerShell).toMatch(
      /function Assert-NativeSuccess[\s\S]*\$LASTEXITCODE[\s\S]*throw/u
    );
    expectNativeCommandsFailClosed(powerShell);
    expect(backupSection).toMatch(
      /\$migrationJournal\s*=\s*@\(& docker --context \$sourceDockerContext compose[^\n]*psql/u
    );
    expect(backupSection).toContain('$migrationText = ConvertTo-CanonicalBackupText');
    expect(backupSection).toContain(
      "[System.IO.File]::WriteAllText((Join-Path $backup 'migration-journal.csv')"
    );
    expect(backupSection).not.toMatch(/psql[^\n]*\|\s*(?:Set-Content|\[System\.IO\.File\]::WriteAllText)/u);
    expect(backupSection).toMatch(
      /\$applicationImageDigest\s*=\s*@\(& docker --context \$sourceDockerContext image inspect/u
    );
    expect(backupSection).toContain('$requiredItem.Length -le 0');
    expect(backupSection.indexOf('$requiredItem.Length -le 0')).toBeLessThan(
      backupSection.indexOf('Get-FileHash -LiteralPath $path')
    );
  });

  it('uses a collision-resistant restore project and proves no worker is running', async () => {
    const storageRunbook = await source('docs/storage-ingestion-and-publication.md');
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');
    const restorePowerShell = fencedCodeBlocks(restoreSection, 'powershell').join('\n');
    const composeStarts = restorePowerShell.match(
      /^\s*& docker --context \$restoreDockerContext compose .*\bup\b.*$/gmu
    ) ?? [];
    const preflightIndex = restorePowerShell.indexOf(
      '$preflightInventory = Get-RestoreProjectInventory'
    );
    const firstUpIndex = restorePowerShell.indexOf(composeStarts[0] ?? 'missing first up');
    const preTeardownIndex = restorePowerShell.indexOf(
      '$preTeardownInventory = Get-RestoreProjectInventory'
    );
    const downIndex = restorePowerShell.indexOf(
      'docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml down --volumes'
    );
    const postTeardownIndex = restorePowerShell.indexOf(
      '$postTeardownInventory = Get-RestoreProjectInventory'
    );

    expect(restoreSection).toContain("[guid]::NewGuid().ToString('N')");
    expect(restoreSection).not.toContain("$restoreProject = 'pale-orbit-restore-check'");
    expect(restoreSection).toContain('docker --context $restoreDockerContext container ls --all --quiet');
    expect(restoreSection).toContain('docker --context $restoreDockerContext network ls --quiet');
    expect(restoreSection).toContain('docker --context $restoreDockerContext volume ls --quiet');
    expect(restoreSection).toContain('label=com.docker.compose.project=$restoreProject');
    expect(restoreSection).toContain('label=com.docker.compose.service=worker');
    expect(restoreSection).toContain('Assert-RestoreWorkerStopped');
    expect(restoreSection).toContain('function Get-RestoreProjectInventory');
    expect(restorePowerShell.indexOf('create app')).toBeLessThan(
      restorePowerShell.indexOf('-v "${restoreProject}_book_storage:/restore"')
    );
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(firstUpIndex);
    expect((restorePowerShell.match(/Assert-RestoreWorkerStopped/gmu) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(composeStarts).toHaveLength(2);
    expect(composeStarts[0]).toMatch(/\bpostgres\s*$/u);
    expect(composeStarts[1]).toMatch(/\bapp\s*$/u);
    const restoreLines = restorePowerShell.split(/\r?\n/u).map((line) => line.trim());
    for (const command of composeStarts) {
      expect(command).not.toMatch(/\bworker\b/u);
      const commandIndex = restoreLines.indexOf(command.trim());
      expect(restoreLines[commandIndex - 1]).toBe('Assert-RestoreWorkerStopped');
      expect(restoreLines[commandIndex + 1]).toMatch(/^Assert-NativeSuccess\b/u);
      expect(restoreLines[commandIndex + 2]).toBe('Assert-RestoreWorkerStopped');
    }
    expect(preTeardownIndex).toBeGreaterThan(firstUpIndex);
    expect(preTeardownIndex).toBeLessThan(downIndex);
    expect(postTeardownIndex).toBeGreaterThan(downIndex);
    expect(restorePowerShell.slice(downIndex, postTeardownIndex)).toContain(
      "Assert-NativeSuccess 'destroy isolated restore project'"
    );
    expect(restorePowerShell.slice(postTeardownIndex)).toContain(
      'Assert-RestoreProjectAbsent $postTeardownInventory'
    );
    expect(restoreSection).toContain('every file under `$verifiedRestore`');
    for (const plaintext of [
      'database.dump',
      'storage.tar.gz',
      'migration-journal.csv',
      'application-image.json',
      'backup-file-manifest.sha256'
    ]) {
      expect(restoreSection).toContain(plaintext);
    }
    expect(restoreSection).toContain('secure-deletion or access-controlled-retention');
  });

  it('limits the worker-free maintenance rehearsal to reachable health checks', async () => {
    const [storageRunbook, financialRunbook] = await Promise.all([
      source('docs/storage-ingestion-and-publication.md'),
      source('docs/stripe-financial-reconciliation.md')
    ]);
    const restoreSection = markdownSection(storageRunbook, 'Isolated restore rehearsal');

    for (const [name, document] of [
      ['storage runbook', storageRunbook],
      ['financial runbook', financialRunbook]
    ] as const) {
      expect(document, name).toContain(
        'Keep the general worker stopped for the entire isolated restore rehearsal'
      );
      expect(document, name).toContain('Provider absence is not sufficient isolation');
      expect(document, name).toContain('claim-email and SMTP outbox jobs');
      expect(document, name).toContain('separately approved production replacement');
      expect(document, name).toContain('no-egress rehearsal runtime');
      expect(document, name).toContain('synthetic SMTP');
      expect(document, name).toContain('job-family allowlist');
      expect(document, name).toContain('does not currently supply');
      expect(document, name).toContain(
        'Maintenance mode admits only `/health/live` and `/health/ready`'
      );
    }

    expect(restoreSection).toContain("fetch('http://127.0.0.1:3000'+path)");
    expect(restoreSection).not.toContain('bootstrap/admin password sign-in');
    expect(restoreSection).not.toContain('admin review');
    expect(restoreSection).not.toContain('sampled previews');
    expect(storageRunbook).not.toContain('Start app and worker only on an isolated network');
    expect(financialRunbook).not.toContain('or prove that no provider-backed work is pending/running');
  });

  it('keeps example credentials empty and non-secret', async () => {
    const example = await source('.env.example');
    expect(example).toMatch(/^STRIPE_SECRET_KEY=\s*$/mu);
    expect(example).toMatch(/^STRIPE_WEBHOOK_SECRET=\s*$/mu);
    expect(example).not.toMatch(/^STRIPE_SECRET_KEY=sk_(?:test|live)_[^\s]+/mu);
    expect(example).not.toMatch(/^STRIPE_WEBHOOK_SECRET=whsec_[^\s]+/mu);
  });
});
