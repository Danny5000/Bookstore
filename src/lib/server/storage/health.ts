import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { healthProbeKey } from './keys';
import type { ObjectStorage } from './types';

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

export async function probeStorage(storage: ObjectStorage): Promise<void> {
  const key = healthProbeKey(randomUUID());
  const expected = randomBytes(32);

  try {
    await storage.write(key, Readable.from([expected]), { maxBytes: 32 });
    const received = await readProbe(await storage.read(key));
    if (!received.equals(expected)) throw new Error('Storage readiness probe failed');
  } finally {
    await storage.delete(key);
  }
}
