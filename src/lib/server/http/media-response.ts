import { Readable } from 'node:stream';
import type { ResolvedMediaAccess } from '$lib/server/catalog/media';
import type { ObjectStorage } from '$lib/server/storage/types';
import { parseSingleRange, RangeNotSatisfiableError } from './range';

const safeMediaTypes = new Set([
  'image/webp',
  'image/jpeg',
  'image/png',
  'application/epub+zip',
  'application/zip',
  'application/vnd.comicbook+zip',
  'application/octet-stream'
]);
const responseCleanup = new WeakMap<Response, () => Promise<void>>();

export async function closeMediaResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
  await responseCleanup.get(response)?.();
}

function safeContentType(value: string): string {
  const normalized = value.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  return safeMediaTypes.has(normalized) ? normalized : 'application/octet-stream';
}

function contentDisposition(access: ResolvedMediaAccess): string {
  if (access.disposition === 'inline' || !access.filename) return 'inline';
  const ascii = [...access.filename]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && point <= 0x7e && character !== '"' && character !== '\\'
        ? character
        : '_';
    })
    .join('');
  return `attachment; filename="${ascii || 'publication-download'}"; filename*=UTF-8''${encodeURIComponent(access.filename)}`;
}

export async function streamMediaResponse(
  storage: ObjectStorage,
  access: ResolvedMediaAccess,
  method: 'GET' | 'HEAD',
  rangeHeader: string | null
): Promise<Response> {
  let range;
  try {
    range = parseSingleRange(rangeHeader, access.stat.byteSize);
  } catch (cause: unknown) {
    if (cause instanceof RangeNotSatisfiableError) {
      return new Response(null, {
        status: 416,
        headers: {
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          'content-range': `bytes */${cause.size}`,
          'x-content-type-options': 'nosniff'
        }
      });
    }
    throw cause;
  }

  const byteSize = range
    ? range.endInclusive - range.start + 1
    : access.stat.byteSize;
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': access.cacheControl,
    'content-disposition': contentDisposition(access),
    'content-length': String(byteSize),
    'content-type': safeContentType(access.mediaType),
    etag: `"${access.checksumSha256}"`,
    'x-content-type-options': 'nosniff'
  });
  if (range) {
    headers.set(
      'content-range',
      `bytes ${range.start}-${range.endInclusive}/${access.stat.byteSize}`
    );
  }
  if (method === 'HEAD') {
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const prepared = access.verifyIntegrity
    ? await storage.prepareVerifiedRead(access.key, {
        byteSize: access.stat.byteSize,
        checksumSha256: access.checksumSha256
      })
    : null;
  if (access.verifyIntegrity && !prepared) {
    throw new Error('Stored media failed integrity verification');
  }
  let source;
  try {
    source = prepared
      ? await prepared.read(range ?? undefined)
      : range
        ? await storage.readRange(access.key, range.start, range.endInclusive)
        : await storage.read(access.key);
  } catch (cause: unknown) {
    await prepared?.close();
    throw cause;
  }
  let cleanupPrepared: (() => Promise<void>) | undefined;
  if (prepared) {
    let cleanupStarted = false;
    cleanupPrepared = async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      await prepared.close();
    };
    const cleanup = () => void cleanupPrepared?.().catch(() => undefined);
    source.once('end', cleanup);
    source.once('error', cleanup);
    source.once('close', cleanup);
  }
  const response = new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers
  });
  if (cleanupPrepared) responseCleanup.set(response, cleanupPrepared);
  return response;
}
