import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEPLOYMENT_BACKUP_ARTIFACTS,
  hashDeploymentBackupArtifact,
  sealDeploymentBackupBundle,
  verifyDeploymentBackupBundle
} from './deployment-backup-bundle';
import type {
  StorageArchiveClass,
  StorageArchiveManifest
} from '../src/storage-volume-backup-helper';
import { readStorageArchiveManifest } from '../src/storage-volume-backup-helper';
import { classifyLegacyStoragePath } from '../src/storage-volume-migration-helper';
import {
  executeSplitStorageBackup,
  type SplitStorageBackupRuntime
} from './split-storage-backup';

export class DeploymentCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentCheckpointError';
  }
}

export interface StorageReference {
  readonly storageClass: StorageArchiveClass;
  readonly referenceKind: string;
  readonly storageKey: string;
  readonly checksumSha256: string;
  readonly byteSize: number;
}

type StorageManifests = Readonly<Record<StorageArchiveClass, StorageArchiveManifest>>;

const inventoryHeader =
  'storage_class,reference_kind,storage_key,checksum_sha256,byte_size';
const digestPattern = /^[a-f0-9]{64}$/u;
const pinnedImagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const referenceClasses = new Map<string, StorageArchiveClass>([
  ['title_cover', 'covers'],
  ['revision_staging', 'staging'],
  ['revision_original', 'publication'],
  ['prose_image', 'publication'],
  ['comic_page', 'publication'],
  ['revision_cover_suggestion', 'publication']
]);

function fail(message: string): never {
  throw new DeploymentCheckpointError(message);
}

function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });
}

export function parseStorageReferenceInventory(value: string): StorageReference[] {
  if (value.includes('\r')) fail('Storage reference inventory is not canonical LF text');
  const lines = value.split('\n');
  if (lines.at(-1) !== '') fail('Storage reference inventory must end with one newline');
  lines.pop();
  if (lines.shift() !== inventoryHeader) fail('Storage reference inventory header is invalid');
  const references: StorageReference[] = [];
  const seen = new Set<string>();
  let previous = '';
  for (const line of lines) {
    const fields = line.split(',');
    if (fields.length !== 5) fail('Storage reference inventory row is invalid');
    const [storageClass, referenceKind, storageKey, checksumSha256, byteText] = fields;
    const expectedClass = referenceClasses.get(referenceKind!);
    const byteSize = Number(byteText);
    let routedClass: string | undefined;
    try {
      routedClass = classifyLegacyStoragePath(storageKey!, 'file');
    } catch {
      routedClass = undefined;
    }
    if (
      expectedClass !== storageClass ||
      routedClass !== storageClass ||
      !storageKey ||
      containsControlCharacter(storageKey) ||
      storageKey.startsWith('/') ||
      storageKey.includes('\\') ||
      storageKey.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
      !digestPattern.test(checksumSha256!) ||
      !/^[1-9][0-9]*$/u.test(byteText!) ||
      !Number.isSafeInteger(byteSize) ||
      seen.has(storageKey)
    ) fail('Storage reference inventory contains a noncanonical key or row');
    if (previous && rawCompare(previous, line) >= 0) {
      fail('Storage reference inventory ordering is not canonical');
    }
    seen.add(storageKey);
    previous = line;
    references.push({
      storageClass: storageClass as StorageArchiveClass,
      referenceKind: referenceKind!,
      storageKey,
      checksumSha256: checksumSha256!,
      byteSize
    });
  }
  return references;
}

export function assertStorageReferencesAuthenticated(
  references: readonly StorageReference[],
  manifests: StorageManifests
): void {
  const entries = new Map<StorageArchiveClass, Map<string, { bytes: number; sha256: string }>>();
  for (const storageClass of ['staging', 'publication', 'covers'] as const) {
    const manifest = manifests[storageClass];
    if (manifest.storageClass !== storageClass) fail('Storage manifest class mismatch');
    entries.set(storageClass, new Map(manifest.entries.map((entry) => [entry.key, entry])));
  }
  for (const reference of references) {
    const entry = entries.get(reference.storageClass)?.get(reference.storageKey);
    if (
      !entry ||
      entry.bytes !== reference.byteSize ||
      entry.sha256 !== reference.checksumSha256
    ) fail(`Database storage reference byte or digest mismatch in authenticated manifest: ${reference.referenceKind}`);
  }
}

interface RehearsalImages {
  readonly appImage: string;
  readonly postgresImage: string;
  readonly helperImage: string;
}

function generatedSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function createSyntheticRehearsalEnvironment(
  images: RehearsalImages,
  inherited: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  if (
    !pinnedImagePattern.test(images.appImage) ||
    !pinnedImagePattern.test(images.postgresImage) ||
    !pinnedImagePattern.test(images.helperImage)
  ) fail('Rehearsal images must be digest-pinned');
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (inherited[key]) environment[key] = inherited[key];
  }
  Object.assign(environment, {
    COMPOSE_DISABLE_ENV_FILE: '1',
    APP_IMAGE: images.appImage,
    POSTGRES_IMAGE: images.postgresImage,
    STORAGE_BACKUP_HELPER_IMAGE: images.helperImage,
    DATABASE_NAME: 'pale_orbit_rehearsal',
    DATABASE_OWNER_USER: 'pale_orbit_rehearsal_owner',
    DATABASE_OWNER_PASSWORD: generatedSecret(),
    DATABASE_USER: 'pale_orbit_rehearsal_web',
    DATABASE_PASSWORD: generatedSecret(),
    DATABASE_WORKER_USER: 'pale_orbit_rehearsal_worker',
    DATABASE_WORKER_PASSWORD: generatedSecret(),
    DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_rehearsal_cleanup',
    DATABASE_STORAGE_CLEANUP_PASSWORD: generatedSecret(),
    AUTH_SECRET: generatedSecret(48),
    ORIGIN: 'https://rehearsal.invalid',
    SITE_ADDRESS: 'localhost',
    HTTP_BIND_ADDRESS: '127.0.0.1',
    HTTPS_BIND_ADDRESS: '127.0.0.1',
    COMPOSE_DEFAULT_NETWORK_INTERNAL: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    SMTP_USER: 'rehearsal-disabled',
    SMTP_PASSWORD: generatedSecret(),
    SMTP_FROM: 'rehearsal-disabled@example.invalid',
    BOOTSTRAP_ADMIN_EMAIL: 'rehearsal-admin@example.invalid',
    BOOTSTRAP_ADMIN_NAME: 'Rehearsal Administrator',
    BOOTSTRAP_ADMIN_PASSWORD: generatedSecret()
  });
  return environment;
}

export interface SnapshotRuntime {
  beforeCopy?(source: string, target: string): Promise<void>;
}

async function stableCopy(source: string, target: string): Promise<void> {
  const pathBefore = await lstat(source, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size < 1n) {
    fail('Authenticated bundle source file is unsafe or empty');
  }
  const input = await open(source, 'r');
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await input.stat({ bigint: true });
    output = await open(target, 'wx', 0o600);
    let position = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      await output.write(buffer.subarray(0, bytesRead), 0, bytesRead, position);
      position += bytesRead;
    }
    await output.sync();
    const after = await input.stat({ bigint: true });
    const pathAfter = await lstat(source, { bigint: true });
    if (
      !after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      after.dev !== pathAfter.dev || after.ino !== pathAfter.ino ||
      after.size !== pathAfter.size || after.mtimeNs !== pathAfter.mtimeNs ||
      BigInt(position) !== after.size
    ) fail('Authenticated bundle source changed while snapshotting');
  } finally {
    await output?.close().catch(() => undefined);
    await input.close();
  }
}

export interface DeploymentBackupSnapshot {
  readonly root: string;
  dispose(): Promise<void>;
}

export async function snapshotDeploymentBackupBundle(
  sourceRoot: string,
  expectedBackupId: string,
  temporaryParent: string,
  runtime: SnapshotRuntime = {}
): Promise<DeploymentBackupSnapshot> {
  // This must remain the first bundle operation: authenticate the selected source before copying.
  const trustedManifest = await verifyDeploymentBackupBundle(sourceRoot, expectedBackupId);
  const parent = resolve(temporaryParent);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || resolve(await realpath(parent)) !== parent) {
    fail('Rehearsal snapshot parent must be a real canonical directory');
  }
  const snapshotRoot = await mkdtemp(join(parent, 'pale-orbit-checkpoint-'));
  await chmod(snapshotRoot, 0o700);
  try {
    for (const name of DEPLOYMENT_BACKUP_ARTIFACTS) {
      const source = join(resolve(sourceRoot), name);
      const target = join(snapshotRoot, name);
      await runtime.beforeCopy?.(source, target);
      await stableCopy(source, target);
      const copied = await hashDeploymentBackupArtifact(snapshotRoot, name);
      const trusted = trustedManifest.artifacts[name];
      if (copied.bytes !== trusted.bytes || copied.sha256 !== trusted.sha256) {
        fail(`Snapshot artifact digest or byte evidence changed after authentication: ${name}`);
      }
    }
    await writeFile(
      join(snapshotRoot, 'backup-bundle.json'),
      `${JSON.stringify(trustedManifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    await verifyDeploymentBackupBundle(snapshotRoot, expectedBackupId);
    let disposed = false;
    return {
      root: snapshotRoot,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(snapshotRoot, { recursive: true, force: true });
      }
    };
  } catch (cause: unknown) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw cause;
  }
}

const projectPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const contextPattern = /^[A-Za-z0-9_.-]{1,128}$/u;
const enginePattern = /^[A-Za-z0-9:_.-]{1,128}$/u;
const backupIdPattern = /^[a-f0-9]{32}$/u;
const usage = 'Usage: deployment:checkpoint -- capture --project <name> --root <absolute-path> --context <name> --engine-id <id> --backup-id <id> | rehearse --root <absolute-path> --context <name> --engine-id <id> --backup-id <id>';

export interface CaptureCheckpointOptions {
  readonly mode: 'capture';
  readonly project: string;
  readonly bundleRoot: string;
  readonly dockerContext: string;
  readonly expectedDockerEngineId: string;
  readonly backupId: string;
}

export interface RehearseCheckpointOptions {
  readonly mode: 'rehearse';
  readonly bundleRoot: string;
  readonly dockerContext: string;
  readonly expectedDockerEngineId: string;
  readonly backupId: string;
}

export type DeploymentCheckpointOptions = CaptureCheckpointOptions | RehearseCheckpointOptions;

export function parseDeploymentCheckpointArguments(
  argumentsToParse: readonly string[]
): DeploymentCheckpointOptions {
  const [mode, ...pairs] = argumentsToParse;
  if (mode !== 'capture' && mode !== 'rehearse') fail(usage);
  const allowed = mode === 'capture'
    ? ['--project', '--root', '--context', '--engine-id', '--backup-id']
    : ['--root', '--context', '--engine-id', '--backup-id'];
  if (pairs.length !== allowed.length * 2) fail(usage);
  const values = new Map<string, string>();
  for (let index = 0; index < pairs.length; index += 2) {
    const key = pairs[index];
    const value = pairs[index + 1];
    if (!key || !value || !allowed.includes(key) || values.has(key)) fail(usage);
    values.set(key, value);
  }
  if (values.size !== allowed.length) fail(usage);
  const common = {
    mode,
    bundleRoot: values.get('--root')!,
    dockerContext: values.get('--context')!,
    expectedDockerEngineId: values.get('--engine-id')!,
    backupId: values.get('--backup-id')!
  } as const;
  return mode === 'capture'
    ? { ...common, mode, project: values.get('--project')! }
    : { ...common, mode };
}

export interface CheckpointCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CheckpointCommandRuntime {
  capture(
    argumentsToRun: readonly string[],
    options: { readonly environment: NodeJS.ProcessEnv; readonly input?: string }
  ): Promise<CheckpointCommandResult>;
}

export interface DeploymentCheckpointDependencies {
  readonly sealBundle: typeof sealDeploymentBackupBundle;
  readonly verifyBundle: typeof verifyDeploymentBackupBundle;
}

const defaultCheckpointDependencies: DeploymentCheckpointDependencies = {
  sealBundle: sealDeploymentBackupBundle,
  verifyBundle: verifyDeploymentBackupBundle
};

interface ImageRecord {
  readonly APP_IMAGE: string;
  readonly POSTGRES_IMAGE: string;
  readonly BACKUP_HELPER_IMAGE: string;
  readonly RepoDigests: readonly string[];
}

interface EngineRecord {
  readonly docker_context: string;
  readonly docker_engine_id: string;
}

const storageClasses = ['staging', 'publication', 'covers'] as const;
const composeFile = resolve('compose.prod.yaml');

function validateCheckpointOptions(options: DeploymentCheckpointOptions): void {
  if (
    !isAbsolute(options.bundleRoot) ||
    !contextPattern.test(options.dockerContext) ||
    !enginePattern.test(options.expectedDockerEngineId) ||
    !backupIdPattern.test(options.backupId) ||
    (options.mode === 'capture' && !projectPattern.test(options.project))
  ) fail('Deployment checkpoint options are invalid; root must be absolute');
}

async function checked(
  runtime: CheckpointCommandRuntime,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  description: string,
  input?: string
): Promise<string> {
  const result = await runtime.capture(args, { environment, input });
  if (result.status !== 0) fail(description);
  return result.stdout;
}

function dockerArgs(context: string, args: readonly string[]): string[] {
  return ['--context', context, ...args];
}

function composeArgs(
  options: { dockerContext: string; project: string },
  args: readonly string[],
  envFile?: string
): string[] {
  return dockerArgs(options.dockerContext, [
    'compose',
    ...(envFile ? ['--env-file', envFile] : []),
    '--project-name', options.project,
    '--file', composeFile,
    ...args
  ]);
}

function parseObject(value: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    fail(description);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail(description);
  return parsed as Record<string, unknown>;
}

async function assertDockerEngine(
  runtime: CheckpointCommandRuntime,
  context: string,
  expectedId: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const engine = parseObject(await checked(runtime, dockerArgs(context, [
    'info', '--format', '{{json .}}'
  ]), environment, 'Could not inspect approved Docker engine'), 'Docker engine evidence is invalid');
  if (engine.ID !== expectedId) fail('Docker engine identity does not match the approved engine');
}

async function mutatingDocker(
  runtime: CheckpointCommandRuntime,
  context: string,
  expectedId: string,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
  description: string,
  input?: string
): Promise<string> {
  await assertDockerEngine(runtime, context, expectedId, environment);
  return checked(runtime, args, environment, description, input);
}

function canonicalOutput(value: string, header: string): string {
  const normalized = value.replace(/\r\n/gu, '\n');
  if (
    normalized.includes('\r') ||
    !normalized.startsWith(`${header}\n`) ||
    !normalized.endsWith('\n') ||
    normalized.endsWith('\n\n')
  ) fail(`Database evidence is not canonical: ${header}`);
  return normalized;
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) fail(`${name} is required for checkpoint capture`);
  return value;
}

async function assertEmptySafeRoot(configuredRoot: string): Promise<string> {
  const root = resolve(configuredRoot);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(await realpath(root)) !== root) {
    fail('Checkpoint capture root must be a real canonical directory');
  }
  if ((await readdir(root)).length !== 0) fail('Checkpoint capture root must be empty');
  return root;
}

function exactLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

async function assertCaptureQuiesced(
  runtime: CheckpointCommandRuntime,
  options: CaptureCheckpointOptions,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const consumers = await checked(runtime, composeArgs(options, [
    '--profile', 'tools', 'ps', '--all', '--quiet',
    'app', 'worker', 'storage-cleanup', 'migrate', 'database-role-provision', 'bootstrap-admin'
  ]), environment, 'Could not inspect checkpoint consumers');
  if (exactLines(consumers).length !== 0) {
    fail('Checkpoint database and storage consumers must be stopped and removed');
  }
  for (const storageClass of storageClasses) {
    const users = await checked(runtime, dockerArgs(options.dockerContext, [
      'container', 'ls', '--all', '--filter',
      `volume=${options.project}_book_${storageClass}`, '--format', '{{.ID}}'
    ]), environment, 'Could not inspect exact split-volume consumers');
    if (exactLines(users).length !== 0) fail('An exact split volume still has a container consumer');
  }
}

async function inspectPinnedImage(
  runtime: CheckpointCommandRuntime,
  context: string,
  image: string,
  environment: NodeJS.ProcessEnv
): Promise<Record<string, unknown>> {
  if (!pinnedImagePattern.test(image)) fail('Checkpoint image is not digest-pinned');
  const record = parseObject(await checked(runtime, dockerArgs(context, [
    'image', 'inspect', image, '--format', '{{json .}}'
  ]), environment, 'Pinned checkpoint image is unavailable'), 'Checkpoint image evidence is invalid');
  if (!Array.isArray(record.RepoDigests) || !record.RepoDigests.includes(image)) {
    fail('Checkpoint image digest does not match local image evidence');
  }
  return record;
}

function parseImageRecord(value: string): ImageRecord {
  const record = parseObject(value, 'Authenticated application image record is invalid');
  const keys = Object.keys(record).sort(rawCompare);
  if (
    JSON.stringify(keys) !== JSON.stringify([
      'APP_IMAGE', 'BACKUP_HELPER_IMAGE', 'POSTGRES_IMAGE', 'RepoDigests'
    ].sort(rawCompare)) ||
    typeof record.APP_IMAGE !== 'string' || !pinnedImagePattern.test(record.APP_IMAGE) ||
    typeof record.POSTGRES_IMAGE !== 'string' || !pinnedImagePattern.test(record.POSTGRES_IMAGE) ||
    typeof record.BACKUP_HELPER_IMAGE !== 'string' ||
      !pinnedImagePattern.test(record.BACKUP_HELPER_IMAGE) ||
    !Array.isArray(record.RepoDigests) ||
    record.RepoDigests.some((entry) => typeof entry !== 'string' || !pinnedImagePattern.test(entry)) ||
    !record.RepoDigests.includes(record.APP_IMAGE)
  ) fail('Authenticated application image record is invalid');
  return record as unknown as ImageRecord;
}

function parseEngineRecord(value: string): EngineRecord {
  const record = parseObject(value, 'Authenticated source Docker engine record is invalid');
  if (
    JSON.stringify(Object.keys(record).sort(rawCompare)) !==
      JSON.stringify(['docker_context', 'docker_engine_id']) ||
    typeof record.docker_context !== 'string' || !contextPattern.test(record.docker_context) ||
    typeof record.docker_engine_id !== 'string' || !enginePattern.test(record.docker_engine_id)
  ) fail('Authenticated source Docker engine record is invalid');
  return record as unknown as EngineRecord;
}

async function storageManifests(root: string): Promise<StorageManifests> {
  const [staging, publication, covers] = await Promise.all([
    readStorageArchiveManifest(root, 'staging'),
    readStorageArchiveManifest(root, 'publication'),
    readStorageArchiveManifest(root, 'covers')
  ]);
  return { staging, publication, covers };
}

function splitRuntime(
  runtime: CheckpointCommandRuntime,
  environment: NodeJS.ProcessEnv
): SplitStorageBackupRuntime {
  return {
    async capture(argumentsToRun) {
      return runtime.capture(argumentsToRun, { environment });
    }
  };
}

async function captureDatabaseEvidence(
  options: CaptureCheckpointOptions,
  runtime: CheckpointCommandRuntime,
  environment: NodeJS.ProcessEnv,
  root: string
): Promise<void> {
  const owner = requiredEnvironment(environment, 'DATABASE_OWNER_USER');
  const database = requiredEnvironment(environment, 'DATABASE_NAME');
  const postgres = exactLines(await checked(runtime, composeArgs(options, [
    'ps', '--quiet', 'postgres'
  ]), environment, 'Could not locate production PostgreSQL container'));
  if (postgres.length !== 1) fail('Expected exactly one production PostgreSQL container');
  const postgresImage = requiredEnvironment(environment, 'POSTGRES_IMAGE');
  const pinnedPostgres = await inspectPinnedImage(
    runtime, options.dockerContext, postgresImage, environment
  );
  const postgresContainer = parseObject(await checked(runtime, dockerArgs(options.dockerContext, [
    'container', 'inspect', postgres[0]!, '--format', '{{json .}}'
  ]), environment, 'Could not inspect production PostgreSQL container'),
  'Production PostgreSQL container evidence is invalid');
  const postgresConfig = postgresContainer.Config;
  if (typeof postgresConfig !== 'object' || postgresConfig === null || Array.isArray(postgresConfig)) {
    fail('Production PostgreSQL container configuration is invalid');
  }
  const postgresLabels = (postgresConfig as Record<string, unknown>).Labels;
  if (
    typeof postgresLabels !== 'object' || postgresLabels === null || Array.isArray(postgresLabels) ||
    postgresContainer.Name !== `/${options.project}-postgres-1` ||
    postgresContainer.Image !== pinnedPostgres.Id ||
    (postgresConfig as Record<string, unknown>).Image !== postgresImage ||
    (postgresLabels as Record<string, unknown>)['com.docker.compose.project'] !== options.project ||
    (postgresLabels as Record<string, unknown>)['com.docker.compose.service'] !== 'postgres'
  ) fail('Production PostgreSQL container is not bound to the approved pinned image and project');
  const remoteDump = `/tmp/pale-orbit-checkpoint-${options.backupId}.dump`;
  let remoteDumpCreated = false;
  try {
    remoteDumpCreated = true;
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(options, [
        'exec', '-T', 'postgres', 'pg_dump', '-U', owner, '-d', database,
        '--format=custom', `--file=${remoteDump}`
      ]), 'Could not create checkpoint database dump');
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, dockerArgs(options.dockerContext, [
        'cp', `${postgres[0]}:${remoteDump}`, join(root, 'database.dump')
      ]), 'Could not copy checkpoint database dump');
  } finally {
    if (remoteDumpCreated) {
      await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
        environment, composeArgs(options, [
          'exec', '-T', 'postgres', 'rm', '-f', remoteDump
        ]), 'Could not remove checkpoint database dump copy');
    }
  }

  const psql = ['exec', '-T', 'postgres', 'psql', '-X', '--no-psqlrc',
    '--set', 'ON_ERROR_STOP=1', '--quiet', '-U', owner, '-d', database];
  const journal = canonicalOutput(await checked(runtime, composeArgs(options, [
    ...psql, '-c',
    'copy (select * from drizzle.__drizzle_migrations order by id) to stdout with (format csv, header true)'
  ]), environment, 'Could not capture migration journal'), 'id,hash,created_at');
  await writeExclusive(join(root, 'migration-journal.csv'), journal);

  const rowSql = await readFile('scripts/capture-restore-row-counts.sql', 'utf8');
  const rowCounts = canonicalOutput(await checked(runtime, composeArgs(options, psql), environment,
    'Could not capture restore row counts', rowSql), 'schema_name,table_name,row_count');
  await writeExclusive(join(root, 'restore-row-counts.csv'), rowCounts);

  const inventorySql = await readFile('scripts/capture-storage-reference-inventory.sql', 'utf8');
  const inventory = canonicalOutput(await checked(runtime, composeArgs(options, psql), environment,
    'Could not capture storage reference inventory', inventorySql), inventoryHeader);
  parseStorageReferenceInventory(inventory);
  await writeExclusive(join(root, 'storage-samples.csv'), inventory);

  const verifier = await readFile('scripts/verify-financial-restore.sql', 'utf8');
  await writeExclusive(join(root, 'verify-financial-restore.sql'), verifier);
  const diagnostics = canonicalOutput(await checked(runtime, composeArgs(options, [
    ...psql, '--csv'
  ]), environment, 'Source financial restore verification failed', verifier),
  'check_name,violation_count');
  await writeExclusive(join(root, 'financial-operational-diagnostics.csv'), diagnostics);
}

async function captureImageEvidence(
  options: CaptureCheckpointOptions,
  runtime: CheckpointCommandRuntime,
  environment: NodeJS.ProcessEnv,
  root: string
): Promise<{ appImage: string; postgresImage: string; helperImage: string }> {
  const appImage = requiredEnvironment(environment, 'APP_IMAGE');
  const postgresImage = requiredEnvironment(environment, 'POSTGRES_IMAGE');
  const helperImage = requiredEnvironment(environment, 'STORAGE_BACKUP_HELPER_IMAGE');
  const app = await inspectPinnedImage(runtime, options.dockerContext, appImage, environment);
  await inspectPinnedImage(runtime, options.dockerContext, postgresImage, environment);
  await inspectPinnedImage(runtime, options.dockerContext, helperImage, environment);
  const repoDigests = app.RepoDigests as string[];
  const record: ImageRecord = {
    APP_IMAGE: appImage,
    POSTGRES_IMAGE: postgresImage,
    BACKUP_HELPER_IMAGE: helperImage,
    RepoDigests: [...repoDigests].sort(rawCompare)
  };
  await writeExclusive(join(root, 'application-image.json'), `${JSON.stringify(record)}\n`);
  const engine: EngineRecord = {
    docker_context: options.dockerContext,
    docker_engine_id: options.expectedDockerEngineId
  };
  await writeExclusive(join(root, 'source-docker-engine.json'), `${JSON.stringify(engine)}\n`);
  return { appImage, postgresImage, helperImage };
}

async function captureCheckpoint(
  options: CaptureCheckpointOptions,
  runtime: CheckpointCommandRuntime,
  environment: NodeJS.ProcessEnv,
  dependencies: DeploymentCheckpointDependencies
): Promise<{ project: string; backupId: string }> {
  const root = await assertEmptySafeRoot(options.bundleRoot);
  let sealed = false;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await assertDockerEngine(runtime, options.dockerContext,
      options.expectedDockerEngineId, environment);
    await assertCaptureQuiesced(runtime, options, environment);
    await captureDatabaseEvidence(options, runtime, environment, root);
    const images = await captureImageEvidence(options, runtime, environment, root);
    await executeSplitStorageBackup({
      mode: 'capture', project: options.project, helperImage: images.helperImage,
      dockerContext: options.dockerContext,
      expectedDockerEngineId: options.expectedDockerEngineId,
      bundleRoot: root, checkpointOwnerToken: options.backupId
    }, splitRuntime(runtime, environment));
    await cleanupCheckpointHelpers(runtime, {
      dockerContext: options.dockerContext,
      expectedDockerEngineId: options.expectedDockerEngineId,
      project: options.project
    }, environment, options.backupId);
    const references = parseStorageReferenceInventory(
      await readFile(join(root, 'storage-samples.csv'), 'utf8')
    );
    assertStorageReferencesAuthenticated(references, await storageManifests(root));
    await assertCaptureQuiesced(runtime, options, environment);
    await dependencies.sealBundle(root, options.backupId);
    sealed = true;
    await dependencies.verifyBundle(root, options.backupId);
    return { project: options.project, backupId: options.backupId };
  } catch (cause: unknown) {
    primaryFailure = cause;
    try {
      await cleanupCheckpointHelpers(runtime, {
        dockerContext: options.dockerContext,
        expectedDockerEngineId: options.expectedDockerEngineId,
        project: options.project
      }, environment, options.backupId);
    } catch (cleanupCause: unknown) {
      cleanupFailures.push(cleanupCause);
    }
    if (sealed) {
      try {
        await rm(join(root, 'backup-bundle.json'));
      } catch (cleanupCause: unknown) {
        cleanupFailures.push(cleanupCause);
      }
    }
    if (cleanupFailures.length) {
      throw new AggregateError([primaryFailure, ...cleanupFailures],
        'Deployment checkpoint capture cleanup failed', { cause });
    }
    throw cause;
  }
}

function resourceExactNames(project: string): {
  containers: readonly string[];
  networks: readonly string[];
  volumes: readonly string[];
} {
  return {
    containers: [
      'app', 'worker', 'migrate', 'database-role-provision', 'bootstrap-admin',
      'storage-cleanup', 'postgres', 'caddy'
    ].map((service) => `${project}-${service}-1`),
    networks: [`${project}_default`],
    volumes: [
      'postgres_data', 'book_staging', 'book_publication', 'book_covers',
      'caddy_data', 'caddy_config'
    ].map((volume) => `${project}_${volume}`)
  };
}

async function listedNames(
  runtime: CheckpointCommandRuntime,
  context: string,
  environment: NodeJS.ProcessEnv,
  kind: 'container' | 'network' | 'volume'
): Promise<string[]> {
  return exactLines(await checked(runtime, dockerArgs(context, [
    kind, 'ls', ...(kind === 'container' ? ['--all'] : []), '--format',
    kind === 'container' ? '{{.Names}}' : '{{.Name}}'
  ]), environment, `Could not inventory Docker ${kind}s`));
}

export function checkpointResourceIdentifierFormat(
  kind: 'container' | 'network' | 'volume'
): '{{.ID}}' | '{{.Name}}' {
  return kind === 'volume' ? '{{.Name}}' : '{{.ID}}';
}

async function labeledIds(
  runtime: CheckpointCommandRuntime,
  context: string,
  environment: NodeJS.ProcessEnv,
  kind: 'container' | 'network' | 'volume',
  label: string
): Promise<string[]> {
  return exactLines(await checked(runtime, dockerArgs(context, [
    kind, 'ls', ...(kind === 'container' ? ['--all'] : []),
    '--filter', `label=${label}`, '--format', checkpointResourceIdentifierFormat(kind)
  ]), environment, `Could not inventory labeled Docker ${kind}s`));
}

async function assertProjectAbsent(
  runtime: CheckpointCommandRuntime,
  options: { dockerContext: string; project: string },
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const exact = resourceExactNames(options.project);
  for (const kind of ['container', 'network', 'volume'] as const) {
    const [names, labeled] = await Promise.all([
      listedNames(runtime, options.dockerContext, environment, kind),
      labeledIds(runtime, options.dockerContext, environment, kind,
        `com.docker.compose.project=${options.project}`)
    ]);
    const expected = kind === 'container' ? exact.containers :
      kind === 'network' ? exact.networks : exact.volumes;
    if (labeled.length !== 0 || names.some((name) => expected.includes(name))) {
      fail('Generated rehearsal project is not absent');
    }
  }
}

async function cleanupCheckpointHelpers(
  runtime: CheckpointCommandRuntime,
  options: { dockerContext: string; expectedDockerEngineId: string; project: string },
  environment: NodeJS.ProcessEnv,
  ownerToken: string
): Promise<void> {
  const label = `io.pale-orbit.deployment-checkpoint=${ownerToken}`;
  const ids = await labeledIds(runtime, options.dockerContext, environment, 'container', label);
  for (const id of ids) {
    const inspected = parseObject(await checked(runtime, dockerArgs(options.dockerContext, [
      'container', 'inspect', id, '--format', '{{json .Config.Labels}}'
    ]), environment, 'Could not inspect checkpoint helper ownership'),
    'Checkpoint helper ownership evidence is invalid');
    if (
      inspected['io.pale-orbit.deployment-checkpoint'] !== ownerToken ||
      inspected['com.docker.compose.project'] !== options.project ||
      inspected['com.docker.compose.service'] !== 'deployment-checkpoint-storage'
    ) fail('Refusing to clean up a foreign checkpoint helper');
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, dockerArgs(options.dockerContext, ['container', 'rm', '--force', id]),
      'Could not remove owned checkpoint helper');
  }
  if ((await labeledIds(runtime, options.dockerContext, environment, 'container', label)).length) {
    fail('Owned checkpoint helper cleanup is incomplete');
  }
}

async function writeSyntheticEnvFile(path: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const excluded = new Set([
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'COMPOSE_DISABLE_ENV_FILE', 'STORAGE_BACKUP_HELPER_IMAGE'
  ]);
  const lines = Object.entries(environment)
    .filter(([key, value]) => !excluded.has(key) && value !== undefined)
    .sort(([left], [right]) => rawCompare(left, right))
    .map(([key, value]) => `${key}=${value}`);
  await writeFile(path, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function compareDatabaseEvidence(
  runtime: CheckpointCommandRuntime,
  options: { dockerContext: string; project: string },
  environment: NodeJS.ProcessEnv,
  envFile: string,
  snapshotRoot: string
): Promise<void> {
  const owner = requiredEnvironment(environment, 'DATABASE_OWNER_USER');
  const database = requiredEnvironment(environment, 'DATABASE_NAME');
  const psql = ['exec', '-T', 'postgres', 'psql', '-X', '--no-psqlrc',
    '--set', 'ON_ERROR_STOP=1', '--quiet', '-U', owner, '-d', database];
  const journal = canonicalOutput(await checked(runtime, composeArgs(options, [
    ...psql, '-c',
    'copy (select * from drizzle.__drizzle_migrations order by id) to stdout with (format csv, header true)'
  ], envFile), environment, 'Could not verify restored migration journal'), 'id,hash,created_at');
  if (journal !== await readFile(join(snapshotRoot, 'migration-journal.csv'), 'utf8')) {
    fail('Restored migration journal mismatch');
  }
  const rowSql = await readFile('scripts/capture-restore-row-counts.sql', 'utf8');
  const rows = canonicalOutput(await checked(runtime, composeArgs(options, psql, envFile),
    environment, 'Could not verify restored row counts', rowSql),
  'schema_name,table_name,row_count');
  if (rows !== await readFile(join(snapshotRoot, 'restore-row-counts.csv'), 'utf8')) {
    fail('Restored row-count inventory mismatch');
  }
  const inventorySql = await readFile('scripts/capture-storage-reference-inventory.sql', 'utf8');
  const inventory = canonicalOutput(await checked(runtime, composeArgs(options, psql, envFile),
    environment, 'Could not verify restored storage reference inventory', inventorySql),
  inventoryHeader);
  if (inventory !== await readFile(join(snapshotRoot, 'storage-samples.csv'), 'utf8')) {
    fail('Restored storage reference inventory mismatch');
  }
  const verifier = await readFile(join(snapshotRoot, 'verify-financial-restore.sql'), 'utf8');
  const diagnostics = canonicalOutput(await checked(runtime, composeArgs(options, [
    ...psql, '--csv'
  ], envFile), environment, 'Restored financial verification failed', verifier),
  'check_name,violation_count');
  if (diagnostics !== await readFile(
    join(snapshotRoot, 'financial-operational-diagnostics.csv'), 'utf8'
  )) fail('Restored financial operational diagnostics mismatch');
}

async function rehearseCheckpoint(
  options: RehearseCheckpointOptions,
  runtime: CheckpointCommandRuntime,
  inherited: NodeJS.ProcessEnv
): Promise<{ project: string; backupId: string }> {
  const workspace = await mkdtemp(join(resolve(tmpdir()), 'pale-orbit-rehearsal-workspace-'));
  await chmod(workspace, 0o700);
  let snapshot: DeploymentBackupSnapshot | undefined;
  let primaryFailure: unknown;
  let failed = false;
  let projectStarted = false;
  let rehearsalDumpCreated = false;
  let result: { project: string; backupId: string } | undefined;
  const cleanupFailures: unknown[] = [];
  const ownerToken = randomBytes(16).toString('hex');
  const project = `pale-orbit-restore-${randomBytes(16).toString('hex')}`;
  let environment: NodeJS.ProcessEnv | undefined;
  const envFile = join(workspace, 'synthetic.env');
  try {
    snapshot = await snapshotDeploymentBackupBundle(
      options.bundleRoot, options.backupId, workspace
    );
    const [imageRecord, sourceEngine, inventoryText, manifests] = await Promise.all([
      readFile(join(snapshot.root, 'application-image.json'), 'utf8').then(parseImageRecord),
      readFile(join(snapshot.root, 'source-docker-engine.json'), 'utf8').then(parseEngineRecord),
      readFile(join(snapshot.root, 'storage-samples.csv'), 'utf8'),
      storageManifests(snapshot.root)
    ]);
    const references = parseStorageReferenceInventory(inventoryText);
    assertStorageReferencesAuthenticated(references, manifests);
    if (sourceEngine.docker_engine_id === options.expectedDockerEngineId) {
      fail('Restore rehearsal Docker engine must differ from the authenticated source engine');
    }
    environment = createSyntheticRehearsalEnvironment({
      appImage: imageRecord.APP_IMAGE,
      postgresImage: imageRecord.POSTGRES_IMAGE,
      helperImage: imageRecord.BACKUP_HELPER_IMAGE
    }, inherited);
    await writeSyntheticEnvFile(envFile, environment);
    await assertDockerEngine(runtime, options.dockerContext,
      options.expectedDockerEngineId, environment);
    await inspectPinnedImage(runtime, options.dockerContext, imageRecord.APP_IMAGE, environment);
    await inspectPinnedImage(runtime, options.dockerContext, imageRecord.POSTGRES_IMAGE, environment);
    const helper = await inspectPinnedImage(
      runtime, options.dockerContext, imageRecord.BACKUP_HELPER_IMAGE, environment
    );
    const helperConfig = helper.Config;
    if (
      typeof helperConfig !== 'object' || helperConfig === null || Array.isArray(helperConfig) ||
      (helperConfig as Record<string, unknown>).User !== 'node'
    ) fail('Authenticated backup helper is not the audited non-root image');
    const rehearsal = {
      dockerContext: options.dockerContext,
      expectedDockerEngineId: options.expectedDockerEngineId,
      project
    };
    await assertProjectAbsent(runtime, rehearsal, environment);
    projectStarted = true;
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(rehearsal, ['up', '--detach', '--wait', 'postgres'], envFile),
      'Could not start isolated rehearsal PostgreSQL');
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(rehearsal, [
        '--profile', 'tools', 'run', '--rm', 'migrate'
      ], envFile), 'Pre-restore migration failed');
    const postgres = exactLines(await checked(runtime, composeArgs(rehearsal, [
      'ps', '--quiet', 'postgres'
    ], envFile), environment, 'Could not locate rehearsal PostgreSQL container'));
    if (postgres.length !== 1) fail('Expected exactly one rehearsal PostgreSQL container');
    rehearsalDumpCreated = true;
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, dockerArgs(options.dockerContext, [
        'cp', join(snapshot.root, 'database.dump'), `${postgres[0]}:/tmp/database.dump`
      ]), 'Could not copy authenticated database dump into rehearsal');
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(rehearsal, [
        'exec', '-T', 'postgres', 'pg_restore', '-U', environment.DATABASE_OWNER_USER!,
        '-d', environment.DATABASE_NAME!, '--clean', '--if-exists',
        '--no-owner', '/tmp/database.dump'
      ], envFile), 'Could not restore authenticated database dump');
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(rehearsal, [
        '--profile', 'tools', 'run', '--rm', 'migrate'
      ], envFile), 'Post-restore migration failed');
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(rehearsal, [
        '--profile', 'tools', 'run', '--rm', 'database-role-provision'
      ], envFile), 'Rehearsal database role provision failed');
    await executeSplitStorageBackup({
      mode: 'restore', project, helperImage: imageRecord.BACKUP_HELPER_IMAGE,
      dockerContext: options.dockerContext,
      expectedDockerEngineId: options.expectedDockerEngineId,
      bundleRoot: snapshot.root, checkpointOwnerToken: ownerToken
    }, splitRuntime(runtime, environment));
    await compareDatabaseEvidence(runtime, rehearsal, environment, envFile, snapshot.root);
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(rehearsal, [
        '--profile', 'tools', 'run', '--rm', 'storage-cleanup'
      ], envFile), 'Rehearsal storage-cleanup dry-run failed');
    await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
      environment, composeArgs(rehearsal, ['up', '--detach', '--wait', 'app'], envFile),
      'Could not start maintenance health service');
    await checked(runtime, composeArgs(rehearsal, [
      'exec', '-T', 'app', 'node', '-e',
      "Promise.all(['/health/live','/health/ready'].map((path)=>fetch('http://127.0.0.1:3000'+path).then((response)=>{if(!response.ok)throw new Error(path)}))).catch(()=>process.exit(1))"
    ], envFile), environment, 'Maintenance health verification failed');
    result = { project, backupId: options.backupId };
  } catch (cause: unknown) {
    failed = true;
    primaryFailure = cause;
  } finally {
    if (environment && projectStarted) {
      const rehearsal = {
        dockerContext: options.dockerContext,
        expectedDockerEngineId: options.expectedDockerEngineId,
        project
      };
      if (rehearsalDumpCreated) {
        try {
          await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
            environment, composeArgs(rehearsal, [
              'exec', '-T', 'postgres', 'rm', '-f', '/tmp/database.dump'
            ], envFile), 'Could not remove rehearsal database dump copy');
          rehearsalDumpCreated = false;
        } catch (cause: unknown) {
          cleanupFailures.push(cause);
        }
      }
      try {
        await cleanupCheckpointHelpers(runtime, rehearsal, environment, ownerToken);
      } catch (cause: unknown) {
        cleanupFailures.push(cause);
      }
      try {
        await mutatingDocker(runtime, options.dockerContext, options.expectedDockerEngineId,
          environment, composeArgs(rehearsal, [
            'down', '--volumes', '--remove-orphans'
          ], envFile),
          'Could not tear down exact rehearsal project');
      } catch (cause: unknown) {
        cleanupFailures.push(cause);
      }
      try {
        await assertProjectAbsent(runtime, rehearsal, environment);
      } catch (cause: unknown) {
        cleanupFailures.push(cause);
      }
    }
    try {
      await snapshot?.dispose();
      await rm(workspace, { recursive: true, force: true });
    } catch (cause: unknown) {
      cleanupFailures.push(cause);
    }
  }
  if (cleanupFailures.length) {
    throw new AggregateError(
      failed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
      'Deployment checkpoint rehearsal cleanup failed',
      failed ? { cause: primaryFailure } : undefined
    );
  }
  if (failed) throw primaryFailure;
  return result!;
}

export async function executeDeploymentCheckpoint(
  options: DeploymentCheckpointOptions,
  runtime: CheckpointCommandRuntime = createDockerCheckpointRuntime(),
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DeploymentCheckpointDependencies = defaultCheckpointDependencies
): Promise<{ project: string; backupId: string }> {
  validateCheckpointOptions(options);
  return options.mode === 'capture'
    ? captureCheckpoint(options, runtime, environment, dependencies)
    : rehearseCheckpoint(options, runtime, environment);
}

export function createDockerCheckpointRuntime(): CheckpointCommandRuntime {
  return {
    async capture(argumentsToRun, options) {
      const result = spawnSync('docker', [...argumentsToRun], {
        cwd: resolve('.'),
        env: options.environment,
        input: options.input,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
      };
    }
  };
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isMain) {
  executeDeploymentCheckpoint(parseDeploymentCheckpointArguments(process.argv.slice(2)))
    .then((result) => console.info(JSON.stringify({ version: 1, ...result })))
    .catch((cause: unknown) => {
      console.error('[deployment-checkpoint] failed', {
        name: cause instanceof Error ? cause.name : 'UnknownError'
      });
      process.exitCode = 1;
    });
}
