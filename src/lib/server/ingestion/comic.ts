import { posix } from 'node:path';
import {
  revisionComicPageKey,
  revisionCoverSuggestionKey,
  type StorageKey
} from '../storage/keys';
import type { ObjectStorage } from '../storage/types';
import { openArchive, type ArchiveEntry } from './archive';
import { IngestionError, type IngestionWarning } from './errors';
import { normalizeImage, type NormalizedImage } from './image';
import type { IngestionLimits } from './limits';
import { naturalComicOrder } from './natural-order';
import { stableIngestionId } from './prose';
import { readOrderedXml } from './xml';

export interface IngestComicInput {
  storage: ObjectStorage;
  sourceKey: StorageKey;
  titleId: string;
  revisionId: string;
  limits: IngestionLimits;
  signal: AbortSignal;
}

export interface ComicPageRow extends NormalizedImage {
  id: string;
  ordinal: number;
  sourcePath: string;
}

export interface ComicCoverSuggestion extends NormalizedImage {
  id: string;
  sourceDescription: string;
}

export interface ComicIngestionResult {
  pages: readonly ComicPageRow[];
  coverSuggestion: ComicCoverSuggestion;
  warnings: readonly IngestionWarning[];
}

const allowedPageExtensions = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.tif',
  '.tiff'
]);

function comicError(
  code: 'comic_empty' | 'unsupported_media',
  safeMessage: string
): IngestionError {
  return new IngestionError(code, safeMessage, false);
}

function ignoredPlatformMetadata(entry: ArchiveEntry): boolean {
  if (entry.isDirectory) return true;
  const lowerPath = entry.path.toLocaleLowerCase('en-US');
  const basename = posix.basename(lowerPath);
  return (
    lowerPath === '__macosx' ||
    lowerPath.startsWith('__macosx/') ||
    basename === '.ds_store' ||
    basename === 'thumbs.db'
  );
}

export async function ingestComic(input: IngestComicInput): Promise<ComicIngestionResult> {
  const archive = await openArchive(input.storage, input.sourceKey, input.limits, input.signal);
  try {
    const comicInfo = archive.entries.find(
      (entry) => !entry.isDirectory && entry.path === 'ComicInfo.xml'
    );
    if (comicInfo) {
      await readOrderedXml(
        await archive.read(comicInfo),
        input.limits.maxXmlBytes,
        input.signal
      );
    }

    const pageEntries = new Map<string, ArchiveEntry>();
    for (const entry of archive.entries) {
      if (ignoredPlatformMetadata(entry) || entry.path === 'ComicInfo.xml') continue;
      const extension = posix.extname(entry.path).toLocaleLowerCase('en-US');
      if (!allowedPageExtensions.has(extension)) {
        throw comicError('unsupported_media', 'Comic archive contains an unsupported file');
      }
      pageEntries.set(entry.path, entry);
    }
    if (pageEntries.size === 0) throw comicError('comic_empty', 'Comic archive has no pages');

    const orderedPaths = naturalComicOrder([...pageEntries.keys()]);
    const warnings: IngestionWarning[] = [];
    const pages: ComicPageRow[] = [];
    for (const [index, path] of orderedPaths.entries()) {
      const entry = pageEntries.get(path);
      if (!entry) throw comicError('unsupported_media', 'Comic page path is invalid');
      const pageId = stableIngestionId(input.revisionId, path, 'comic-page', index);
      const normalized = await normalizeImage({
        storage: input.storage,
        source: await archive.read(entry),
        destination: revisionComicPageKey(input.titleId, input.revisionId, pageId),
        profile: 'comic',
        limits: input.limits,
        signal: input.signal
      });
      warnings.push(...normalized.warnings);
      pages.push({ id: pageId, ordinal: index + 1, sourcePath: path, ...normalized });
    }

    const firstPage = pages[0]!;
    const suggestionId = stableIngestionId(
      input.revisionId,
      firstPage.sourcePath,
      'cover',
      0
    );
    const suggestionKey = revisionCoverSuggestionKey(
      input.titleId,
      input.revisionId,
      suggestionId
    );
    const copied = await input.storage.copy(firstPage.storageKey, suggestionKey);
    const coverSuggestion: ComicCoverSuggestion = {
      id: suggestionId,
      sourceDescription: 'First normalized comic page',
      storageKey: suggestionKey,
      mediaType: 'image/webp',
      checksumSha256: firstPage.checksumSha256,
      byteSize: copied.byteSize,
      width: firstPage.width,
      height: firstPage.height,
      warnings: []
    };

    return {
      pages: Object.freeze(pages),
      coverSuggestion,
      warnings: Object.freeze(warnings)
    };
  } finally {
    await archive.close();
  }
}
