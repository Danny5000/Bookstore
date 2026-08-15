import { readFile, readdir } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const executeFile = promisify(execFile);
const stripePreflightPath = fileURLToPath(
  new URL('./stripe-secret-preflight.mjs', import.meta.url)
);
const restoreVerifierWitnessPath = fileURLToPath(
  new URL('./execute-financial-restore-verifier.ts', import.meta.url)
);
const withTestDatabasePath = fileURLToPath(new URL('./with-test-database.ts', import.meta.url));

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
        DATABASE_USER: 'validation_user',
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
    for (const name of ['app', 'worker', 'migrate', 'bootstrap-admin']) {
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

  it('enables and mounts Stripe secrets only in app and worker after merging the overlay', async () => {
    const baseline = await composeConfiguration('compose.prod.yaml');
    const merged = await composeConfiguration('compose.prod.yaml', 'compose.stripe.yaml');
    const stripeServices = ['app', 'worker'];
    expect(Object.entries(merged.services)
      .filter(([, service]) => service.environment?.STRIPE_ENABLED === 'true')
      .map(([name]) => name)
      .sort()).toEqual(stripeServices);
    for (const fileSetting of ['STRIPE_SECRET_KEY_FILE', 'STRIPE_WEBHOOK_SECRET_FILE']) {
      expect(Object.entries(merged.services)
        .filter(([, service]) => service.environment?.[fileSetting] !== undefined)
        .map(([name]) => name)
        .sort()).toEqual(stripeServices);
    }
    for (const stripeSecret of ['stripe_secret_key', 'stripe_webhook_secret']) {
      expect(Object.entries(merged.services)
        .filter(([, service]) => mountedSecretSources(service).includes(stripeSecret))
        .map(([name]) => name)
        .sort()).toEqual(stripeServices);
    }
    for (const name of stripeServices) {
      expect(merged.services[name]?.environment, name).toMatchObject({
        APPLICATION_MODE: 'maintenance',
        STRIPE_ENABLED: 'true',
        STRIPE_TEST_FIXTURE_MODE: 'false',
        STRIPE_LIVE_MODE: 'false',
        STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe_secret_key',
        STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/stripe_webhook_secret'
      });
      expect(mountedSecretSources(merged.services[name]!)).toEqual([
        'auth_secret',
        'database_password',
        'smtp_password',
        'stripe_secret_key',
        'stripe_webhook_secret'
      ]);
    }
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
    const [rowCounts, storageSamples, financialVerifier, financialRunbook] = await Promise.all([
      source('scripts/capture-restore-row-counts.sql'),
      source('scripts/capture-storage-samples.sql'),
      source('scripts/verify-financial-restore.sql'),
      source('docs/stripe-financial-reconciliation.md')
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
      'financial_unknown_classification_issue',
      'financial_item_allocation_parent',
      'dispute_presentment_child_cardinality',
      'pending_replay_child_count_mismatch',
      'pending_replay_child_version_mismatch',
      'pending_replay_child_incomplete',
      'pending_replay_child_retry_exhausted',
      'pending_replay_child_permanent',
      'combined_refund_dispute_chronology_capacity',
      'refund_component_chronology_capacity',
      'refund_component_deterministic_split'
    ]) {
      expect(financialVerifier).toContain(`'${checkName}'`);
    }
    expect(restoreChecks).toContain("'financial_payout_discovery_singleton'");
    expect(restoreChecks).toContain("'combined_refund_dispute_chronology_capacity'");
    const verifierConservationSql = financialVerifier.match(
      /with fee_sums as \([\s\S]*?from conservation_counts\norder by check_name;/u
    )?.[0];
    const documentedConservationSql = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore signed-conservation check'),
      'sql'
    )[0];
    expect(verifierConservationSql).toBeDefined();
    expect(documentedConservationSql?.trim()).toBe(verifierConservationSql?.trim());
    const verifierStructuralSql = financialVerifier.match(
      /with orphan_counts as \([\s\S]*?from orphan_counts\s+where violation_count <> 0\s+order by check_name;/u
    )?.[0];
    const documentedStructuralSql = fencedCodeBlocks(
      markdownSection(financialRunbook, 'Post-restore orphan check'),
      'sql'
    )[0];
    expect(verifierStructuralSql).toBeDefined();
    expect(documentedStructuralSql?.trim()).toBe(verifierStructuralSql?.trim());
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
      /financial_item_allocation_parent[\s\S]*s\.scope <> 'title'[\s\S]*i\.currency <> s\.currency[\s\S]*payment_source\.order_id[\s\S]*refund_payment\.order_id[\s\S]*dispute_payment\.order_id/u
    );
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
    expect(financialVerifier).toMatch(
      /s\.currency = a\.currency[\s\S]*?sum\(settlement\.effect_minor\)::bigint[\s\S]*?settlement\.order_item_id = a\.order_item_id[\s\S]*?a\.total_effect_minor/u
    );
    expect(financialVerifier).toMatch(
      /s\.currency <> a\.currency[\s\S]*?a\.effect = 'withdrawal'[\s\S]*?sum\(presentment\.total_effect_minor\)[\s\S]*?<> -d\.amount_minor/u
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
    const physicalTables = new Set(
      Array.from(
        migrations.matchAll(/create table\s+(?:"public"\.)?"(?<name>[a-z_][a-z0-9_]*)"/giu),
        (match) => match.groups?.name ?? ''
      ).filter(Boolean)
    );
    const cteNames = new Set(
      Array.from(
        financialVerifier.matchAll(/(?:\bwith|,)\s*(?<name>[a-z_][a-z0-9_]*)\s+as\s*\(/giu),
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
        !['lateral', 'restore_financial_checks'].includes(name)
    );
    expect(
      [...new Set(relationReferences.filter((name) => !physicalTables.has(name)))].sort()
    ).toEqual([]);
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
  }, 20_000);

  it('executes classification, payout, replay-child, allocation-graph, refund-component, dispute-presentment, and combined-chronology verifier witnesses in PostgreSQL', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        withTestDatabasePath,
        process.execPath,
        '--import',
        'tsx',
        restoreVerifierWitnessPath,
        '--exercise-financial-invariant-witnesses'
      ],
      {
        cwd: new URL('.', root),
        encoding: 'utf8',
        env: process.env,
        timeout: 120_000
      }
    );
    expect(`${result.stdout}${result.stderr}`).toContain(
      '[restore-verifier] classification, payout, replay-child, allocation-graph, refund-component, dispute-presentment, and combined-chronology witnesses passed'
    );
    expect(result.status).toBe(0);
  }, 130_000);

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
    expect(powerShellBeforeStart.match(/\$env:(?:DATABASE_PASSWORD|AUTH_SECRET|SMTP_PASSWORD|BOOTSTRAP_ADMIN_PASSWORD) = New-RehearsalSecret/gmu)).toHaveLength(4);
    expect(powerShellBeforeStart).toContain("$env:DATABASE_NAME = 'restore_rehearsal'");
    expect(powerShellBeforeStart).toContain("$env:DATABASE_USER = 'restore_rehearsal'");
    expect(powerShellBeforeStart).toContain("$env:ORIGIN = 'https://restore.invalid'");
    expect(powerShellBeforeStart).toContain("$env:SITE_ADDRESS = 'restore.invalid'");
    expect(powerShellBeforeStart).toContain("$env:SMTP_HOST = '127.0.0.1'");
    expect(powerShellBeforeStart).toContain("$env:SMTP_PORT = '1'");
    expect(powerShellBeforeStart).toContain('Env:STRIPE_SECRET_KEY');
    expect(powerShellBeforeStart).toContain('Env:STRIPE_WEBHOOK_SECRET');

    expect(shellBeforeStart).toContain('new_rehearsal_secret()');
    for (const secret of [
      'DATABASE_PASSWORD',
      'AUTH_SECRET',
      'SMTP_PASSWORD',
      'BOOTSTRAP_ADMIN_PASSWORD'
    ]) {
      expect(shellBeforeStart).toContain(`${secret}="$(new_rehearsal_secret)"`);
      expect(shellBeforeStart).toContain(`export ${secret}`);
    }
    expect(shellBeforeStart).toContain('DATABASE_NAME=restore_rehearsal');
    expect(shellBeforeStart).toContain('DATABASE_USER=restore_rehearsal');
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
        mutation: /(?:^compose_restore (?:up|create)\b|^restore_docker cp\b|\bpg_restore\b|^restore_docker run --rm\b|\brun --rm (?:migrate|storage-cleanup)\b|\brm -f \/tmp\/database\.dump|\bdown --volumes\b)/u
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

    const runHarness = (callbackFailure: boolean, dispositionFailure: boolean) => {
      const testRoot = mkdtempSync(join(tmpdir(), 'pale-orbit-restore-wrapper-'));
      const marker = join(testRoot, 'disposition-called');
      const result = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', harness],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
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
