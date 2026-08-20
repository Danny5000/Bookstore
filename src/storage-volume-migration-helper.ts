import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publicationReadinessSentinelKey } from './lib/server/storage/keys';

type AuthoritativeStorageClass = 'staging' | 'publication' | 'covers';
type IgnoredStorageClass = 'health' | 'scratch';
type LegacyStorageClass = AuthoritativeStorageClass | IgnoredStorageClass;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const generation = '(?:0|[1-9][0-9]{0,9})';
const derivedClass = '(?:prose-images|comic-pages|cover-suggestions)';
const stagingFile = new RegExp(`^staging/uploads/${uuid}$`, 'u');
const publicationSentinel = publicationReadinessSentinelKey();
const healthFile = new RegExp(`^health/probes/${uuid}$`, 'u');
const scratchFile = new RegExp(`^\\.verified-downloads/${uuid}$`, 'u');
const publicationFile = new RegExp(
  `^titles/${uuid}/revisions/${uuid}/(?:original|derived/v1/(?:${derivedClass}/${uuid}\\.webp|generations/${generation}/${derivedClass}/${uuid}\\.webp))$`,
  'u'
);
const coversFile = new RegExp(`^titles/${uuid}/covers/${uuid}\\.webp$`, 'u');
const knownDirectory = new RegExp(
  `^(?:staging(?:/uploads)?|health(?:/probes)?|\\.verified-downloads|titles(?:/${uuid}(?:/(?:covers|revisions(?:/${uuid}(?:/derived(?:/v1(?:/(?:${derivedClass}|generations(?:/${generation}(?:/${derivedClass})?)?))?)?)?)?))?)?)$`,
  'u'
);
const maximumGeneration = 2_147_483_647;

function hasBoundedGeneration(value: string): boolean {
  const match = /\/generations\/([^/]+)/u.exec(value);
  return !match || Number(match[1]) <= maximumGeneration;
}

export class StorageVolumeMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageVolumeMigrationError';
  }
}

export interface StorageVolumeMigrationInput {
  legacyRoot: string;
  stagingRoot: string;
  publicationRoot: string;
  coversRoot: string;
}

interface ScannedFile {
  key: string;
  source: string;
  byteSize: number;
  checksumSha256: string;
  storageClass: LegacyStorageClass;
}

interface ClassEvidence {
  count: number;
  bytes: number;
  sourceSha256: string;
  destinationSha256: string;
  verified: true;
}

export interface StorageVolumeMigrationManifest {
  version: 1;
  classes: Record<AuthoritativeStorageClass, ClassEvidence>;
  ignored: Record<IgnoredStorageClass, { count: number; bytes: number }>;
}

export function classifyLegacyStoragePath(
  logicalPath: string,
  kind: 'file' | 'directory'
): LegacyStorageClass | 'directory' {
  if (kind === 'directory') {
    if (logicalPath === 'health/publication') return 'directory';
    if (knownDirectory.test(logicalPath) && hasBoundedGeneration(logicalPath)) {
      return 'directory';
    }
    throw new StorageVolumeMigrationError(`Unknown legacy storage directory: ${logicalPath}`);
  }
  if (stagingFile.test(logicalPath)) return 'staging';
  if (logicalPath === publicationSentinel) return 'publication';
  if (publicationFile.test(logicalPath) && hasBoundedGeneration(logicalPath)) {
    return 'publication';
  }
  if (coversFile.test(logicalPath)) return 'covers';
  if (healthFile.test(logicalPath)) return 'health';
  if (scratchFile.test(logicalPath)) return 'scratch';
  throw new StorageVolumeMigrationError(`Unknown legacy storage file: ${logicalPath}`);
}

function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathsOverlap(left: string, right: string): boolean {
  const isInside = (value: string) => value === '' ||
    (value !== '..' && !value.startsWith(`..${sep}`));
  return isInside(relative(left, right)) || isInside(relative(right, left));
}

async function canonicalRoots(input: StorageVolumeMigrationInput): Promise<{
  legacyRoot: string;
  stagingRoot: string;
  publicationRoot: string;
  coversRoot: string;
}> {
  const requested = {
    legacyRoot: resolve(input.legacyRoot),
    stagingRoot: resolve(input.stagingRoot),
    publicationRoot: resolve(input.publicationRoot),
    coversRoot: resolve(input.coversRoot)
  };
  await Promise.all(Object.values(requested).map((root) => mkdir(root, { recursive: true })));
  const canonical = {
    legacyRoot: await realpath(requested.legacyRoot),
    stagingRoot: await realpath(requested.stagingRoot),
    publicationRoot: await realpath(requested.publicationRoot),
    coversRoot: await realpath(requested.coversRoot)
  };
  const roots = Object.values(canonical);
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (pathsOverlap(roots[left]!, roots[right]!)) {
        throw new StorageVolumeMigrationError('Migration roots must be mutually disjoint');
      }
    }
  }
  return canonical;
}

async function hashFile(path: string): Promise<{ byteSize: number; checksumSha256: string }> {
  const digest = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.byteLength;
    digest.update(bytes);
  }
  return { byteSize, checksumSha256: digest.digest('hex') };
}

async function scanLegacy(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => rawCompare(left.name, right.name));
    for (const entry of entries) {
      const target = join(directory, entry.name);
      const logicalPath = relative(root, target).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new StorageVolumeMigrationError('Legacy storage symbolic links are forbidden');
      }
      if (entry.isDirectory()) {
        classifyLegacyStoragePath(logicalPath, 'directory');
        await walk(target);
        continue;
      }
      if (!entry.isFile()) {
        throw new StorageVolumeMigrationError('Legacy storage special files are forbidden');
      }
      const storageClass = classifyLegacyStoragePath(logicalPath, 'file') as LegacyStorageClass;
      const file = await lstat(target);
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new StorageVolumeMigrationError('Legacy storage contains an unsafe file');
      }
      const evidence = await hashFile(target);
      if (evidence.byteSize !== file.size) {
        throw new StorageVolumeMigrationError('Legacy storage changed during inventory');
      }
      files.push({
        key: logicalPath,
        source: target,
        byteSize: evidence.byteSize,
        checksumSha256: evidence.checksumSha256,
        storageClass
      });
    }
  };
  await walk(root);
  return files.sort((left, right) => rawCompare(left.key, right.key));
}

async function assertEmpty(root: string): Promise<void> {
  if ((await readdir(root)).length > 0) {
    throw new StorageVolumeMigrationError('New storage destinations must be empty');
  }
}

export async function assertMigrationDestinationsEmpty(
  input: StorageVolumeMigrationInput
): Promise<void> {
  const roots = await canonicalRoots(input);
  await Promise.all([
    assertEmpty(roots.stagingRoot),
    assertEmpty(roots.publicationRoot),
    assertEmpty(roots.coversRoot)
  ]);
}

async function copyExact(source: ScannedFile, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const partial = join(dirname(destination), `.${basename(destination)}.migration-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(partial, 'wx', 0o600);
    let byteSize = 0;
    const limiter = new Transform({
      transform(chunk: unknown, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        byteSize += bytes.byteLength;
        if (byteSize > source.byteSize) {
          callback(new StorageVolumeMigrationError('Legacy storage changed during copy'));
        } else callback(null, bytes);
      }
    });
    const output = handle.createWriteStream({ autoClose: false });
    await pipeline(createReadStream(source.source), limiter, output);
    if (byteSize !== source.byteSize) {
      throw new StorageVolumeMigrationError('Legacy storage changed during copy');
    }
    await handle.sync();
    const closed = once(output, 'close');
    output.destroy();
    await closed;
    await handle.close();
    handle = undefined;
    await rename(partial, destination);
  } catch (cause: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw cause;
  }
}

function aggregate(files: readonly Pick<ScannedFile, 'key' | 'byteSize' | 'checksumSha256'>[]): {
  count: number;
  bytes: number;
  checksumSha256: string;
} {
  const ordered = [...files].sort((left, right) => rawCompare(left.key, right.key));
  const digest = createHash('sha256');
  let bytes = 0;
  for (const file of ordered) {
    bytes += file.byteSize;
    digest.update(`${file.checksumSha256} ${file.byteSize} ${file.key}\n`);
  }
  return { count: ordered.length, bytes, checksumSha256: digest.digest('hex') };
}

async function scanDestination(
  root: string,
  expectedClass: AuthoritativeStorageClass
): Promise<ScannedFile[]> {
  const files = await scanLegacy(root);
  if (files.some((file) => file.storageClass !== expectedClass)) {
    throw new StorageVolumeMigrationError('Destination contains a misrouted storage key');
  }
  return files;
}

async function clearDestinationRoots(roots: readonly string[]): Promise<void> {
  for (const root of roots) {
    for (const entry of await readdir(root)) {
      await rm(join(root, entry), { recursive: true, force: true });
    }
  }
}

export async function migrateLegacyStorage(
  input: StorageVolumeMigrationInput
): Promise<StorageVolumeMigrationManifest> {
  const roots = await canonicalRoots(input);
  const destinationRoots = [roots.stagingRoot, roots.publicationRoot, roots.coversRoot];
  await Promise.all(destinationRoots.map(assertEmpty));
  const sourceFiles = await scanLegacy(roots.legacyRoot);
  const authoritative = sourceFiles.filter(
    (file): file is ScannedFile & { storageClass: AuthoritativeStorageClass } =>
      file.storageClass === 'staging' ||
      file.storageClass === 'publication' ||
      file.storageClass === 'covers'
  );

  try {
    for (const file of authoritative) {
      const root = {
        staging: roots.stagingRoot,
        publication: roots.publicationRoot,
        covers: roots.coversRoot
      }[file.storageClass];
      await copyExact(file, join(root, ...file.key.split('/')));
    }

    const destinationFiles = {
      staging: await scanDestination(roots.stagingRoot, 'staging'),
      publication: await scanDestination(roots.publicationRoot, 'publication'),
      covers: await scanDestination(roots.coversRoot, 'covers')
    };
    const classes = {} as Record<AuthoritativeStorageClass, ClassEvidence>;
    for (const storageClass of ['staging', 'publication', 'covers'] as const) {
      const source = aggregate(authoritative.filter((file) => file.storageClass === storageClass));
      const destination = aggregate(destinationFiles[storageClass]);
      if (
        source.count !== destination.count ||
        source.bytes !== destination.bytes ||
        source.checksumSha256 !== destination.checksumSha256
      ) {
        throw new StorageVolumeMigrationError(`Storage class ${storageClass} failed verification`);
      }
      classes[storageClass] = {
        count: source.count,
        bytes: source.bytes,
        sourceSha256: source.checksumSha256,
        destinationSha256: destination.checksumSha256,
        verified: true
      };
    }
    const ignoredEvidence = (storageClass: IgnoredStorageClass) => {
      const files = sourceFiles.filter((file) => file.storageClass === storageClass);
      return { count: files.length, bytes: files.reduce((sum, file) => sum + file.byteSize, 0) };
    };
    return {
      version: 1,
      classes,
      ignored: {
        health: ignoredEvidence('health'),
        scratch: ignoredEvidence('scratch')
      }
    };
  } catch (cause: unknown) {
    await clearDestinationRoots(destinationRoots);
    throw cause;
  }
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = environment[name];
  if (!value) throw new StorageVolumeMigrationError(`${name} is required`);
  return value;
}

export async function runStorageVolumeMigrationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  writeOutput: (value: string) => void = console.info
): Promise<StorageVolumeMigrationManifest | { version: 1; empty: true }> {
  const input = {
    legacyRoot: requiredEnvironment(environment, 'STORAGE_MIGRATION_LEGACY_ROOT'),
    stagingRoot: requiredEnvironment(environment, 'STORAGE_MIGRATION_STAGING_ROOT'),
    publicationRoot: requiredEnvironment(environment, 'STORAGE_MIGRATION_PUBLICATION_ROOT'),
    coversRoot: requiredEnvironment(environment, 'STORAGE_MIGRATION_COVERS_ROOT')
  };
  const mode = environment.STORAGE_MIGRATION_MODE;
  const result = await (mode === 'verify-empty'
    ? assertMigrationDestinationsEmpty(input).then(() => ({ version: 1 as const, empty: true as const }))
    : mode === 'migrate'
      ? migrateLegacyStorage(input)
      : Promise.reject(new StorageVolumeMigrationError('Unknown storage migration mode')));
  writeOutput(JSON.stringify(result));
  return result;
}
