import { spawnSync } from 'node:child_process';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StorageVolumeMigrationManifest } from '../src/storage-volume-migration-helper';

export interface StorageMigrationCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface StorageMigrationCommandRuntime {
  capture(argumentsToRun: readonly string[]): Promise<StorageMigrationCommandResult>;
}

export interface StorageVolumeMigrationOptions {
  project: string;
  helperImage: string;
}

export interface StorageVolumeMigrationReportOptions extends StorageVolumeMigrationOptions {
  reportPath: string;
}

export class StorageVolumeMigrationPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageVolumeMigrationPreflightError';
  }
}

const projectPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const pinnedImagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function fail(message: string): never {
  throw new StorageVolumeMigrationPreflightError(message);
}

async function checked(
  runtime: StorageMigrationCommandRuntime,
  argumentsToRun: readonly string[],
  description: string
): Promise<string> {
  const result = await runtime.capture(argumentsToRun);
  if (result.status !== 0) fail(description);
  return result.stdout.trim();
}

function exactVolumeNames(project: string): Record<
  'legacy' | 'staging' | 'publication' | 'covers',
  string
> {
  return {
    legacy: `${project}_book_storage`,
    staging: `${project}_book_staging`,
    publication: `${project}_book_publication`,
    covers: `${project}_book_covers`
  };
}

async function assertRuntimeQuiesced(
  options: StorageVolumeMigrationOptions,
  runtime: StorageMigrationCommandRuntime
): Promise<void> {
  const running = await checked(runtime, [
    'compose',
    '--project-name',
    options.project,
    '--file',
    resolve('compose.prod.yaml'),
    '--profile',
    'tools',
    'ps',
    '--status',
    'running',
    '--services',
    'app',
    'worker',
    'storage-cleanup'
  ], 'Could not inspect application process state');
  if (running) {
    fail('Production app, worker, and storage cleanup must be stopped before storage migration');
  }
}

async function assertNoVolumeUsers(
  volumes: Record<'legacy' | 'staging' | 'publication' | 'covers', string>,
  runtime: StorageMigrationCommandRuntime
): Promise<void> {
  for (const exactName of Object.values(volumes)) {
    const users = await checked(runtime, [
      'container',
      'ls',
      '--all',
      '--filter',
      `volume=${exactName}`,
      '--format',
      '{{.ID}} {{.Names}}'
    ], `Could not inspect containers using exact storage volume ${exactName}`);
    if (users) fail(`Exact storage volume ${exactName} is mounted by a container`);
  }
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(description);
  return value as Record<string, unknown>;
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail(description);
  }
}

async function assertExactOwnedVolumes(
  options: StorageVolumeMigrationOptions,
  runtime: StorageMigrationCommandRuntime
): Promise<Record<'legacy' | 'staging' | 'publication' | 'covers', string>> {
  const volumes = exactVolumeNames(options.project);
  const inventory = (await checked(
    runtime,
    ['volume', 'ls', '--format', '{{.Name}}'],
    'Could not inventory Docker volumes'
  )).split(/\r?\n/u).filter(Boolean);
  const inspectOwnedVolume = async (logicalName: string, exactName: string): Promise<void> => {
    const inspected = record(parseJson(await checked(
      runtime,
      ['volume', 'inspect', exactName, '--format', '{{json .}}'],
      `Could not inspect volume ${exactName}`
    ), `Invalid volume evidence for ${exactName}`), `Invalid volume evidence for ${exactName}`);
    const labels = record(inspected.Labels, `Invalid labels for ${exactName}`);
    const expectedLogicalName = logicalName === 'legacy' ? 'book_storage' : `book_${logicalName}`;
    if (
      inspected.Name !== exactName ||
      labels['com.docker.compose.project'] !== options.project ||
      labels['com.docker.compose.volume'] !== expectedLogicalName
    ) {
      fail(`Refusing foreign volume ${exactName}`);
    }
  };
  for (const [logicalName, exactName] of Object.entries(volumes)) {
    const matches = inventory.filter((name) => name === exactName).length;
    if (matches > 1 || (logicalName === 'legacy' && matches !== 1)) {
      fail(`Required exact-name volume is missing or ambiguous: ${exactName}`);
    }
    if (matches === 1) await inspectOwnedVolume(logicalName, exactName);
  }
  for (const logicalName of ['staging', 'publication', 'covers'] as const) {
    const exactName = volumes[logicalName];
    if (inventory.includes(exactName)) continue;
    const composeVolumeName = `book_${logicalName}`;
    const created = await checked(runtime, [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${options.project}`,
      '--label',
      `com.docker.compose.volume=${composeVolumeName}`,
      '--name',
      exactName
    ], `Could not create exact-name volume ${exactName}`);
    if (created !== exactName) fail(`Docker did not return the requested exact-name volume ${exactName}`);
    await inspectOwnedVolume(logicalName, exactName);
  }
  return volumes;
}

async function assertPinnedLocalHelper(
  helperImage: string,
  runtime: StorageMigrationCommandRuntime
): Promise<void> {
  if (!pinnedImagePattern.test(helperImage)) fail('Storage migration helper must be digest-pinned');
  const inspected = record(parseJson(await checked(
    runtime,
    ['image', 'inspect', helperImage, '--format', '{{json .}}'],
    'Pinned storage migration helper is not present locally'
  ), 'Invalid storage migration helper evidence'), 'Invalid storage migration helper evidence');
  const config = record(inspected.Config, 'Invalid storage migration helper configuration');
  if (
    !Array.isArray(inspected.RepoDigests) ||
    !inspected.RepoDigests.includes(helperImage) ||
    config.User !== 'node'
  ) {
    fail('Pinned storage migration helper digest or node user does not match the local image');
  }
}

function helperArguments(
  options: StorageVolumeMigrationOptions,
  volumes: Record<'legacy' | 'staging' | 'publication' | 'covers', string>,
  mode: 'verify-empty' | 'migrate'
): string[] {
  return [
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '-e',
    `STORAGE_MIGRATION_MODE=${mode}`,
    '-e',
    'STORAGE_MIGRATION_LEGACY_ROOT=/legacy',
    '-e',
    'STORAGE_MIGRATION_STAGING_ROOT=/var/lib/pale-orbit/staging',
    '-e',
    'STORAGE_MIGRATION_PUBLICATION_ROOT=/var/lib/pale-orbit/publication',
    '-e',
    'STORAGE_MIGRATION_COVERS_ROOT=/var/lib/pale-orbit/covers',
    '-v',
    `${volumes.legacy}:/legacy:ro`,
    '-v',
    `${volumes.staging}:/var/lib/pale-orbit/staging`,
    '-v',
    `${volumes.publication}:/var/lib/pale-orbit/publication`,
    '-v',
    `${volumes.covers}:/var/lib/pale-orbit/covers`,
    options.helperImage,
    'node',
    'build/services/storage-volume-migration-helper.js'
  ];
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    [...expected].sort().every((key, index) => key === actual[index]);
}

function validateCountAndBytes(value: Record<string, unknown>): void {
  if (
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 0 ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0
  ) fail('Storage migration helper returned invalid count or byte evidence');
}

function validateManifest(value: unknown): StorageVolumeMigrationManifest {
  const manifest = record(value, 'Storage migration helper returned an invalid manifest');
  if (!exactKeys(manifest, ['version', 'classes', 'ignored']) || manifest.version !== 1) {
    fail('Storage migration helper returned an invalid manifest');
  }
  const classes = record(manifest.classes, 'Storage migration helper returned invalid classes');
  if (!exactKeys(classes, ['staging', 'publication', 'covers'])) {
    fail('Storage migration helper returned invalid classes');
  }
  for (const name of ['staging', 'publication', 'covers']) {
    const evidence = record(classes[name], `Storage migration helper omitted ${name}`);
    if (!exactKeys(evidence, [
      'count',
      'bytes',
      'sourceSha256',
      'destinationSha256',
      'verified'
    ])) fail(`Storage migration helper returned invalid ${name} evidence`);
    validateCountAndBytes(evidence);
    if (
      typeof evidence.sourceSha256 !== 'string' ||
      typeof evidence.destinationSha256 !== 'string' ||
      !digestPattern.test(evidence.sourceSha256) ||
      evidence.destinationSha256 !== evidence.sourceSha256 ||
      evidence.verified !== true
    ) fail(`Storage migration helper did not verify ${name}`);
  }
  const ignored = record(manifest.ignored, 'Storage migration helper returned invalid ignored evidence');
  if (!exactKeys(ignored, ['health', 'scratch'])) {
    fail('Storage migration helper returned invalid ignored evidence');
  }
  for (const name of ['health', 'scratch']) {
    const evidence = record(ignored[name], `Storage migration helper omitted ignored ${name}`);
    if (!exactKeys(evidence, ['count', 'bytes'])) {
      fail(`Storage migration helper returned invalid ignored ${name} evidence`);
    }
    validateCountAndBytes(evidence);
  }
  return manifest as unknown as StorageVolumeMigrationManifest;
}

export async function executeStorageVolumeMigration(
  options: StorageVolumeMigrationOptions,
  runtime: StorageMigrationCommandRuntime
): Promise<StorageVolumeMigrationManifest> {
  if (!projectPattern.test(options.project)) fail('Invalid Compose project name');
  if (!pinnedImagePattern.test(options.helperImage)) {
    fail('Storage migration helper must be digest-pinned');
  }
  await assertRuntimeQuiesced(options, runtime);
  await assertPinnedLocalHelper(options.helperImage, runtime);
  const volumes = await assertExactOwnedVolumes(options, runtime);
  await assertNoVolumeUsers(volumes, runtime);
  const emptyEvidence = record(parseJson(await checked(
    runtime,
    helperArguments(options, volumes, 'verify-empty'),
    'New storage volumes are not empty'
  ), 'Invalid empty-volume evidence'), 'Invalid empty-volume evidence');
  if (!exactKeys(emptyEvidence, ['version', 'empty']) ||
      emptyEvidence.version !== 1 || emptyEvidence.empty !== true) {
    fail('Invalid empty-volume evidence');
  }
  await assertRuntimeQuiesced(options, runtime);
  await assertNoVolumeUsers(volumes, runtime);
  const migrationOutput = await checked(
    runtime,
    helperArguments(options, volumes, 'migrate'),
    'Storage volume migration helper failed'
  );
  const manifestLine = migrationOutput.split(/\r?\n/u).filter(Boolean).at(-1);
  if (!manifestLine) fail('Storage migration helper returned no manifest');
  const manifest = validateManifest(parseJson(
    manifestLine,
    'Storage migration helper returned malformed JSON'
  ));
  await assertRuntimeQuiesced(options, runtime);
  return manifest;
}

export function parseStorageMigrationArguments(
  argumentsToParse: readonly string[]
): { project: string; reportPath: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsToParse.length; index += 2) {
    const name = argumentsToParse[index];
    const value = argumentsToParse[index + 1];
    if (
      (name !== '--project' && name !== '--report') ||
      !value ||
      values.has(name)
    ) fail('Usage: storage:migrate-volumes -- --project <name> --report <absolute-path>');
    values.set(name, value);
  }
  if (values.size !== 2) {
    fail('Usage: storage:migrate-volumes -- --project <name> --report <absolute-path>');
  }
  return {
    project: values.get('--project')!,
    reportPath: values.get('--report')!
  };
}

interface ReportReservation {
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
  device: bigint;
  inode: bigint;
}

async function reserveMigrationReport(reportPath: string): Promise<ReportReservation> {
  if (!isAbsolute(reportPath)) fail('Storage migration report path must be absolute');
  const requested = resolve(reportPath);
  const requestedParent = dirname(requested);
  try {
    const parent = await lstat(requestedParent);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      fail('Storage migration report parent must be a real directory');
    }
    const canonicalParent = await realpath(requestedParent);
    if (resolve(canonicalParent) !== requestedParent) {
      fail('Storage migration report parent must not traverse symbolic links');
    }
    const path = join(canonicalParent, basename(requested));
    const handle = await open(path, 'wx', 0o600);
    const created = await handle.stat({ bigint: true });
    return { path, handle, device: created.dev, inode: created.ino };
  } catch (cause: unknown) {
    if (cause instanceof StorageVolumeMigrationPreflightError) throw cause;
    fail('Could not reserve the exact storage migration report');
  }
}

async function reservationStillOwned(reservation: ReportReservation): Promise<boolean> {
  try {
    const value = await lstat(reservation.path, { bigint: true });
    return value.isFile() && !value.isSymbolicLink() &&
      value.dev === reservation.device && value.ino === reservation.inode;
  } catch {
    return false;
  }
}

export async function executeStorageVolumeMigrationWithReport(
  options: StorageVolumeMigrationReportOptions,
  runtime: StorageMigrationCommandRuntime
): Promise<StorageVolumeMigrationManifest> {
  if (!projectPattern.test(options.project)) fail('Invalid Compose project name');
  if (!pinnedImagePattern.test(options.helperImage)) {
    fail('Storage migration helper must be digest-pinned');
  }
  const reservation = await reserveMigrationReport(options.reportPath);
  let closed = false;
  try {
    const manifest = await executeStorageVolumeMigration(options, runtime);
    if (!await reservationStillOwned(reservation)) {
      fail('Storage migration report reservation changed during migration');
    }
    await reservation.handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await reservation.handle.sync();
    if (!await reservationStillOwned(reservation)) {
      fail('Storage migration report reservation changed during write');
    }
    await reservation.handle.close();
    closed = true;
    return manifest;
  } catch (cause: unknown) {
    if (!closed) await reservation.handle.close().catch(() => undefined);
    if (await reservationStillOwned(reservation)) {
      await rm(reservation.path, { force: true });
    }
    throw cause;
  }
}

export function createDockerStorageMigrationRuntime(): StorageMigrationCommandRuntime {
  return {
    async capture(argumentsToRun) {
      const result = spawnSync('docker', [...argumentsToRun], {
        cwd: resolve('.'),
        env: process.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
      };
    }
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isMain) {
  const command = parseStorageMigrationArguments(process.argv.slice(2));
  executeStorageVolumeMigrationWithReport({
    project: command.project,
    reportPath: command.reportPath,
    helperImage: requiredEnvironment('STORAGE_MIGRATION_HELPER_IMAGE')
  }, createDockerStorageMigrationRuntime()).then(() => {
    console.info('[storage-volume-migration] verified');
  }).catch((cause: unknown) => {
    console.error('[storage-volume-migration] failed', {
      name: cause instanceof Error ? cause.name : 'UnknownError'
    });
    process.exitCode = 1;
  });
}
