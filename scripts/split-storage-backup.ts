import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SplitStorageBackupMode = 'capture' | 'restore';
type StorageClass = 'staging' | 'publication' | 'covers';

export interface SplitStorageBackupResult {
  version: 1;
  storageClass: StorageClass;
  count: number;
  bytes: number;
  sha256: string;
}

export interface SplitStorageBackupOptions {
  mode: SplitStorageBackupMode;
  project: string;
  helperImage: string;
  dockerContext: string;
  expectedDockerEngineId: string;
  bundleRoot: string;
  checkpointOwnerToken?: string;
}

export interface SplitStorageBackupRuntime {
  capture(argumentsToRun: readonly string[]): Promise<{
    status: number;
    stdout: string;
    stderr: string;
  }>;
}

export class SplitStorageBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitStorageBackupError';
  }
}

const storageClasses = ['staging', 'publication', 'covers'] as const;
const projectPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const contextPattern = /^[A-Za-z0-9_.-]{1,128}$/u;
const enginePattern = /^[A-Za-z0-9:_.-]{1,128}$/u;
const pinnedImagePattern = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const checkpointOwnerTokenPattern = /^[a-f0-9]{32}$/u;

function fail(message: string): never {
  throw new SplitStorageBackupError(message);
}

function dockerArguments(options: SplitStorageBackupOptions, values: readonly string[]): string[] {
  return ['--context', options.dockerContext, ...values];
}

async function checked(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime,
  values: readonly string[],
  description: string
): Promise<string> {
  const result = await runtime.capture(dockerArguments(options, values));
  if (result.status !== 0) fail(description);
  return result.stdout.trim();
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail(description);
  }
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(description);
  return value as Record<string, unknown>;
}

async function safeBundleRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) fail('Split storage backup root must be absolute');
  const requested = resolve(path);
  try {
    const value = await lstat(requested);
    if (!value.isDirectory() || value.isSymbolicLink()) {
      fail('Split storage backup root must be a real directory');
    }
    const canonical = await realpath(requested);
    if (resolve(canonical) !== requested) {
      fail('Split storage backup root must not traverse symbolic links');
    }
    return canonical;
  } catch (cause: unknown) {
    if (cause instanceof SplitStorageBackupError) throw cause;
    fail('Split storage backup root is unavailable');
  }
}

async function preflightStorageArtifacts(
  bundleRoot: string,
  mode: SplitStorageBackupMode
): Promise<void> {
  for (const storageClass of storageClasses) {
    for (const suffix of ['tar.gz', 'manifest.json']) {
      const path = resolve(bundleRoot, `${storageClass}.${suffix}`);
      try {
        const value = await lstat(path);
        if (mode === 'capture') {
          fail(`Split storage backup artifact already exists: ${storageClass}.${suffix}`);
        }
        if (!value.isFile() || value.isSymbolicLink() || value.size < 1) {
          fail(`Split storage restore artifact is unsafe: ${storageClass}.${suffix}`);
        }
      } catch (cause: unknown) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          if (mode === 'restore') {
            fail(`Split storage restore artifact is missing: ${storageClass}.${suffix}`);
          }
          continue;
        }
        throw cause;
      }
    }
  }
}

async function assertEngine(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime
): Promise<void> {
  const evidence = record(parseJson(await checked(
    options,
    runtime,
    ['info', '--format', '{{json .}}'],
    'Could not inspect the approved Docker engine'
  ), 'Docker engine evidence is invalid'), 'Docker engine evidence is invalid');
  if (evidence.ID !== options.expectedDockerEngineId) {
    fail('Docker engine identity does not match the approved engine');
  }
}

async function assertQuiesced(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime
): Promise<void> {
  const running = await checked(options, runtime, [
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
  ], 'Could not inspect storage process state');
  if (running) fail('App, worker, and storage cleanup must be stopped');
}

async function assertNoVolumeUsers(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime
): Promise<void> {
  for (const storageClass of storageClasses) {
    const exactName = exactVolume(options.project, storageClass);
    const users = await checked(options, runtime, [
      'container',
      'ls',
      '--all',
      '--filter',
      `volume=${exactName}`,
      '--format',
      '{{.ID}} {{.Names}}'
    ], `Could not inspect containers using exact storage volume ${exactName}`);
    if (users) fail(`Exact split volume ${exactName} is mounted by a container`);
  }
}

async function assertPinnedLocalHelper(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime
): Promise<void> {
  const image = record(parseJson(await checked(options, runtime, [
    'image',
    'inspect',
    options.helperImage,
    '--format',
    '{{json .}}'
  ], 'Pinned split storage helper is not present locally'), 'Helper image evidence is invalid'),
  'Helper image evidence is invalid');
  const config = record(image.Config, 'Helper image configuration is invalid');
  if (
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(options.helperImage) ||
    config.User !== 'node'
  ) fail('Split storage helper digest or non-root user does not match');
}

function exactVolume(project: string, storageClass: StorageClass): string {
  return `${project}_book_${storageClass}`;
}

async function inspectOwnedVolume(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime,
  storageClass: StorageClass
): Promise<void> {
  const exactName = exactVolume(options.project, storageClass);
  const volume = record(parseJson(await checked(options, runtime, [
    'volume',
    'inspect',
    exactName,
    '--format',
    '{{json .}}'
  ], `Could not inspect exact storage volume ${exactName}`), 'Volume evidence is invalid'),
  'Volume evidence is invalid');
  const labels = record(volume.Labels, 'Volume labels are invalid');
  if (
    volume.Name !== exactName ||
    labels['com.docker.compose.project'] !== options.project ||
    labels['com.docker.compose.volume'] !== `book_${storageClass}`
  ) fail(`Refusing foreign volume ${exactName}`);
}

async function ensureVolumes(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime
): Promise<void> {
  const inventory = (await checked(options, runtime, [
    'volume',
    'ls',
    '--format',
    '{{.Name}}'
  ], 'Could not inventory Docker volumes')).split(/\r?\n/u).filter(Boolean);
  for (const storageClass of storageClasses) {
    const exactName = exactVolume(options.project, storageClass);
    const matches = inventory.filter((name) => name === exactName).length;
    if (matches > 1 || (options.mode === 'capture' && matches !== 1)) {
      fail(`Required exact storage volume is missing or ambiguous: ${exactName}`);
    }
    if (matches === 1) await inspectOwnedVolume(options, runtime, storageClass);
  }
  if (options.mode !== 'restore') return;
  for (const storageClass of storageClasses) {
    const exactName = exactVolume(options.project, storageClass);
    if (inventory.includes(exactName)) continue;
    await assertEngine(options, runtime);
    const created = await checked(options, runtime, [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${options.project}`,
      '--label',
      `com.docker.compose.volume=book_${storageClass}`,
      '--name',
      exactName
    ], `Could not create exact restore volume ${exactName}`);
    if (created !== exactName) fail(`Docker did not return exact restore volume ${exactName}`);
    await inspectOwnedVolume(options, runtime, storageClass);
  }
}

function helperArguments(
  options: SplitStorageBackupOptions,
  storageClass: StorageClass,
  bundleRoot: string,
  helperMode: SplitStorageBackupMode | 'verify-restore' = options.mode
): string[] {
  const volumeRoot = `/var/lib/pale-orbit/${storageClass}`;
  const volumeReadOnly = helperMode !== 'restore';
  const bundleReadOnly = helperMode !== 'capture';
  return [
    'run',
    ...(options.checkpointOwnerToken ? [
      '--label', `com.docker.compose.project=${options.project}`,
      '--label', 'com.docker.compose.service=deployment-checkpoint-storage',
      '--label', `io.pale-orbit.deployment-checkpoint=${options.checkpointOwnerToken}`
    ] : []),
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
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '-e',
    `STORAGE_ARCHIVE_MODE=${helperMode}`,
    '-e',
    `STORAGE_ARCHIVE_CLASS=${storageClass}`,
    '-e',
    `STORAGE_ARCHIVE_VOLUME_ROOT=${volumeRoot}`,
    '-e',
    'STORAGE_ARCHIVE_BUNDLE_ROOT=/backup',
    '-v',
    `${exactVolume(options.project, storageClass)}:${volumeRoot}${
      volumeReadOnly ? ':ro' : ''
    }`,
    '-v',
    `${bundleRoot}:/backup${bundleReadOnly ? ':ro' : ''}`,
    options.helperImage,
    'node',
    'build/services/storage-volume-backup-helper.js'
  ];
}

function validateHelperEvidence(value: string, expectedClass: StorageClass):
SplitStorageBackupResult {
  const line = value.split(/\r?\n/u).filter(Boolean).at(-1);
  if (!line) fail('Split storage helper returned no evidence');
  const evidence = record(parseJson(line, 'Split storage helper evidence is malformed'),
    'Split storage helper evidence is malformed');
  const keys = Object.keys(evidence).sort();
  if (
    keys.join(',') !== ['bytes', 'count', 'sha256', 'storageClass', 'version'].sort().join(',') ||
    evidence.version !== 1 ||
    evidence.storageClass !== expectedClass ||
    !Number.isSafeInteger(evidence.count) || Number(evidence.count) < 0 ||
    !Number.isSafeInteger(evidence.bytes) || Number(evidence.bytes) < 0 ||
    typeof evidence.sha256 !== 'string' || !digestPattern.test(evidence.sha256)
  ) fail('Split storage helper evidence is invalid');
  return evidence as unknown as SplitStorageBackupResult;
}

function validateOptions(options: SplitStorageBackupOptions): void {
  if (!projectPattern.test(options.project)) fail('Compose project name is invalid');
  if (!contextPattern.test(options.dockerContext)) fail('Docker context name is invalid');
  if (!enginePattern.test(options.expectedDockerEngineId)) fail('Docker engine ID is invalid');
  if (!pinnedImagePattern.test(options.helperImage)) fail('Split storage helper must be digest-pinned');
  if (
    options.checkpointOwnerToken !== undefined &&
    !checkpointOwnerTokenPattern.test(options.checkpointOwnerToken)
  ) fail('Checkpoint owner token is invalid');
}

export async function executeSplitStorageBackup(
  options: SplitStorageBackupOptions,
  runtime: SplitStorageBackupRuntime
): Promise<SplitStorageBackupResult[]> {
  validateOptions(options);
  const bundleRoot = await safeBundleRoot(options.bundleRoot);
  await preflightStorageArtifacts(bundleRoot, options.mode);
  await assertEngine(options, runtime);
  await assertQuiesced(options, runtime);
  await assertPinnedLocalHelper(options, runtime);
  await ensureVolumes(options, runtime);
  if (options.mode === 'restore') {
    for (const storageClass of storageClasses) {
      await assertEngine(options, runtime);
      await assertQuiesced(options, runtime);
      await inspectOwnedVolume(options, runtime, storageClass);
      await assertNoVolumeUsers(options, runtime);
      validateHelperEvidence(await checked(
        options,
        runtime,
        helperArguments(options, storageClass, bundleRoot, 'verify-restore'),
        `Split storage restore preflight failed for ${storageClass}`
      ), storageClass);
    }
  }
  const results: SplitStorageBackupResult[] = [];
  for (const storageClass of storageClasses) {
    await assertEngine(options, runtime);
    await assertQuiesced(options, runtime);
    await inspectOwnedVolume(options, runtime, storageClass);
    await assertNoVolumeUsers(options, runtime);
    results.push(validateHelperEvidence(await checked(
      options,
      runtime,
      helperArguments(options, storageClass, bundleRoot),
      `Split storage ${options.mode} failed for ${storageClass}`
    ), storageClass));
  }
  await assertEngine(options, runtime);
  await assertQuiesced(options, runtime);
  for (const storageClass of storageClasses) {
    await inspectOwnedVolume(options, runtime, storageClass);
  }
  return results;
}

export function parseSplitStorageBackupArguments(
  argumentsToParse: readonly string[]
): Omit<SplitStorageBackupOptions, 'helperImage'> {
  const [mode, ...pairs] = argumentsToParse;
  if (mode !== 'capture' && mode !== 'restore') {
    fail('Usage: storage:backup-volumes -- capture|restore --project <name> --root <absolute-path> --context <name> --engine-id <id>');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < pairs.length; index += 2) {
    const name = pairs[index];
    const value = pairs[index + 1];
    if (
      !name ||
      !['--project', '--root', '--context', '--engine-id'].includes(name) ||
      !value ||
      values.has(name)
    ) fail('Usage: storage:backup-volumes -- capture|restore --project <name> --root <absolute-path> --context <name> --engine-id <id>');
    values.set(name, value);
  }
  if (values.size !== 4) {
    fail('Usage: storage:backup-volumes -- capture|restore --project <name> --root <absolute-path> --context <name> --engine-id <id>');
  }
  return {
    mode,
    project: values.get('--project')!,
    bundleRoot: values.get('--root')!,
    dockerContext: values.get('--context')!,
    expectedDockerEngineId: values.get('--engine-id')!
  };
}

export function createDockerSplitStorageBackupRuntime(): SplitStorageBackupRuntime {
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

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isMain) {
  const command = parseSplitStorageBackupArguments(process.argv.slice(2));
  const helperImage = process.env.STORAGE_BACKUP_HELPER_IMAGE;
  if (!helperImage) fail('STORAGE_BACKUP_HELPER_IMAGE is required');
  executeSplitStorageBackup({ ...command, helperImage }, createDockerSplitStorageBackupRuntime())
    .then((results) => console.info(JSON.stringify({
      version: 1,
      mode: command.mode,
      classes: results.map(({ storageClass, count, bytes, sha256 }) => ({
        storageClass,
        count,
        bytes,
        sha256
      }))
    })))
    .catch((cause: unknown) => {
      console.error('[split-storage-backup] failed', {
        name: cause instanceof Error ? cause.name : 'UnknownError'
      });
      process.exitCode = 1;
    });
}
