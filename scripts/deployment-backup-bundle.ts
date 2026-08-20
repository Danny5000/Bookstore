import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const DEPLOYMENT_BACKUP_ARTIFACTS = [
  'database.dump',
  'staging.tar.gz',
  'staging.manifest.json',
  'publication.tar.gz',
  'publication.manifest.json',
  'covers.tar.gz',
  'covers.manifest.json',
  'migration-journal.csv',
  'application-image.json',
  'restore-row-counts.csv',
  'storage-samples.csv',
  'source-docker-engine.json',
  'financial-operational-diagnostics.csv',
  'verify-financial-restore.sql'
] as const;

type DeploymentBackupArtifact = (typeof DEPLOYMENT_BACKUP_ARTIFACTS)[number];

export interface DeploymentBackupBundleManifest {
  version: 2;
  backupId: string;
  artifacts: Record<DeploymentBackupArtifact, { bytes: number; sha256: string }>;
}

export class DeploymentBackupBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentBackupBundleError';
  }
}

const backupIdPattern = /^[a-f0-9]{32}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactStrings(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort(rawCompare);
  const right = [...expected].sort(rawCompare);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function safeRoot(configuredRoot: string): Promise<string> {
  const root = resolve(configuredRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DeploymentBackupBundleError('Backup root must be a real directory');
  }
  const canonical = await realpath(root);
  if (resolve(canonical) !== root) {
    throw new DeploymentBackupBundleError('Backup root must not traverse symbolic links');
  }
  return canonical;
}

export async function hashDeploymentBackupArtifact(
  root: string,
  name: DeploymentBackupArtifact
): Promise<{ bytes: number; sha256: string }> {
  const path = join(root, name);
  const pathBefore = await lstat(path, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size < 1n) {
    throw new DeploymentBackupBundleError(`Backup artifact is unsafe or empty: ${name}`);
  }
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size !== pathBefore.size ||
      before.mtimeNs !== pathBefore.mtimeNs
    ) throw new DeploymentBackupBundleError(`Backup artifact changed while hashing: ${name}`);
    const digest = createHash('sha256');
    let bytes = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      digest.update(value);
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      after.size !== pathAfter.size ||
      after.mtimeNs !== pathAfter.mtimeNs ||
      BigInt(bytes) !== after.size
    ) throw new DeploymentBackupBundleError(`Backup artifact changed while hashing: ${name}`);
    return { bytes, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function publishDeploymentBackupManifestNoClobber(
  partial: string,
  target: string
): Promise<void> {
  await link(partial, target);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeploymentBackupBundleError('Backup bundle manifest is invalid');
  }
  return value as Record<string, unknown>;
}

function parseManifest(value: string): DeploymentBackupBundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DeploymentBackupBundleError('Backup bundle manifest is invalid JSON');
  }
  const manifest = record(parsed);
  if (
    !exactStrings(Object.keys(manifest), ['version', 'backupId', 'artifacts']) ||
    manifest.version !== 2 ||
    typeof manifest.backupId !== 'string' ||
    !backupIdPattern.test(manifest.backupId)
  ) throw new DeploymentBackupBundleError('Backup bundle manifest is invalid');
  const artifacts = record(manifest.artifacts);
  if (!exactStrings(Object.keys(artifacts), DEPLOYMENT_BACKUP_ARTIFACTS)) {
    throw new DeploymentBackupBundleError('Backup bundle artifact inventory mismatch');
  }
  for (const name of DEPLOYMENT_BACKUP_ARTIFACTS) {
    const evidence = record(artifacts[name]);
    if (
      !exactStrings(Object.keys(evidence), ['bytes', 'sha256']) ||
      !Number.isSafeInteger(evidence.bytes) ||
      Number(evidence.bytes) < 1 ||
      typeof evidence.sha256 !== 'string' ||
      !digestPattern.test(evidence.sha256)
    ) throw new DeploymentBackupBundleError(`Backup bundle evidence is invalid: ${name}`);
  }
  return manifest as unknown as DeploymentBackupBundleManifest;
}

export async function sealDeploymentBackupBundle(
  configuredRoot: string,
  backupId: string
): Promise<DeploymentBackupBundleManifest> {
  if (!backupIdPattern.test(backupId)) {
    throw new DeploymentBackupBundleError('Backup ID is invalid');
  }
  const root = await safeRoot(configuredRoot);
  const entries = await readdir(root, { withFileTypes: true });
  if (
    !exactStrings(entries.map(({ name }) => name), DEPLOYMENT_BACKUP_ARTIFACTS) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) throw new DeploymentBackupBundleError('Backup artifact inventory mismatch');

  const artifacts = {} as DeploymentBackupBundleManifest['artifacts'];
  for (const name of DEPLOYMENT_BACKUP_ARTIFACTS) {
    artifacts[name] = await hashDeploymentBackupArtifact(root, name);
  }
  const manifest: DeploymentBackupBundleManifest = { version: 2, backupId, artifacts };
  const target = join(root, 'backup-bundle.json');
  const partial = join(root, `.backup-bundle-${randomUUID()}.partial`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(partial, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await publishDeploymentBackupManifestNoClobber(partial, target);
    await rm(partial);
    return manifest;
  } catch (cause: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw cause;
  }
}

export async function verifyDeploymentBackupBundle(
  configuredRoot: string,
  expectedBackupId: string
): Promise<DeploymentBackupBundleManifest> {
  if (!backupIdPattern.test(expectedBackupId)) {
    throw new DeploymentBackupBundleError('Expected backup ID is invalid');
  }
  const root = await safeRoot(configuredRoot);
  const expectedEntries = [...DEPLOYMENT_BACKUP_ARTIFACTS, 'backup-bundle.json'];
  const entries = await readdir(root, { withFileTypes: true });
  if (
    !exactStrings(entries.map(({ name }) => name), expectedEntries) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) throw new DeploymentBackupBundleError('Backup bundle inventory mismatch');

  const manifestHandle = await open(join(root, 'backup-bundle.json'), 'r');
  let manifestText: string;
  try {
    const manifestStat = await manifestHandle.stat();
    if (!manifestStat.isFile() || manifestStat.size < 1 || manifestStat.size > 1_000_000) {
      throw new DeploymentBackupBundleError('Backup bundle manifest size is invalid');
    }
    manifestText = await manifestHandle.readFile('utf8');
  } finally {
    await manifestHandle.close();
  }
  const manifest = parseManifest(manifestText);
  if (manifest.backupId !== expectedBackupId) {
    throw new DeploymentBackupBundleError('Backup ID mismatch');
  }
  for (const name of DEPLOYMENT_BACKUP_ARTIFACTS) {
    const actual = await hashDeploymentBackupArtifact(root, name);
    const expected = manifest.artifacts[name];
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new DeploymentBackupBundleError(`Backup artifact digest or byte mismatch: ${name}`);
    }
  }
  return manifest;
}
