import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  publicationReadinessSentinelKey,
  publicationReadinessSentinelValue
} from './lib/server/storage/keys';
import { classifyLegacyStoragePath } from './storage-volume-migration-helper';

export type StorageArchiveClass = 'staging' | 'publication' | 'covers';

export interface StorageArchiveEntry {
  key: string;
  bytes: number;
  sha256: string;
}

export interface StorageArchiveManifest {
  version: 1;
  storageClass: StorageArchiveClass;
  count: number;
  bytes: number;
  sha256: string;
  entries: StorageArchiveEntry[];
  ignored: { health: { count: number; bytes: number } };
}

export interface CaptureStorageVolumeOptions {
  storageClass: StorageArchiveClass;
  sourceRoot: string;
  outputRoot: string;
}

export interface RestoreStorageVolumeOptions {
  storageClass: StorageArchiveClass;
  destinationRoot: string;
  inputRoot: string;
}

export class StorageVolumeBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageVolumeBackupError';
  }
}

interface ScannedEntry extends StorageArchiveEntry {
  source: string;
}

interface ScannedVolume {
  entries: ScannedEntry[];
  ignoredHealth: { count: number; bytes: number };
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const generation = '(?:0|[1-9][0-9]{0,9})';
const derivedClass = '(?:prose-images|comic-pages|cover-suggestions)';
const publicationSentinelKey = publicationReadinessSentinelKey();
const publicationSentinelBytes = Buffer.byteLength(publicationReadinessSentinelValue, 'utf8');
const publicationSentinelSha256 = createHash('sha256')
  .update(publicationReadinessSentinelValue, 'utf8')
  .digest('hex');
const allowedDirectories: Record<StorageArchiveClass, RegExp> = {
  staging: new RegExp(`^(?:staging(?:/uploads)?|health(?:/probes)?)$`, 'u'),
  publication: new RegExp(
    `^titles(?:/${uuid}(?:/revisions(?:/${uuid}(?:/derived(?:/v1(?:/(?:${derivedClass}|generations(?:/${generation}(?:/${derivedClass})?)?))?)?)?)?)?)?$`,
    'u'
  ),
  covers: new RegExp(`^titles(?:/${uuid}(?:/covers)?)?$`, 'u')
};
const maximumGeneration = 2_147_483_647;
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumManifestBytes = 64 * 1024 * 1024;
const maximumManifestEntries = 1_000_000;
const tarBlockBytes = 512;

function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasBoundedGeneration(value: string): boolean {
  const match = /\/generations\/([^/]+)/u.exec(value);
  return !match || Number(match[1]) <= maximumGeneration;
}

function isAllowedDirectory(storageClass: StorageArchiveClass, key: string): boolean {
  if (
    storageClass === 'publication' &&
    (key === 'health' || key === 'health/publication')
  ) return true;
  return allowedDirectories[storageClass].test(key);
}

function pathsOverlap(left: string, right: string): boolean {
  const isInside = (value: string) => value === '' ||
    (value !== '..' && !value.startsWith(`..${sep}`));
  return isInside(relative(left, right)) || isInside(relative(right, left));
}

async function safeExistingRoot(path: string, description: string): Promise<string> {
  const requested = resolve(path);
  const value = await lstat(requested);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new StorageVolumeBackupError(`${description} must be a real directory`);
  }
  const canonical = await realpath(requested);
  if (resolve(canonical) !== requested) {
    throw new StorageVolumeBackupError(`${description} must not traverse symbolic links`);
  }
  return canonical;
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new StorageVolumeBackupError('Storage volume contains an unsafe file');
  }
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    digest.update(value);
  }
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    BigInt(bytes) !== after.size
  ) {
    throw new StorageVolumeBackupError('Storage volume changed during inventory');
  }
  return { bytes, sha256: digest.digest('hex') };
}

function fileClass(key: string): 'staging' | 'publication' | 'covers' | 'health' {
  try {
    const classified = classifyLegacyStoragePath(key, 'file');
    if (classified === 'scratch' || classified === 'directory') {
      throw new StorageVolumeBackupError(`Misrouted storage key: ${key}`);
    }
    return classified;
  } catch (cause: unknown) {
    if (cause instanceof StorageVolumeBackupError) throw cause;
    throw new StorageVolumeBackupError(`Unknown storage key: ${key}`);
  }
}

async function scanVolume(root: string, storageClass: StorageArchiveClass): Promise<ScannedVolume> {
  const entries: ScannedEntry[] = [];
  const ignoredHealth = { count: 0, bytes: 0 };
  const walk = async (directory: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => rawCompare(left.name, right.name));
    for (const child of children) {
      const target = join(directory, child.name);
      const key = relative(root, target).split(sep).join('/');
      if (child.isSymbolicLink()) {
        throw new StorageVolumeBackupError('Storage volume symbolic links are forbidden');
      }
      if (child.isDirectory()) {
        if (!isAllowedDirectory(storageClass, key) || !hasBoundedGeneration(key)) {
          throw new StorageVolumeBackupError(`Unknown or misrouted storage directory: ${key}`);
        }
        await walk(target);
        continue;
      }
      if (!child.isFile()) {
        throw new StorageVolumeBackupError('Storage volume special files are forbidden');
      }
      const classified = fileClass(key);
      const evidence = await hashFile(target);
      if (classified === 'health' && storageClass === 'staging') {
        ignoredHealth.count += 1;
        ignoredHealth.bytes += evidence.bytes;
        continue;
      }
      if (classified !== storageClass) {
        throw new StorageVolumeBackupError(`Misrouted storage key: ${key}`);
      }
      entries.push({ key, source: target, ...evidence });
    }
  };
  await walk(root);
  const orderedEntries = entries.sort((left, right) => rawCompare(left.key, right.key));
  assertPublicationSentinel(storageClass, orderedEntries);
  return { entries: orderedEntries, ignoredHealth };
}

function assertPublicationSentinel(
  storageClass: StorageArchiveClass,
  entries: readonly StorageArchiveEntry[]
): void {
  if (storageClass !== 'publication') return;
  const matches = entries.filter((entry) => entry.key === publicationSentinelKey);
  if (
    matches.length !== 1 ||
    matches[0]!.bytes !== publicationSentinelBytes ||
    matches[0]!.sha256 !== publicationSentinelSha256
  ) {
    throw new StorageVolumeBackupError(
      'Publication readiness sentinel is missing or invalid'
    );
  }
}

function aggregate(entries: readonly StorageArchiveEntry[]): {
  count: number;
  bytes: number;
  sha256: string;
} {
  const digest = createHash('sha256');
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    digest.update(`${entry.sha256} ${entry.bytes} ${entry.key}\n`);
  }
  return { count: entries.length, bytes, sha256: digest.digest('hex') };
}

function manifestFor(
  storageClass: StorageArchiveClass,
  volume: ScannedVolume
): StorageArchiveManifest {
  const entries = volume.entries.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 }));
  return {
    version: 1,
    storageClass,
    ...aggregate(entries),
    entries,
    ignored: { health: volume.ignoredHealth }
  };
}

function tarPathFields(key: string): { name: string; prefix: string } {
  if (!/^[\x20-\x7e]+$/u.test(key) || key.startsWith('/') || key.includes('\\')) {
    throw new StorageVolumeBackupError('Storage key cannot be represented safely in tar');
  }
  if (Buffer.byteLength(key, 'ascii') <= 100) return { name: key, prefix: '' };
  for (let separator = key.lastIndexOf('/'); separator > 0; separator = key.lastIndexOf('/', separator - 1)) {
    const prefix = key.slice(0, separator);
    const name = key.slice(separator + 1);
    if (Buffer.byteLength(prefix, 'ascii') <= 155 && Buffer.byteLength(name, 'ascii') <= 100) {
      return { name, prefix };
    }
  }
  throw new StorageVolumeBackupError('Storage key is too long for the archive format');
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) {
    throw new StorageVolumeBackupError('Storage object is too large for the archive format');
  }
  target.write(encoded, offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

function tarHeader(entry: StorageArchiveEntry): Buffer {
  const header = Buffer.alloc(tarBlockBytes);
  const fields = tarPathFields(entry.key);
  header.write(fields.name, 0, 100, 'ascii');
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(fields.prefix, 345, 155, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
  header.write(checksum, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function* tarContents(entries: readonly ScannedEntry[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    yield tarHeader(entry);
    const before = await lstat(entry.source, { bigint: true });
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(entry.source)) {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      digest.update(value);
      yield value;
    }
    const after = await lstat(entry.source, { bigint: true });
    if (
      bytes !== entry.bytes ||
      digest.digest('hex') !== entry.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) throw new StorageVolumeBackupError('Storage volume changed during archive capture');
    const padding = (tarBlockBytes - (entry.bytes % tarBlockBytes)) % tarBlockBytes;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(tarBlockBytes * 2);
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new StorageVolumeBackupError(`Backup artifact already exists: ${basename(path)}`);
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

async function writeArchive(path: string, entries: readonly ScannedEntry[]): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let output: ReturnType<Awaited<ReturnType<typeof open>>['createWriteStream']> | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
    output = handle.createWriteStream({ autoClose: false });
    await pipeline(
      Readable.from(tarContents(entries)),
      createGzip({ level: 9 }),
      output
    );
    await handle.sync();
    const closed = once(output, 'close');
    output.destroy();
    await closed;
    await handle.close();
    handle = undefined;
  } catch (cause: unknown) {
    output?.destroy();
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true });
    throw cause;
  }
}

async function writeManifest(path: string, manifest: StorageArchiveManifest): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (cause: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true });
    throw cause;
  }
}

export async function captureStorageVolume(
  options: CaptureStorageVolumeOptions
): Promise<StorageArchiveManifest> {
  const sourceRoot = await safeExistingRoot(options.sourceRoot, 'Storage source root');
  const outputRoot = await safeExistingRoot(options.outputRoot, 'Backup output root');
  if (pathsOverlap(sourceRoot, outputRoot)) {
    throw new StorageVolumeBackupError('Storage source and backup output must be disjoint');
  }
  const archivePath = join(outputRoot, `${options.storageClass}.tar.gz`);
  const manifestPath = join(outputRoot, `${options.storageClass}.manifest.json`);
  await assertAbsent(archivePath);
  await assertAbsent(manifestPath);
  const volume = await scanVolume(sourceRoot, options.storageClass);
  const manifest = manifestFor(options.storageClass, volume);
  try {
    await writeArchive(archivePath, volume.entries);
    await verifyArchiveContents(archivePath, manifest);
    await writeManifest(manifestPath, manifest);
    return manifest;
  } catch (cause: unknown) {
    await rm(archivePath, { force: true });
    await rm(manifestPath, { force: true });
    throw cause;
  }
}

function record(value: unknown, description = 'Storage archive manifest is invalid'):
Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StorageVolumeBackupError(description);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(rawCompare);
  const wanted = [...expected].sort(rawCompare);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateManifest(
  value: unknown,
  expectedClass: StorageArchiveClass
): StorageArchiveManifest {
  const manifest = record(value);
  if (
    !exactKeys(manifest, [
      'version', 'storageClass', 'count', 'bytes', 'sha256', 'entries', 'ignored'
    ]) ||
    manifest.version !== 1 ||
    manifest.storageClass !== expectedClass ||
    !nonnegativeSafeInteger(manifest.count) ||
    !nonnegativeSafeInteger(manifest.bytes) ||
    typeof manifest.sha256 !== 'string' ||
    !digestPattern.test(manifest.sha256) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > maximumManifestEntries
  ) throw new StorageVolumeBackupError('Storage archive manifest is invalid');
  const entries: StorageArchiveEntry[] = [];
  let previousKey: string | undefined;
  for (const rawEntry of manifest.entries) {
    const entry = record(rawEntry, 'Storage archive entry is invalid');
    if (
      !exactKeys(entry, ['key', 'bytes', 'sha256']) ||
      typeof entry.key !== 'string' ||
      !nonnegativeSafeInteger(entry.bytes) ||
      typeof entry.sha256 !== 'string' ||
      !digestPattern.test(entry.sha256) ||
      fileClass(entry.key) !== expectedClass ||
      (previousKey !== undefined && rawCompare(previousKey, entry.key) >= 0)
    ) throw new StorageVolumeBackupError('Storage archive entry is invalid');
    entries.push({ key: entry.key, bytes: entry.bytes, sha256: entry.sha256 });
    previousKey = entry.key;
  }
  assertPublicationSentinel(expectedClass, entries);
  const evidence = aggregate(entries);
  if (
    evidence.count !== manifest.count ||
    evidence.bytes !== manifest.bytes ||
    evidence.sha256 !== manifest.sha256
  ) throw new StorageVolumeBackupError('Storage archive aggregate evidence is invalid');
  const ignored = record(manifest.ignored);
  const health = record(ignored.health);
  if (
    !exactKeys(ignored, ['health']) ||
    !exactKeys(health, ['count', 'bytes']) ||
    !nonnegativeSafeInteger(health.count) ||
    !nonnegativeSafeInteger(health.bytes) ||
    (expectedClass !== 'staging' && (health.count !== 0 || health.bytes !== 0))
  ) throw new StorageVolumeBackupError('Storage archive ignored evidence is invalid');
  return {
    version: 1,
    storageClass: expectedClass,
    ...evidence,
    entries,
    ignored: { health: { count: health.count, bytes: health.bytes } }
  };
}

export async function readStorageArchiveManifest(root: string, storageClass: StorageArchiveClass):
Promise<StorageArchiveManifest> {
  const path = join(root, `${storageClass}.manifest.json`);
  const value = await lstat(path);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.size < 1 ||
    value.size > maximumManifestBytes
  ) throw new StorageVolumeBackupError('Storage archive manifest file is unsafe');
  const handle = await open(path, 'r');
  try {
    return validateManifest(JSON.parse(await handle.readFile('utf8')) as unknown, storageClass);
  } catch (cause: unknown) {
    if (cause instanceof StorageVolumeBackupError) throw cause;
    throw new StorageVolumeBackupError('Storage archive manifest is invalid JSON');
  } finally {
    await handle.close();
  }
}

class ExactStreamReader {
  readonly #iterator: AsyncIterator<unknown>;
  #buffer = Buffer.alloc(0);
  #ended = false;

  constructor(stream: Readable) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async readExact(bytes: number): Promise<Buffer> {
    while (this.#buffer.byteLength < bytes && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) this.#ended = true;
      else this.#buffer = Buffer.concat([this.#buffer, Buffer.from(next.value as Uint8Array)]);
    }
    if (this.#buffer.byteLength < bytes) {
      throw new StorageVolumeBackupError('Storage archive ended unexpectedly');
    }
    const result = this.#buffer.subarray(0, bytes);
    this.#buffer = this.#buffer.subarray(bytes);
    return result;
  }

  async assertEnd(): Promise<void> {
    if (this.#buffer.byteLength !== 0) {
      throw new StorageVolumeBackupError('Storage archive contains trailing data');
    }
    const next = await this.#iterator.next();
    if (!next.done) throw new StorageVolumeBackupError('Storage archive contains trailing data');
  }
}

function parseTarText(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const zero = field.indexOf(0);
  const content = zero === -1 ? field : field.subarray(0, zero);
  if (content.some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new StorageVolumeBackupError('Storage archive header text is invalid');
  }
  return content.toString('ascii');
}

function parseTarOctal(block: Buffer, start: number, length: number): number {
  const value = block.subarray(start, start + length).toString('ascii').replace(/[\0 ]+$/gu, '');
  if (!/^[0-7]+$/u.test(value)) {
    throw new StorageVolumeBackupError('Storage archive header number is invalid');
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StorageVolumeBackupError('Storage archive header number is unsafe');
  }
  return parsed;
}

function parseTarHeader(block: Buffer): { key: string; bytes: number } {
  const expectedChecksum = parseTarOctal(block, 148, 8);
  const checksumBlock = Buffer.from(block);
  checksumBlock.fill(0x20, 148, 156);
  if (checksumBlock.reduce((sum, byte) => sum + byte, 0) !== expectedChecksum) {
    throw new StorageVolumeBackupError('Storage archive header checksum mismatch');
  }
  if (
    block.subarray(257, 263).toString('binary') !== 'ustar\0' ||
    block.subarray(263, 265).toString('ascii') !== '00' ||
    (block[156] !== 0 && block[156] !== 0x30)
  ) throw new StorageVolumeBackupError('Storage archive header type is invalid');
  const name = parseTarText(block, 0, 100);
  const prefix = parseTarText(block, 345, 155);
  if (!name) throw new StorageVolumeBackupError('Storage archive path is empty');
  return { key: prefix ? `${prefix}/${name}` : name, bytes: parseTarOctal(block, 124, 12) };
}

async function writeRestoredEntry(
  reader: ExactStreamReader,
  root: string,
  expected: StorageArchiveEntry
): Promise<void> {
  const destination = join(root, ...expected.key.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  const partial = join(dirname(destination), `.${basename(destination)}.restore-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(partial, 'wx', 0o600);
    const digest = createHash('sha256');
    let remaining = expected.bytes;
    while (remaining > 0) {
      const chunk = await reader.readExact(Math.min(remaining, 64 * 1024));
      await handle.write(chunk);
      digest.update(chunk);
      remaining -= chunk.byteLength;
    }
    if (digest.digest('hex') !== expected.sha256) {
      throw new StorageVolumeBackupError('Restored storage object digest mismatch');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(partial, destination);
    const padding = (tarBlockBytes - (expected.bytes % tarBlockBytes)) % tarBlockBytes;
    if (padding && !(await reader.readExact(padding)).equals(Buffer.alloc(padding))) {
      throw new StorageVolumeBackupError('Storage archive padding is invalid');
    }
  } catch (cause: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(partial, { force: true });
    throw cause;
  }
}

async function verifyArchivedEntry(
  reader: ExactStreamReader,
  expected: StorageArchiveEntry
): Promise<void> {
  const digest = createHash('sha256');
  let remaining = expected.bytes;
  while (remaining > 0) {
    const chunk = await reader.readExact(Math.min(remaining, 64 * 1024));
    digest.update(chunk);
    remaining -= chunk.byteLength;
  }
  if (digest.digest('hex') !== expected.sha256) {
    throw new StorageVolumeBackupError('Archived storage object digest mismatch');
  }
  const padding = (tarBlockBytes - (expected.bytes % tarBlockBytes)) % tarBlockBytes;
  if (padding && !(await reader.readExact(padding)).equals(Buffer.alloc(padding))) {
    throw new StorageVolumeBackupError('Storage archive padding is invalid');
  }
}

async function assertEmpty(root: string): Promise<void> {
  if ((await readdir(root)).length !== 0) {
    throw new StorageVolumeBackupError('Restore destination must be empty');
  }
}

async function clearRoot(root: string): Promise<void> {
  for (const entry of await readdir(root)) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
}

async function extractArchive(
  archivePath: string,
  destinationRoot: string,
  manifest: StorageArchiveManifest
): Promise<void> {
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.size < 1) {
    throw new StorageVolumeBackupError('Storage archive file is unsafe');
  }
  const input = createReadStream(archivePath);
  const expanded = input.pipe(createGunzip());
  const reader = new ExactStreamReader(expanded);
  try {
    for (const expected of manifest.entries) {
      const header = await reader.readExact(tarBlockBytes);
      if (header.equals(Buffer.alloc(tarBlockBytes))) {
        throw new StorageVolumeBackupError('Storage archive omitted a manifest entry');
      }
      const actual = parseTarHeader(header);
      if (actual.key !== expected.key || actual.bytes !== expected.bytes) {
        throw new StorageVolumeBackupError('Storage archive entry does not match its manifest');
      }
      await writeRestoredEntry(reader, destinationRoot, expected);
    }
    const terminator = await reader.readExact(tarBlockBytes * 2);
    if (!terminator.equals(Buffer.alloc(tarBlockBytes * 2))) {
      throw new StorageVolumeBackupError('Storage archive has an invalid terminator or extra entry');
    }
    await reader.assertEnd();
  } finally {
    input.destroy();
    expanded.destroy();
  }
}

async function verifyArchiveContents(
  archivePath: string,
  manifest: StorageArchiveManifest
): Promise<void> {
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.size < 1) {
    throw new StorageVolumeBackupError('Storage archive file is unsafe');
  }
  const input = createReadStream(archivePath);
  const expanded = input.pipe(createGunzip());
  const reader = new ExactStreamReader(expanded);
  try {
    for (const expected of manifest.entries) {
      const header = await reader.readExact(tarBlockBytes);
      const actual = parseTarHeader(header);
      if (actual.key !== expected.key || actual.bytes !== expected.bytes) {
        throw new StorageVolumeBackupError('Storage archive entry does not match its manifest');
      }
      await verifyArchivedEntry(reader, expected);
    }
    const terminator = await reader.readExact(tarBlockBytes * 2);
    if (!terminator.equals(Buffer.alloc(tarBlockBytes * 2))) {
      throw new StorageVolumeBackupError('Storage archive has an invalid terminator or extra entry');
    }
    await reader.assertEnd();
  } finally {
    input.destroy();
    expanded.destroy();
  }
}

export async function restoreStorageVolume(
  options: RestoreStorageVolumeOptions
): Promise<StorageArchiveManifest> {
  const destinationRoot = await safeExistingRoot(
    options.destinationRoot,
    'Storage restore destination'
  );
  const inputRoot = await safeExistingRoot(options.inputRoot, 'Backup input root');
  if (pathsOverlap(destinationRoot, inputRoot)) {
    throw new StorageVolumeBackupError('Storage restore destination and backup input must be disjoint');
  }
  await assertEmpty(destinationRoot);
  const manifest = await readStorageArchiveManifest(inputRoot, options.storageClass);
  try {
    await extractArchive(
      join(inputRoot, `${options.storageClass}.tar.gz`),
      destinationRoot,
      manifest
    );
    const restored = manifestFor(
      options.storageClass,
      await scanVolume(destinationRoot, options.storageClass)
    );
    if (
      restored.count !== manifest.count ||
      restored.bytes !== manifest.bytes ||
      restored.sha256 !== manifest.sha256 ||
      JSON.stringify(restored.entries) !== JSON.stringify(manifest.entries)
    ) throw new StorageVolumeBackupError('Restored volume evidence does not match the manifest');
    return manifest;
  } catch (cause: unknown) {
    await clearRoot(destinationRoot);
    throw cause;
  }
}

export async function verifyStorageRestoreInput(
  options: RestoreStorageVolumeOptions
): Promise<StorageArchiveManifest> {
  const destinationRoot = await safeExistingRoot(
    options.destinationRoot,
    'Storage restore destination'
  );
  const inputRoot = await safeExistingRoot(options.inputRoot, 'Backup input root');
  if (pathsOverlap(destinationRoot, inputRoot)) {
    throw new StorageVolumeBackupError('Storage restore destination and backup input must be disjoint');
  }
  await assertEmpty(destinationRoot);
  const manifest = await readStorageArchiveManifest(inputRoot, options.storageClass);
  await verifyArchiveContents(join(
    inputRoot,
    `${options.storageClass}.tar.gz`
  ), manifest);
  return manifest;
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = environment[name];
  if (!value) throw new StorageVolumeBackupError(`${name} is required`);
  return value;
}

export async function runStorageVolumeBackupFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  writeOutput: (value: string) => void = console.info
): Promise<StorageArchiveManifest> {
  const storageClass = requiredEnvironment(environment, 'STORAGE_ARCHIVE_CLASS');
  if (storageClass !== 'staging' && storageClass !== 'publication' && storageClass !== 'covers') {
    throw new StorageVolumeBackupError('STORAGE_ARCHIVE_CLASS is invalid');
  }
  const volumeRoot = requiredEnvironment(environment, 'STORAGE_ARCHIVE_VOLUME_ROOT');
  const bundleRoot = requiredEnvironment(environment, 'STORAGE_ARCHIVE_BUNDLE_ROOT');
  const mode = requiredEnvironment(environment, 'STORAGE_ARCHIVE_MODE');
  const result = await (mode === 'capture'
    ? captureStorageVolume({ storageClass, sourceRoot: volumeRoot, outputRoot: bundleRoot })
    : mode === 'restore'
      ? restoreStorageVolume({
          storageClass,
          destinationRoot: volumeRoot,
          inputRoot: bundleRoot
        })
      : mode === 'verify-restore'
        ? verifyStorageRestoreInput({
            storageClass,
            destinationRoot: volumeRoot,
          inputRoot: bundleRoot
        })
      : Promise.reject(new StorageVolumeBackupError('STORAGE_ARCHIVE_MODE is invalid')));
  writeOutput(JSON.stringify({
    version: result.version,
    storageClass: result.storageClass,
    count: result.count,
    bytes: result.bytes,
    sha256: result.sha256
  }));
  return result;
}
