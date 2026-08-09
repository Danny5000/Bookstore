import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zipEntriesFixture } from '../../../../tests/fixtures/publications';
import { parseStorageKey, type StorageKey } from '../storage/keys';
import { createLocalObjectStorage } from '../storage/local';
import type { ObjectStorage } from '../storage/types';
import { openArchive } from './archive';
import type { IngestionLimits } from './limits';

const limits: IngestionLimits = Object.freeze({
  maxUploadBytes: 1_048_576,
  maxExpandedBytes: 1_048_576,
  maxEntries: 100,
  maxXmlBytes: 1_048_576,
  maxImagePixels: 100_000_000,
  maxCompressionRatio: 1_000,
  timeoutMs: 5_000
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

interface ZipPatch {
  encrypted?: boolean;
  utf8?: boolean;
  compressionMethod?: number;
  externalFileAttributes?: number;
  versionMadeBy?: number;
  uncompressedSize?: number;
  crc32?: number;
}

function patchZipEntry(input: Buffer, fileName: string, patch: ZipPatch): Buffer {
  const output = Buffer.from(input);
  let offset = 0;
  while (offset <= output.length - 46) {
    if (output.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = output.readUInt16LE(offset + 28);
    const extraLength = output.readUInt16LE(offset + 30);
    const commentLength = output.readUInt16LE(offset + 32);
    const name = output.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === fileName) {
      const localOffset = output.readUInt32LE(offset + 42);
      if (patch.encrypted) {
        output.writeUInt16LE(output.readUInt16LE(offset + 8) | 1, offset + 8);
        output.writeUInt16LE(output.readUInt16LE(localOffset + 6) | 1, localOffset + 6);
      }
      if (patch.utf8) {
        output.writeUInt16LE(output.readUInt16LE(offset + 8) | 0x800, offset + 8);
        output.writeUInt16LE(output.readUInt16LE(localOffset + 6) | 0x800, localOffset + 6);
      }
      if (patch.compressionMethod !== undefined) {
        output.writeUInt16LE(patch.compressionMethod, offset + 10);
        output.writeUInt16LE(patch.compressionMethod, localOffset + 8);
      }
      if (patch.externalFileAttributes !== undefined) {
        output.writeUInt32LE(patch.externalFileAttributes >>> 0, offset + 38);
      }
      if (patch.versionMadeBy !== undefined) {
        output.writeUInt16LE(patch.versionMadeBy, offset + 4);
      }
      if (patch.uncompressedSize !== undefined) {
        output.writeUInt32LE(patch.uncompressedSize, offset + 24);
        output.writeUInt32LE(patch.uncompressedSize, localOffset + 22);
      }
      if (patch.crc32 !== undefined) {
        output.writeUInt32LE(patch.crc32 >>> 0, offset + 16);
        output.writeUInt32LE(patch.crc32 >>> 0, localOffset + 14);
      }
      return output;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Could not find ZIP entry ${fileName}`);
}

describe('safe archive session', () => {
  let root: string;
  let storage: ObjectStorage;
  let objectSequence: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pale-orbit-archive-test-'));
    storage = createLocalObjectStorage(root);
    objectSequence = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function storeArchive(bytes: Buffer): Promise<StorageKey> {
    objectSequence += 1;
    const key = parseStorageKey(
      `staging/uploads/018f0000-0000-7000-8000-${objectSequence.toString().padStart(12, '0')}`
    );
    await storage.write(key, Readable.from([bytes]), { maxBytes: 2_000_000 });
    return key;
  }

  it('reads valid stored and deflated entries lazily', async () => {
    const key = await storeArchive(
      zipEntriesFixture({
        'stored.txt': [strToU8('stored'), { level: 0 }],
        'deflated.txt': strToU8('deflated content')
      })
    );
    const archive = await openArchive(storage, key, limits, AbortSignal.timeout(5_000));

    expect(archive.entries.map((entry) => entry.path)).toEqual(['stored.txt', 'deflated.txt']);
    await expect(collect(await archive.read(archive.entries[0]!))).resolves.toEqual(
      Buffer.from('stored')
    );
    await expect(collect(await archive.read(archive.entries[1]!))).resolves.toEqual(
      Buffer.from('deflated content')
    );
    await archive.close();
  });

  it.each([
    '../secret.txt',
    '/absolute.txt',
    'C:/drive.txt',
    'folder\\backslash.txt',
    'folder/./dot.txt',
    'folder/../parent.txt',
    'control-\u0001.txt'
  ])('rejects unsafe archive path %j', async (path) => {
    const fixture = zipEntriesFixture({ [path]: strToU8('unsafe') });
    const bytes = path.includes('\u0001')
      ? patchZipEntry(fixture, path, { utf8: true })
      : fixture;
    const key = await storeArchive(bytes);

    await expect(openArchive(storage, key, limits, AbortSignal.timeout(5_000))).rejects.toMatchObject(
      { code: 'archive_unsafe_path', retryable: false }
    );
  });

  it('rejects duplicate normalized, Unicode-normalized, and case-colliding paths', async () => {
    for (const entries of [
      { 'Page.txt': strToU8('one'), 'page.TXT': strToU8('two') },
      { 'caf\u00e9.txt': strToU8('one'), 'cafe\u0301.txt': strToU8('two') }
    ]) {
      const key = await storeArchive(zipEntriesFixture(entries));
      await expect(
        openArchive(storage, key, limits, AbortSignal.timeout(5_000))
      ).rejects.toMatchObject({ code: 'archive_path_collision' });
    }
  });

  it('rejects symbolic links, encrypted entries, and unsupported compression', async () => {
    const base = zipEntriesFixture({ 'entry.txt': strToU8('entry') });
    const fixtures = [
      patchZipEntry(base, 'entry.txt', {
        versionMadeBy: (3 << 8) | 20,
        externalFileAttributes: 0o120777 << 16
      }),
      patchZipEntry(base, 'entry.txt', { encrypted: true }),
      patchZipEntry(base, 'entry.txt', { compressionMethod: 99 })
    ];
    const codes = ['archive_symlink', 'archive_encrypted', 'archive_unsupported_compression'];

    for (const [index, bytes] of fixtures.entries()) {
      const key = await storeArchive(bytes);
      await expect(
        openArchive(storage, key, limits, AbortSignal.timeout(5_000))
      ).rejects.toMatchObject({ code: codes[index] });
    }
  });

  it('enforces entry count, expanded size, single-entry size, and compression ratio', async () => {
    const threeEntries = await storeArchive(
      zipEntriesFixture({
        '1.txt': strToU8('1'),
        '2.txt': strToU8('2'),
        '3.txt': strToU8('3')
      })
    );
    await expect(
      openArchive(storage, threeEntries, { ...limits, maxEntries: 2 }, AbortSignal.timeout(5_000))
    ).rejects.toMatchObject({ code: 'archive_entry_count' });

    const twoEntries = await storeArchive(
      zipEntriesFixture({ '1.txt': strToU8('1234'), '2.txt': strToU8('5678') })
    );
    await expect(
      openArchive(
        storage,
        twoEntries,
        { ...limits, maxExpandedBytes: 6 },
        AbortSignal.timeout(5_000)
      )
    ).rejects.toMatchObject({ code: 'archive_expanded_size' });

    const largeEntry = await storeArchive(zipEntriesFixture({ 'large.txt': strToU8('1234567') }));
    await expect(
      openArchive(
        storage,
        largeEntry,
        { ...limits, maxExpandedBytes: 6 },
        AbortSignal.timeout(5_000)
      )
    ).rejects.toMatchObject({ code: 'archive_entry_size' });

    const compressed = await storeArchive(
      zipEntriesFixture({ 'compressed.txt': strToU8('a'.repeat(20_000)) })
    );
    await expect(
      openArchive(
        storage,
        compressed,
        { ...limits, maxCompressionRatio: 2 },
        AbortSignal.timeout(5_000)
      )
    ).rejects.toMatchObject({ code: 'archive_compression_ratio' });
  });

  it('rejects declared-size mismatch and truncated archive structure', async () => {
    const stored = zipEntriesFixture({ 'entry.txt': [strToU8('entry'), { level: 0 }] });
    const mismatchKey = await storeArchive(
      patchZipEntry(stored, 'entry.txt', { uncompressedSize: 6 })
    );
    await expect(
      openArchive(storage, mismatchKey, limits, AbortSignal.timeout(5_000))
    ).rejects.toMatchObject({ code: 'archive_size_mismatch' });

    const truncatedKey = await storeArchive(stored.subarray(0, stored.length - 12));
    await expect(
      openArchive(storage, truncatedKey, limits, AbortSignal.timeout(5_000))
    ).rejects.toMatchObject({ code: 'archive_structure' });
  });

  it('detects a CRC mismatch while observing entry bytes', async () => {
    const bytes = patchZipEntry(
      zipEntriesFixture({ 'entry.txt': strToU8('entry') }),
      'entry.txt',
      { crc32: 0 }
    );
    const key = await storeArchive(bytes);
    const archive = await openArchive(storage, key, limits, AbortSignal.timeout(5_000));

    await expect(collect(await archive.read(archive.entries[0]!))).rejects.toMatchObject({
      code: 'archive_crc_mismatch'
    });
    await archive.close();
  });

  it('rejects reads after abort or session close', async () => {
    const key = await storeArchive(zipEntriesFixture({ 'entry.txt': strToU8('entry') }));
    const controller = new AbortController();
    const aborted = await openArchive(storage, key, limits, controller.signal);
    controller.abort();
    await expect(aborted.read(aborted.entries[0]!)).rejects.toMatchObject({
      code: 'ingestion_aborted'
    });

    const closed = await openArchive(storage, key, limits, AbortSignal.timeout(5_000));
    await closed.close();
    await expect(closed.read(closed.entries[0]!)).rejects.toMatchObject({
      code: 'archive_closed'
    });
  });
});
