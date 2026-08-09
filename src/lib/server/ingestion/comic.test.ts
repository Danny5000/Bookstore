import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { strToU8 } from 'fflate';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  onePixelPng,
  validComicFixture
} from '../../../../tests/fixtures/publications';
import { stagingUploadKey } from '../storage/keys';
import { createLocalObjectStorage } from '../storage/local';
import type { ObjectStorage } from '../storage/types';
import { ingestComic } from './comic';
import type { IngestionLimits } from './limits';

const titleId = '018f0000-0000-7000-8000-000000000010';
const revisionId = '018f0000-0000-7000-8000-000000000011';
const limits: IngestionLimits = Object.freeze({
  maxUploadBytes: 20_000_000,
  maxExpandedBytes: 30_000_000,
  maxEntries: 1_000,
  maxXmlBytes: 1_000_000,
  maxImagePixels: 100_000_000,
  maxCompressionRatio: 1_000,
  timeoutMs: 5_000
});

async function imageFixture(format: 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff'): Promise<Buffer> {
  return sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } }
  })[format]().toBuffer();
}

describe('comic archive ingestion', () => {
  let root: string;
  let storage: ObjectStorage;
  let uploadSequence: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pale-orbit-comic-test-'));
    storage = createLocalObjectStorage(root);
    uploadSequence = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function ingest(bytes: Buffer) {
    uploadSequence += 1;
    const sourceKey = stagingUploadKey(
      `018f0000-0000-7000-8000-${uploadSequence.toString().padStart(12, '0')}`
    );
    await storage.write(sourceKey, Readable.from([bytes]), { maxBytes: limits.maxUploadBytes });
    return ingestComic({
      storage,
      sourceKey,
      titleId,
      revisionId,
      limits,
      signal: AbortSignal.timeout(5_000)
    });
  }

  it('ignores safe metadata and orders pages independently of ZIP entry order', async () => {
    const result = await ingest(validComicFixture());

    expect(result.pages.map(({ ordinal, sourcePath }) => ({ ordinal, sourcePath }))).toEqual([
      { ordinal: 1, sourcePath: 'page-1.png' },
      { ordinal: 2, sourcePath: 'page-2.png' },
      { ordinal: 3, sourcePath: 'page-10.png' }
    ]);
    expect(result.pages.every((page) => page.mediaType === 'image/webp')).toBe(true);
    expect(result.pages.every((page) => page.width === 1 && page.height === 1)).toBe(true);
    expect(result.coverSuggestion).toMatchObject({
      sourceDescription: 'First normalized comic page',
      checksumSha256: result.pages[0]!.checksumSha256,
      byteSize: result.pages[0]!.byteSize,
      width: 1,
      height: 1
    });
    expect(result.warnings).toEqual([]);
  });

  it('normalizes JPEG, PNG, WebP, GIF, and TIFF pages sequentially', async () => {
    const result = await ingest(
      validComicFixture({
        '5.tiff': await imageFixture('tiff'),
        '1.jpeg': await imageFixture('jpeg'),
        '4.gif': await imageFixture('gif'),
        '2.png': await imageFixture('png'),
        '3.webp': await imageFixture('webp')
      })
    );

    expect(result.pages.map((page) => page.sourcePath)).toEqual([
      '1.jpeg',
      '2.png',
      '3.webp',
      '4.gif',
      '5.tiff'
    ]);
    expect(result.pages.map((page) => page.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it('uses the first animated frame and retains a safe warning', async () => {
    const red = Buffer.from([255, 0, 0, 255]);
    const blue = Buffer.from([0, 0, 255, 255]);
    const animated = await sharp(
      Buffer.concat([red, red, red, red, blue, blue, blue, blue]),
      { raw: { width: 2, height: 4, pageHeight: 2, channels: 4 } }
    )
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer();

    const result = await ingest(validComicFixture({ '1.gif': animated }));

    expect(result.pages[0]).toMatchObject({ width: 2, height: 2 });
    expect(result.warnings).toEqual([
      { code: 'image_animation_first_frame', safeMessage: 'Only the first image frame was used' }
    ]);
  });

  it('rejects empty, SVG, corrupt, ambiguous, and unsupported archives with stable codes', async () => {
    const fixtures = [
      [
        validComicFixture({
          '__MACOSX/metadata': strToU8('ignored'),
          '.DS_Store': strToU8('ignored'),
          'ComicInfo.xml': strToU8('<ComicInfo/>')
        }),
        'comic_empty'
      ],
      [validComicFixture({ '1.svg': strToU8('<svg/>') }), 'unsupported_media'],
      [validComicFixture({ '1.png': Buffer.from('corrupt') }), 'image_decode'],
      [
        validComicFixture({ 'page-01.png': onePixelPng, 'page-1.png': onePixelPng }),
        'comic_ambiguous_page_order'
      ],
      [validComicFixture({ 'notes.txt': strToU8('not a page') }), 'unsupported_media']
    ] as const;

    for (const [fixture, code] of fixtures) {
      await expect(ingest(fixture)).rejects.toMatchObject({ code, retryable: false });
    }
  });

  it('validates bounded root ComicInfo.xml without trusting its values', async () => {
    await expect(
      ingest(
        validComicFixture({
          '1.png': onePixelPng,
          'ComicInfo.xml': strToU8('<!DOCTYPE ComicInfo><ComicInfo/>')
        })
      )
    ).rejects.toMatchObject({ code: 'xml_unsafe_declaration' });
  });

  it('rejects pages that exceed the decoded pixel limit', async () => {
    const large = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#000' }
    })
      .png()
      .toBuffer();
    const sourceKey = stagingUploadKey('018f0000-0000-7000-8000-000000000099');
    await storage.write(sourceKey, Readable.from([validComicFixture({ '1.png': large })]), {
      maxBytes: limits.maxUploadBytes
    });

    await expect(
      ingestComic({
        storage,
        sourceKey,
        titleId,
        revisionId,
        limits: { ...limits, maxImagePixels: 1_000 },
        signal: AbortSignal.timeout(5_000)
      })
    ).rejects.toMatchObject({ code: 'image_pixels' });
  });
});
