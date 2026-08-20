import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { withoutStripeProviderSecrets } from './test-environment';

const RUN_PREFIX = 'pale-orbit-plan6b-';
const DATABASE_PREFIX = 'plan6b_';
const TEMP_PREFIX = join(resolve(tmpdir()), 'pale-orbit-plan6b-upgrade-');
const COMPOSE_FILE_NAME = 'compose.plan6b.yaml';
const MANIFEST_FILE_NAME = 'owned-run.json';
const MIGRATION_0007_FILE_NAME = '0007_plan6b_financial_reconciliation.sql';
const LEGACY_MIGRATION_TAGS = [
  '0000_plan2_foundation',
  '0001_audit_events_append_only',
  '0002_authentication_identity',
  '0003_plan4_publications',
  '0004_plan5_reader_library',
  '0005_public_firelord',
  '0006_credential_authority'
] as const;

export interface OwnedRunManifest {
  version: 1;
  runId: string;
  project: string;
  database: string;
  user: string;
  password: string;
  ownershipToken: string;
  host: string;
  port: number;
  containerId: string;
  tempDirectory: string;
  composeFile: string;
  manifestFile: string;
}

export interface OwnedRuntimeObservation {
  project: string;
  cleanupProject: string;
  cleanupComposeFile: string;
  cleanupTempDirectory: string;
  containerId: string;
  labels: Record<string, string>;
  containerEnvironment: Record<string, string>;
  host: string | null;
  port: number | null;
}

export interface OwnedUpgradeOperations {
  start(owned: OwnedRunManifest): Promise<void>;
  applyLegacyMigrations(owned: OwnedRunManifest): Promise<void>;
  runChild(owned: OwnedRunManifest): Promise<void>;
  cleanup(owned: OwnedRunManifest): Promise<void>;
}

export interface DockerCommandRuntime {
  run(argumentsToRun: readonly string[]): void;
  capture(argumentsToCapture: readonly string[]): string;
}

export interface OwnedManifestDependencies {
  readonly selectPort: () => Promise<number>;
  readonly writeTextFile: (path: string, contents: string) => Promise<void>;
  readonly removeTempDirectory: (path: string) => Promise<void>;
}

interface CommandInvocation {
  command: string;
  arguments: string[];
}

interface DockerInspectRecord {
  Id?: unknown;
  Config?: {
    Labels?: unknown;
    Env?: unknown;
  };
  NetworkSettings?: {
    Ports?: unknown;
  };
}

interface DockerResourceInspectRecord {
  Name?: unknown;
  Labels?: unknown;
}

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[plan6b-upgrade] ${message}`);
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), description);
  return value as Record<string, unknown>;
}

function exactGeneratedPath(path: string, expected: string, description: string): void {
  assert(resolve(path) === resolve(expected), `${description} does not match the owned-run manifest`);
}

function validateGeneratedTempDirectory(path: string): string {
  const resolvedTempDirectory = resolve(path);
  assert(
    dirname(resolvedTempDirectory) === resolve(tmpdir()) &&
      resolvedTempDirectory.startsWith(TEMP_PREFIX) &&
      basename(resolvedTempDirectory).startsWith('pale-orbit-plan6b-upgrade-'),
    'owned-run manifest temp directory is outside the generated prefix'
  );
  return resolvedTempDirectory;
}

function validateManifestIdentity(owned: OwnedRunManifest): void {
  assert(owned.version === 1, 'owned-run manifest version is invalid');
  assert(/^[a-f0-9]{16}$/u.test(owned.runId), 'owned-run manifest run ID is invalid');
  assert(
    owned.project === `${RUN_PREFIX}${owned.runId}`,
    'owned-run manifest project identity is invalid'
  );
  assert(
    owned.database === `${DATABASE_PREFIX}${owned.runId}`,
    'owned-run manifest database identity is invalid'
  );
  assert(owned.user === `${DATABASE_PREFIX}${owned.runId}`, 'owned-run manifest user identity is invalid');
  assert(/^[a-f0-9]{48}$/u.test(owned.password), 'owned-run manifest password identity is invalid');
  assert(
    /^[a-f0-9]{32}$/u.test(owned.ownershipToken),
    'owned-run manifest ownership token is invalid'
  );
  assert(owned.host === '127.0.0.1', 'owned-run manifest endpoint is not loopback');
  const resolvedTempDirectory = validateGeneratedTempDirectory(owned.tempDirectory);
  exactGeneratedPath(
    owned.composeFile,
    join(resolvedTempDirectory, COMPOSE_FILE_NAME),
    'compose file'
  );
  exactGeneratedPath(
    owned.manifestFile,
    join(resolvedTempDirectory, MANIFEST_FILE_NAME),
    'manifest file'
  );
}

function validateManifestShape(owned: OwnedRunManifest): void {
  validateManifestIdentity(owned);
  assert(
    Number.isInteger(owned.port) && owned.port > 0 && owned.port <= 65_535 && owned.port !== 5432,
    'owned-run manifest port is not ephemeral'
  );
  assert(/^[a-f0-9]{12,64}$/u.test(owned.containerId), 'owned-run manifest container ID is invalid');
}

function validateObservedIdentity(
  owned: OwnedRunManifest,
  observed: OwnedRuntimeObservation
): void {
  assert(!/[?*\s]/u.test(observed.cleanupProject), 'cleanup project is broad or invalid');
  assert(observed.cleanupProject === owned.project, 'cleanup project does not match the manifest');
  assert(observed.project === owned.project, 'observed project does not match the manifest');
  exactGeneratedPath(observed.cleanupComposeFile, owned.composeFile, 'cleanup compose file');
  exactGeneratedPath(observed.cleanupTempDirectory, owned.tempDirectory, 'cleanup temp directory');
  assert(observed.containerId === owned.containerId, 'observed container ID does not match the manifest');

  const expectedLabels: Record<string, string> = {
    ...expectedOwnershipLabels(owned),
    'com.docker.compose.service': 'postgres'
  };
  for (const [name, expected] of Object.entries(expectedLabels)) {
    assert(observed.labels[name] === expected, `container label ${name} does not match the manifest`);
  }

  assert(
    observed.containerEnvironment.POSTGRES_DB === owned.database,
    'container database identity does not match the manifest'
  );
  assert(
    observed.containerEnvironment.POSTGRES_USER === owned.user,
    'container user identity does not match the manifest'
  );
  assert(
    observed.containerEnvironment.POSTGRES_PASSWORD === owned.password,
    'container password identity does not match the manifest'
  );
}

function expectedOwnershipLabels(owned: OwnedRunManifest): Record<string, string> {
  return {
    'com.docker.compose.project': owned.project,
    'com.paleorbit.plan6b-upgrade.run': owned.runId,
    'com.paleorbit.plan6b-upgrade.owner': owned.ownershipToken,
    'com.paleorbit.plan6b-upgrade.database': owned.database,
    'com.paleorbit.plan6b-upgrade.user': owned.user
  };
}

export function parseLoopbackPublishedEndpoint(output: string): {
  host: '127.0.0.1';
  port: number;
} {
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(output.trim());
  assert(match?.[1], `published PostgreSQL endpoint is not loopback: ${output.trim() || '<empty>'}`);
  const port = Number(match[1]);
  assert(Number.isInteger(port) && port > 0 && port <= 65_535 && port !== 5432, 'published PostgreSQL port is not ephemeral');
  return { host: '127.0.0.1', port };
}

export function validateOwnedCleanup(
  owned: OwnedRunManifest | undefined,
  observed: OwnedRuntimeObservation
): void {
  assert(owned, 'owned-run manifest is missing');
  validateManifestShape(owned);
  validateObservedIdentity(owned, observed);
  assert(observed.host === '127.0.0.1', 'observed PostgreSQL endpoint is not loopback');
  assert(observed.port === owned.port, 'observed PostgreSQL port does not match the manifest');
}

export function validateOwnedStartupCleanup(
  owned: OwnedRunManifest | undefined,
  observed: OwnedRuntimeObservation
): void {
  assert(owned, 'owned-run manifest is missing');
  validateManifestIdentity(owned);
  assert(
    Number.isInteger(owned.port) && owned.port > 0 && owned.port <= 65_535 && owned.port !== 5432,
    'failed-startup manifest expected port is not ephemeral'
  );
  assert(/^[a-f0-9]{12,64}$/u.test(owned.containerId), 'owned-run manifest container ID is invalid');
  validateObservedIdentity(owned, observed);
  assert(
    observed.host === null && observed.port === null,
    'failed-startup cleanup is permitted only for an unbound container'
  );
}

export async function executeOwnedUpgradeRun(
  owned: OwnedRunManifest,
  operations: OwnedUpgradeOperations
): Promise<void> {
  let operationFailed = false;
  let operationError: unknown;
  try {
    await operations.start(owned);
    await operations.applyLegacyMigrations(owned);
    await operations.runChild(owned);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await operations.cleanup(owned);
  } catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        '[plan6b-upgrade] operation and cleanup both failed',
        { cause: cleanupError }
      );
    }
    throw cleanupError;
  }
  if (operationFailed) throw operationError;
}

function resolveInvocation(command: string, commandArguments: string[]): CommandInvocation {
  if (command === 'tsx') {
    return {
      command: process.execPath,
      arguments: [fileURLToPath(import.meta.resolve('tsx/cli')), ...commandArguments]
    };
  }
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    const npmCli = process.env.npm_execpath;
    assert(npmCli, 'npm_execpath is required to launch npm or npx on Windows');
    return {
      command: process.execPath,
      arguments: [
        command === 'npm' ? npmCli : join(dirname(npmCli), 'npx-cli.js'),
        ...commandArguments
      ]
    };
  }
  return { command, arguments: commandArguments };
}

function runChecked(
  command: string,
  commandArguments: string[],
  environment: NodeJS.ProcessEnv = process.env
): void {
  const invocation = resolveInvocation(command, commandArguments);
  const result = spawnSync(invocation.command, invocation.arguments, {
    env: environment,
    stdio: 'inherit'
  });
  assert(
    result.status === 0,
    `${command} ${commandArguments.join(' ')} exited with ${result.status ?? result.signal ?? 'no status'}`
  );
}

function capture(command: string, commandArguments: string[]): string {
  const invocation = resolveInvocation(command, commandArguments);
  const result = spawnSync(invocation.command, invocation.arguments, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert(
    result.status === 0,
    `${command} ${commandArguments.join(' ')} exited with ${result.status ?? result.signal ?? 'no status'}`
  );
  return result.stdout.trim();
}

const dockerCommandRuntime: DockerCommandRuntime = {
  run: (argumentsToRun) => runChecked('docker', [...argumentsToRun]),
  capture: (argumentsToCapture) => capture('docker', [...argumentsToCapture])
};

function composeArguments(owned: OwnedRunManifest): string[] {
  return ['compose', '--project-name', owned.project, '--file', owned.composeFile];
}

export function renderOwnedCompose(owned: OwnedRunManifest): string {
  return `services:
  postgres:
    image: postgres:18.4-alpine3.24
    environment:
      POSTGRES_DB: ${owned.database}
      POSTGRES_USER: ${owned.user}
      POSTGRES_PASSWORD: ${owned.password}
    labels:
      com.paleorbit.plan6b-upgrade.run: ${owned.runId}
      com.paleorbit.plan6b-upgrade.owner: ${owned.ownershipToken}
      com.paleorbit.plan6b-upgrade.database: ${owned.database}
      com.paleorbit.plan6b-upgrade.user: ${owned.user}
    ports:
      - "127.0.0.1:${owned.port}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U "${owned.user}" -d "${owned.database}"']
      interval: 1s
      timeout: 3s
      retries: 60
      start_period: 2s

networks:
  default:
    labels:
      com.paleorbit.plan6b-upgrade.run: ${owned.runId}
      com.paleorbit.plan6b-upgrade.owner: ${owned.ownershipToken}
      com.paleorbit.plan6b-upgrade.database: ${owned.database}
      com.paleorbit.plan6b-upgrade.user: ${owned.user}

volumes:
  postgres-data:
    labels:
      com.paleorbit.plan6b-upgrade.run: ${owned.runId}
      com.paleorbit.plan6b-upgrade.owner: ${owned.ownershipToken}
      com.paleorbit.plan6b-upgrade.database: ${owned.database}
      com.paleorbit.plan6b-upgrade.user: ${owned.user}
`;
}

function environmentEntries(values: unknown): Record<string, string> {
  assert(Array.isArray(values), 'container environment is missing');
  return Object.fromEntries(
    values.map((entry) => {
      assert(typeof entry === 'string' && entry.includes('='), 'container environment is invalid');
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    })
  );
}

function stringRecord(value: unknown, description: string): Record<string, string> {
  const record = asRecord(value, description);
  for (const item of Object.values(record)) assert(typeof item === 'string', description);
  return record as Record<string, string>;
}

function listOwnedContainerIds(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime
): string[] {
  return docker.capture([
    ...composeArguments(owned),
    'ps',
    '--all',
    '--quiet',
    'postgres'
  ]).split(/\r?\n/u).filter(Boolean);
}

function inspectOwnedRuntime(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime = dockerCommandRuntime,
  options: { allowUnbound?: boolean } = {}
): OwnedRuntimeObservation {
  const containerIds = listOwnedContainerIds(owned, docker);
  assert(containerIds.length === 1, 'expected exactly one owned PostgreSQL container');
  const inspection = JSON.parse(docker.capture(['inspect', containerIds[0]])) as unknown;
  assert(Array.isArray(inspection) && inspection.length === 1, 'Docker inspect result is invalid');
  const record = inspection[0] as DockerInspectRecord;
  assert(typeof record.Id === 'string', 'Docker inspect container ID is invalid');
  const configuration = asRecord(record.Config, 'Docker inspect configuration is invalid');
  const networkSettings = asRecord(record.NetworkSettings, 'Docker inspect network settings are invalid');
  const ports = asRecord(networkSettings.Ports, 'Docker inspect published ports are invalid');
  const bindings = ports['5432/tcp'];
  let endpoint: { host: '127.0.0.1'; port: number } | undefined;
  if (Array.isArray(bindings) && bindings.length === 1) {
    const binding = asRecord(bindings[0], 'PostgreSQL published-port binding is invalid');
    assert(typeof binding.HostIp === 'string' && typeof binding.HostPort === 'string', 'PostgreSQL published-port binding is invalid');
    endpoint = parseLoopbackPublishedEndpoint(`${binding.HostIp}:${binding.HostPort}`);
  } else {
    assert(
      options.allowUnbound && (bindings === undefined || (Array.isArray(bindings) && bindings.length === 0)),
      'PostgreSQL must have one published port'
    );
  }

  return {
    project: owned.project,
    cleanupProject: owned.project,
    cleanupComposeFile: owned.composeFile,
    cleanupTempDirectory: owned.tempDirectory,
    containerId: record.Id,
    labels: stringRecord(configuration.Labels, 'container labels are invalid'),
    containerEnvironment: environmentEntries(configuration.Env),
    host: endpoint?.host ?? null,
    port: endpoint?.port ?? null
  };
}

function validateContainerlessManifest(owned: OwnedRunManifest): void {
  validateManifestIdentity(owned);
  assert(
    Number.isInteger(owned.port) && owned.port > 0 && owned.port <= 65_535 && owned.port !== 5432,
    'failed-startup manifest expected port is not ephemeral'
  );
  assert(owned.containerId === '', 'containerless cleanup requires an empty container ID');
}

function exactComposeResourceNames(
  owned: OwnedRunManifest
): ReadonlyArray<readonly ['container' | 'network' | 'volume', string]> {
  return [
    ['container', `${owned.project}-postgres-1`],
    ['network', `${owned.project}_default`],
    ['volume', `${owned.project}_postgres-data`]
  ];
}

function exactComposeResourceNamesPresent(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime,
  kind: 'container' | 'network' | 'volume',
  expectedName: string
): boolean {
  const argumentsToCapture = kind === 'container'
    ? ['ps', '--all', '--filter', `name=${expectedName}`, '--format', '{{.Names}}']
    : [kind, 'ls', '--filter', `name=${expectedName}`, '--format', '{{.Name}}'];
  return docker.capture(argumentsToCapture).split(/\r?\n/u).filter(Boolean).includes(expectedName);
}

function assertNoExactComposeResourceCollision(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime
): void {
  validateContainerlessManifest(owned);
  for (const [kind, expectedName] of exactComposeResourceNames(owned)) {
    assert(
      !exactComposeResourceNamesPresent(owned, docker, kind, expectedName),
      `foreign exact-name Docker ${kind} collides with the owned upgrade run`
    );
  }
}

function inspectOwnedComposeResource(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime,
  kind: 'network' | 'volume',
  expectedName: string
): void {
  const inspection = JSON.parse(docker.capture([kind, 'inspect', expectedName])) as unknown;
  assert(Array.isArray(inspection) && inspection.length === 1, `${kind} inspect result is invalid`);
  const record = inspection[0] as DockerResourceInspectRecord;
  assert(record.Name === expectedName, `${kind} name does not match the manifest`);
  const labels = stringRecord(record.Labels, `${kind} labels are invalid`);
  for (const [name, expected] of Object.entries(expectedOwnershipLabels(owned))) {
    assert(labels[name] === expected, `${kind} label ${name} does not match the manifest`);
  }
}

function validateOwnedContainerlessResources(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime
): void {
  validateContainerlessManifest(owned);
  const expectedContainerName = `${owned.project}-postgres-1`;
  assert(
    !exactComposeResourceNamesPresent(owned, docker, 'container', expectedContainerName),
    'foreign exact-name Docker container blocks owned cleanup'
  );
  for (const [kind, expectedName] of [
    ['network', `${owned.project}_default`],
    ['volume', `${owned.project}_postgres-data`]
  ] as const) {
    const names = docker.capture([
      kind,
      'ls',
      '--filter',
      `label=com.docker.compose.project=${owned.project}`,
      '--format',
      '{{.Name}}'
    ]).split(/\r?\n/u).filter(Boolean);
    assert(
      names.length <= 1 && (names.length === 0 || names[0] === expectedName),
      `unexpected ${kind} belongs to the owned Compose project`
    );
    const exactNameExists = docker.capture([
      kind,
      'ls',
      '--filter',
      `name=${expectedName}`,
      '--format',
      '{{.Name}}'
    ]).split(/\r?\n/u).filter(Boolean).includes(expectedName);
    if (exactNameExists) inspectOwnedComposeResource(owned, docker, kind, expectedName);
  }
}

function assertNoOwnedComposeResourcesRemain(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime
): void {
  assert(listOwnedContainerIds(owned, docker).length === 0, 'owned container cleanup failed');
  const projectContainerIds = docker.capture([
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${owned.project}`
  ]).split(/\r?\n/u).filter(Boolean);
  assert(projectContainerIds.length === 0, 'owned container cleanup failed');
  const expectedContainerName = `${owned.project}-postgres-1`;
  const exactContainerNames = docker.capture([
    'ps',
    '--all',
    '--filter',
    `name=${expectedContainerName}`,
    '--format',
    '{{.Names}}'
  ]).split(/\r?\n/u).filter(Boolean);
  assert(!exactContainerNames.includes(expectedContainerName), 'owned container cleanup failed');
  for (const [kind, expectedName] of [
    ['network', `${owned.project}_default`],
    ['volume', `${owned.project}_postgres-data`]
  ] as const) {
    const projectNames = docker.capture([
      kind,
      'ls',
      '--filter',
      `label=com.docker.compose.project=${owned.project}`,
      '--format',
      '{{.Name}}'
    ]).split(/\r?\n/u).filter(Boolean);
    const exactNames = docker.capture([
      kind,
      'ls',
      '--filter',
      `name=${expectedName}`,
      '--format',
      '{{.Name}}'
    ]).split(/\r?\n/u).filter(Boolean);
    assert(
      projectNames.length === 0 && !exactNames.includes(expectedName),
      `owned ${kind} cleanup failed`
    );
  }
}

async function writeManifest(owned: OwnedRunManifest): Promise<void> {
  await writeFile(owned.manifestFile, `${JSON.stringify(owned, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

async function readManifest(path: string): Promise<OwnedRunManifest | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as OwnedRunManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const defaultOwnedManifestDependencies: OwnedManifestDependencies = {
  selectPort: selectEphemeralLoopbackPort,
  writeTextFile: async (path, contents) => {
    await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  },
  removeTempDirectory: async (path) => {
    await rm(path, { recursive: true, force: false });
  }
};

export async function createOwnedManifest(
  dependencies: OwnedManifestDependencies = defaultOwnedManifestDependencies
): Promise<OwnedRunManifest> {
  const runId = randomBytes(8).toString('hex');
  let materializedDirectory: string | undefined;
  try {
    materializedDirectory = await mkdtemp(TEMP_PREFIX);
    const tempDirectory = validateGeneratedTempDirectory(materializedDirectory);
    const owned: OwnedRunManifest = {
      version: 1,
      runId,
      project: `${RUN_PREFIX}${runId}`,
      database: `${DATABASE_PREFIX}${runId}`,
      user: `${DATABASE_PREFIX}${runId}`,
      password: randomBytes(24).toString('hex'),
      ownershipToken: randomBytes(16).toString('hex'),
      host: '127.0.0.1',
      port: await dependencies.selectPort(),
      containerId: '',
      tempDirectory,
      composeFile: join(tempDirectory, COMPOSE_FILE_NAME),
      manifestFile: join(tempDirectory, MANIFEST_FILE_NAME)
    };
    validateContainerlessManifest(owned);
    await dependencies.writeTextFile(owned.composeFile, renderOwnedCompose(owned));
    await dependencies.writeTextFile(owned.manifestFile, `${JSON.stringify(owned, null, 2)}\n`);
    return owned;
  } catch {
    if (materializedDirectory !== undefined) {
      try {
        await dependencies.removeTempDirectory(
          validateGeneratedTempDirectory(materializedDirectory)
        );
      } catch {
        throw new Error('[plan6b-upgrade] owned setup cleanup failed');
      }
    }
    throw new Error('[plan6b-upgrade] could not materialize the owned upgrade database');
  }
}

async function selectEphemeralLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolveListen());
    });
    const address = server.address();
    assert(typeof address === 'object' && address !== null, 'could not select an ephemeral port');
    assert(address.address === '127.0.0.1' && address.port !== 5432, 'selected endpoint is not a safe ephemeral loopback port');
    return address.port;
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
}

export async function startOwnedDatabase(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime = dockerCommandRuntime
): Promise<void> {
  assertNoExactComposeResourceCollision(owned, docker);
  let startupError: unknown;
  try {
    docker.run([...composeArguments(owned), 'up', '--detach']);
  } catch (error) {
    startupError = error;
  }
  let observed: OwnedRuntimeObservation;
  try {
    observed = inspectOwnedRuntime(owned, docker, { allowUnbound: true });
  } catch (inspectionError) {
    if (startupError) throw startupError;
    throw inspectionError;
  }
  owned.containerId = observed.containerId;
  await writeManifest(owned);
  if (observed.host === null || observed.port === null) {
    validateOwnedStartupCleanup(owned, observed);
  } else validateOwnedCleanup(owned, observed);
  if (startupError) throw startupError;
  docker.run([
    ...composeArguments(owned),
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '90'
  ]);
  validateOwnedCleanup(owned, inspectOwnedRuntime(owned, docker));
}

async function prepareLegacyMigrationFolder(owned: OwnedRunManifest): Promise<string> {
  const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const sourceFolder = join(repositoryRoot, 'drizzle');
  const migrationFolder = join(owned.tempDirectory, 'legacy-migrations');
  const metadataFolder = join(migrationFolder, 'meta');
  await mkdir(metadataFolder, { recursive: true });
  for (const tag of LEGACY_MIGRATION_TAGS) {
    await copyFile(join(sourceFolder, `${tag}.sql`), join(migrationFolder, `${tag}.sql`));
  }
  const journal = JSON.parse(
    await readFile(join(sourceFolder, 'meta', '_journal.json'), 'utf8')
  ) as MigrationJournal;
  const legacyEntries = journal.entries.filter((entry) => entry.idx <= 6);
  assert(
    legacyEntries.length === LEGACY_MIGRATION_TAGS.length &&
      legacyEntries.every((entry, index) => entry.tag === LEGACY_MIGRATION_TAGS[index]),
    'migration journal does not contain the exact 0000-0006 history'
  );
  await writeFile(
    join(metadataFolder, '_journal.json'),
    `${JSON.stringify({ ...journal, entries: legacyEntries }, null, 2)}\n`,
    'utf8'
  );
  return migrationFolder;
}

async function applyLegacyMigrations(owned: OwnedRunManifest): Promise<void> {
  const migrationsFolder = await prepareLegacyMigrationFolder(owned);
  const pool = new Pool({
    host: owned.host,
    port: owned.port,
    database: owned.database,
    user: owned.user,
    password: owned.password,
    max: 1,
    connectionTimeoutMillis: 5_000
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

function childEnvironment(owned: OwnedRunManifest): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...withoutStripeProviderSecrets(process.env),
    APP_ENV: 'test',
    APPLICATION_MODE: 'prototype',
    DATABASE_HOST: owned.host,
    DATABASE_PORT: String(owned.port),
    DATABASE_NAME: owned.database,
    DATABASE_USER: owned.user,
    DATABASE_PASSWORD: owned.password,
    DATABASE_POOL_MAX: '2',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_STATEMENT_TIMEOUT_MS: '30000',
    DATABASE_READINESS_TIMEOUT_MS: '2000',
    STRIPE_ENABLED: 'false',
    STRIPE_TEST_FIXTURE_MODE: 'false',
    STRIPE_LIVE_MODE: 'false',
    STRIPE_AUTOMATIC_TAX_ENABLED: 'false',
    PLAN6B_UPGRADE_PHASE: 'legacy',
    PLAN6B_UPGRADE_RUN_ID: owned.runId,
    PLAN6B_UPGRADE_OWNED_DATABASE: 'true',
    PLAN6B_UPGRADE_MANIFEST: owned.manifestFile,
    PLAN6B_UPGRADE_MIGRATION_0007: resolve('drizzle', MIGRATION_0007_FILE_NAME)
  };
  delete environment.DATABASE_URL;
  return environment;
}

async function runChildCommand(
  owned: OwnedRunManifest,
  command: string,
  commandArguments: string[]
): Promise<void> {
  runChecked(command, commandArguments, childEnvironment(owned));
}

export async function cleanupOwnedDatabase(
  owned: OwnedRunManifest,
  docker: DockerCommandRuntime = dockerCommandRuntime
): Promise<void> {
  const persisted = await readManifest(owned.manifestFile);
  assert(
    persisted && JSON.stringify(persisted) === JSON.stringify(owned),
    'owned-run manifest changed after startup validation'
  );
  const containerIds = listOwnedContainerIds(owned, docker);
  assert(containerIds.length <= 1, 'expected at most one owned PostgreSQL container');
  if (containerIds.length === 0) {
    validateOwnedContainerlessResources(persisted, docker);
  } else {
    const observed = inspectOwnedRuntime(owned, docker, { allowUnbound: true });
    if (observed.host === null || observed.port === null) {
      validateOwnedStartupCleanup(persisted, observed);
    }
    else validateOwnedCleanup(persisted, observed);
  }
  docker.run([
    ...composeArguments(owned),
    'down',
    '--volumes'
  ]);
  assertNoOwnedComposeResourcesRemain(owned, docker);
  await rm(owned.tempDirectory, { recursive: true, force: false });
}

function parsePhaseCommand(argumentsToParse: string[]): CommandInvocation {
  const marker = argumentsToParse.indexOf('--phase-command');
  assert(marker === 0, 'expected --phase-command followed by the legacy-phase child command');
  const command = argumentsToParse[1];
  assert(command, 'expected a command after --phase-command');
  return { command, arguments: argumentsToParse.slice(2) };
}

async function main(): Promise<void> {
  const child = parsePhaseCommand(process.argv.slice(2));
  const owned = await createOwnedManifest();
  console.info(`[plan6b-upgrade] starting isolated project ${owned.project}`);
  await executeOwnedUpgradeRun(owned, {
    start: startOwnedDatabase,
    applyLegacyMigrations,
    runChild: (manifest) => runChildCommand(manifest, child.command, child.arguments),
    cleanup: cleanupOwnedDatabase
  });
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '[plan6b-upgrade] unknown failure');
    process.exitCode = 1;
  });
}
