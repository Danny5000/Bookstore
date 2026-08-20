import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStorageKey } from '../storage/keys';
import { createLocalObjectStorage } from '../storage/local';
import type { ObjectStorage } from '../storage/types';
import { normalizeImage } from './image';
import type { IngestionLimits } from './limits';

const limits: IngestionLimits = Object.freeze({
  maxUploadBytes: 10_000_000,
  maxExpandedBytes: 10_000_000,
  maxEntries: 100,
  maxXmlBytes: 1_000_000,
  maxImagePixels: 1_000_000,
  maxCompressionRatio: 200,
  timeoutMs: 5_000
});

async function readBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fixture(format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff'): Promise<Buffer> {
  const image = sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } }
  });
  return image[format]().toBuffer();
}

describe('image normalization', () => {
  let root: string;
  let storage: ObjectStorage;
  let destinationSequence: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pale-orbit-image-test-'));
    storage = createLocalObjectStorage(root);
    destinationSequence = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function destinationKey() {
    destinationSequence += 1;
    return parseStorageKey(
      `titles/018f0000-0000-7000-8000-000000000010/revisions/018f0000-0000-7000-8000-000000000011/derived/v1/generations/0/prose-images/018f0000-0000-7000-8000-${destinationSequence.toString().padStart(12, '0')}.webp`
    );
  }

  it.each(['png', 'jpeg', 'webp', 'gif'] as const)(
    'normalizes EPUB %s input to verified WebP metadata',
    async (format) => {
      const destination = destinationKey();
      const normalized = await normalizeImage({
        storage,
        source: Readable.from([await fixture(format)]),
        destination,
        profile: 'epub',
        limits,
        signal: AbortSignal.timeout(5_000)
      });
      const stored = await readBuffer(await storage.read(destination));
      const metadata = await sharp(stored).metadata();

      expect(normalized).toMatchObject({
        storageKey: destination,
        mediaType: 'image/webp',
        byteSize: stored.byteLength,
        width: 3,
        height: 2
      });
      expect(normalized.checksumSha256).toBe(createHash('sha256').update(stored).digest('hex'));
      expect(normalized.semanticFingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(normalized.semanticFingerprintVersion).toBe(1);
      expect(metadata.format).toBe('webp');
    }
  );

  it('fingerprints normalized decoded pixels independently of source encoding', async () => {
    const pixels = Buffer.from([
      10, 20, 30, 255, 40, 50, 60, 255,
      70, 80, 90, 255, 100, 110, 120, 255
    ]);
    const raw = { width: 2, height: 2, channels: 4 as const };
    const png = await sharp(pixels, { raw }).png().toBuffer();
    const webp = await sharp(pixels, { raw }).webp({ lossless: true }).toBuffer();
    const changedPixels = Buffer.from(pixels);
    changedPixels[0] = 11;
    const changed = await sharp(changedPixels, { raw }).png().toBuffer();

    const normalize = async (bytes: Buffer) =>
      normalizeImage({
        storage,
        source: Readable.from([bytes]),
        destination: destinationKey(),
        profile: 'epub',
        limits,
        signal: AbortSignal.timeout(5_000)
      });
    const [fromPng, fromWebp, fromChangedPixels] = await Promise.all([
      normalize(png),
      normalize(webp),
      normalize(changed)
    ]);

    expect(fromPng.semanticFingerprintSha256).toBe(fromWebp.semanticFingerprintSha256);
    expect(fromChangedPixels.semanticFingerprintSha256).not.toBe(
      fromPng.semanticFingerprintSha256
    );
  });

  it('accepts TIFF only for comic ingestion', async () => {
    const bytes = await fixture('tiff');
    await expect(
      normalizeImage({
        storage,
        source: Readable.from([bytes]),
        destination: destinationKey(),
        profile: 'epub',
        limits,
        signal: AbortSignal.timeout(5_000)
      })
    ).rejects.toMatchObject({ code: 'unsupported_media' });

    await expect(
      normalizeImage({
        storage,
        source: Readable.from([bytes]),
        destination: destinationKey(),
        profile: 'comic',
        limits,
        signal: AbortSignal.timeout(5_000)
      })
    ).resolves.toMatchObject({ mediaType: 'image/webp', width: 3, height: 2 });
  });

  it('accepts only JPEG and PNG for standalone title covers', async () => {
    for (const format of ['jpeg', 'png'] as const) {
      await expect(
        normalizeImage({
          storage,
          source: Readable.from([await fixture(format)]),
          destination: destinationKey(),
          profile: 'cover',
          limits,
          signal: AbortSignal.timeout(5_000)
        })
      ).resolves.toMatchObject({ mediaType: 'image/webp', width: 3, height: 2 });
    }
    for (const format of ['webp', 'gif'] as const) {
      await expect(
        normalizeImage({
          storage,
          source: Readable.from([await fixture(format)]),
          destination: destinationKey(),
          profile: 'cover',
          limits,
          signal: AbortSignal.timeout(5_000)
        })
      ).rejects.toMatchObject({ code: 'unsupported_media' });
    }
  });

  it('applies EXIF orientation and strips source metadata', async () => {
    const oriented = await sharp({
      create: { width: 2, height: 3, channels: 3, background: '#884422' }
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const destination = destinationKey();

    const normalized = await normalizeImage({
      storage,
      source: Readable.from([oriented]),
      destination,
      profile: 'epub',
      limits,
      signal: AbortSignal.timeout(5_000)
    });
    const metadata = await sharp(await readBuffer(await storage.read(destination))).metadata();

    expect(normalized).toMatchObject({ width: 3, height: 2 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it('uses the first animated GIF frame and records a warning', async () => {
    const firstFrame = Buffer.from([255, 0, 0, 255]).subarray(0, 4);
    const secondFrame = Buffer.from([0, 0, 255, 255]).subarray(0, 4);
    const animated = await sharp(
      Buffer.concat([
        firstFrame,
        firstFrame,
        firstFrame,
        firstFrame,
        secondFrame,
        secondFrame,
        secondFrame,
        secondFrame
      ]),
      { raw: { width: 2, height: 4, pageHeight: 2, channels: 4 } }
    )
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer();

    const normalized = await normalizeImage({
      storage,
      source: Readable.from([animated]),
      destination: destinationKey(),
      profile: 'epub',
      limits,
      signal: AbortSignal.timeout(5_000)
    });

    expect(normalized).toMatchObject({ width: 2, height: 2 });
    expect(normalized.warnings).toEqual([
      { code: 'image_animation_first_frame', safeMessage: 'Only the first image frame was used' }
    ]);
  });

  it('rejects SVG, corrupt images, and excessive decoded pixels with stable codes', async () => {
    await expect(
      normalizeImage({
        storage,
        source: Readable.from(['<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>']),
        destination: destinationKey(),
        profile: 'epub',
        limits,
        signal: AbortSignal.timeout(5_000)
      })
    ).rejects.toMatchObject({ code: 'unsupported_media' });

    await expect(
      normalizeImage({
        storage,
        source: Readable.from([Buffer.from('not an image')]),
        destination: destinationKey(),
        profile: 'epub',
        limits,
        signal: AbortSignal.timeout(5_000)
      })
    ).rejects.toMatchObject({ code: 'image_decode' });

    await expect(
      normalizeImage({
        storage,
        source: Readable.from([
          await sharp({
            create: { width: 100, height: 100, channels: 3, background: '#000000' }
          })
            .png()
            .toBuffer()
        ]),
        destination: destinationKey(),
        profile: 'epub',
        limits: { ...limits, maxImagePixels: 1_000 },
        signal: AbortSignal.timeout(5_000)
      })
    ).rejects.toMatchObject({ code: 'image_pixels' });
  });
});
