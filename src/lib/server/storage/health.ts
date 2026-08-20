import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  healthProbeKey,
  publicationReadinessSentinelKey,
  publicationReadinessSentinelValue,
  revisionCoverSuggestionKey,
  titleCoverKey,
  type StorageKey
} from './keys';
import type { ObjectStorage } from './types';

export type StorageProbeCapability = 'web' | 'writer';

const publicationSentinelBytes = Buffer.from(publicationReadinessSentinelValue, 'utf8');

async function readProbe(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.byteLength;
    if (byteSize > 32) throw new Error('Storage readiness probe failed');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function roundTripProbe(storage: ObjectStorage, key: StorageKey): Promise<void> {
  const expected = randomBytes(32);

  try {
    await storage.write(key, Readable.from([expected]), { maxBytes: 32 });
    const received = await readProbe(await storage.read(key));
    if (!received.equals(expected)) throw new Error('Storage readiness probe failed');
  } finally {
    await storage.delete(key);
  }
}

async function verifyProbe(
  storage: ObjectStorage,
  key: StorageKey,
  expected: Buffer
): Promise<void> {
  const received = await readProbe(await storage.read(key));
  if (!received.equals(expected)) throw new Error('Storage readiness probe failed');
}

export async function probeStorage(
  storage: ObjectStorage,
  capability: StorageProbeCapability
): Promise<void> {
  const probeId = randomUUID();
  await roundTripProbe(storage, healthProbeKey(probeId));

  const publicationSentinelKey = publicationReadinessSentinelKey();
  if (capability === 'writer') {
    await storage.write(
      publicationSentinelKey,
      Readable.from([publicationSentinelBytes]),
      {
        maxBytes: publicationSentinelBytes.byteLength,
        expectedBytes: publicationSentinelBytes.byteLength
      }
    );
  }
  await verifyProbe(storage, publicationSentinelKey, publicationSentinelBytes);

  const publicationKey = revisionCoverSuggestionKey(probeId, probeId, 0, probeId);
  if (capability === 'writer') await roundTripProbe(storage, publicationKey);

  await roundTripProbe(storage, titleCoverKey(probeId, probeId));
}
