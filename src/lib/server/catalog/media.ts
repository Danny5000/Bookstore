import { posix } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import type { AuditRequestMetadata } from '$lib/server/audit/request-metadata';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  comicPages,
  proseBlocks,
  proseImages,
  proseSections,
  revisionCoverSuggestions,
  revisionPresentations,
  titleRevisions,
  titles
} from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { closeMediaResponse, streamMediaResponse } from '$lib/server/http/media-response';
import { resolvePublicationAccess } from '$lib/server/library/access';
import { ReaderStateNotFoundError } from '$lib/server/reader-state/errors';
import { lockReaderTitle } from '$lib/server/reader-state/lock';
import { parseStorageKey, type StorageKey } from '$lib/server/storage/keys';
import type { ObjectStorage, StoredObjectStat } from '$lib/server/storage/types';

export class MediaNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super('Publication media not found');
    this.name = 'MediaNotFoundError';
  }
}

export interface ResolvedMediaAccess {
  key: StorageKey;
  stat: StoredObjectStat;
  mediaType: string;
  checksumSha256: string;
  filename: string | null;
  disposition: 'inline' | 'attachment';
  cacheControl: 'public, max-age=31536000, immutable' | 'private, no-store';
  verifyIntegrity?: boolean;
}

function isAdmin(actor: Actor): boolean {
  return actor.type === 'user' && actor.roles.includes('admin');
}

async function resolvedAccess(
  storage: ObjectStorage,
  media: {
    storageKey: string;
    mediaType: string;
    checksumSha256: string;
    byteSize: number;
  },
  publicAccess: boolean,
  filename: string | null = null,
  disposition: 'inline' | 'attachment' = 'inline',
  verifyIntegrity = false
): Promise<ResolvedMediaAccess> {
  const key = parseStorageKey(media.storageKey);
  const stat = await storage.stat(key);
  if (!stat || stat.byteSize !== media.byteSize) throw new MediaNotFoundError();
  return {
    key,
    stat,
    mediaType: media.mediaType,
    checksumSha256: media.checksumSha256,
    filename,
    disposition,
    verifyIntegrity,
    cacheControl: publicAccess
      ? 'public, max-age=31536000, immutable'
      : 'private, no-store'
  };
}

export async function resolveCoverAccess(
  database: Database,
  storage: ObjectStorage,
  actor: Actor,
  input: { titleId: string; checksum: string }
): Promise<ResolvedMediaAccess> {
  const [title] = await database
    .select({
      id: titles.id,
      visibility: titles.visibility,
      activeRevisionId: titles.activeRevisionId,
      coverStorageKey: titles.coverStorageKey,
      coverMediaType: titles.coverMediaType,
      coverChecksumSha256: titles.coverChecksumSha256,
      coverByteSize: titles.coverByteSize
    })
    .from(titles)
    .where(and(eq(titles.id, input.titleId), eq(titles.coverChecksumSha256, input.checksum)))
    .limit(1);
  if (
    !title ||
    !title.coverStorageKey ||
    !title.coverMediaType ||
    !title.coverChecksumSha256 ||
    !title.coverByteSize
  ) throw new MediaNotFoundError();

  const decision = await resolvePublicationAccess({
    db: database,
    actor,
    titleId: title.id,
    purpose: 'cover'
  });
  const administratorUnavailable = decision.level === 'unavailable' && isAdmin(actor);
  if (
    decision.level === 'denied' ||
    (decision.level === 'unavailable' && !administratorUnavailable)
  ) throw new MediaNotFoundError();
  const publicAccess = decision.level === 'preview';
  return resolvedAccess(
    storage,
    {
      storageKey: title.coverStorageKey,
      mediaType: title.coverMediaType,
      checksumSha256: title.coverChecksumSha256,
      byteSize: title.coverByteSize
    },
    publicAccess
  );
}

interface ReaderAssetRecord {
  title: {
    id: string;
    visibility: 'private' | 'public' | 'archived';
    activeRevisionId: string | null;
  };
  revision: {
    id: string;
    titleId: string;
    state: 'uploaded' | 'processing' | 'ready_for_review' | 'failed' | 'active' | 'retired';
  };
  media: {
    id: string;
    storageKey: string;
    mediaType: string;
    checksumSha256: string;
    byteSize: number;
  };
}

async function publicProseAssetAllowed(
  database: Database,
  asset: ReaderAssetRecord
): Promise<boolean> {
  const [presentation] = await database
    .select({
      id: revisionPresentations.id,
      previewProseSectionId: revisionPresentations.previewProseSectionId,
      previewProseBlockId: revisionPresentations.previewProseBlockId,
      previewComicPageId: revisionPresentations.previewComicPageId
    })
    .from(revisionPresentations)
    .where(
      and(
        eq(revisionPresentations.revisionId, asset.revision.id),
        eq(revisionPresentations.state, 'published')
      )
    )
    .limit(1);
  if (!presentation?.previewProseSectionId || !presentation.previewProseBlockId) return false;
  const sections = await database
    .select({ id: proseSections.id, ordinal: proseSections.ordinal })
    .from(proseSections)
    .where(eq(proseSections.revisionId, asset.revision.id))
    .orderBy(asc(proseSections.ordinal), asc(proseSections.id));
  const blocks = await database
    .select({
      id: proseBlocks.id,
      sectionId: proseBlocks.sectionId,
      ordinal: proseBlocks.ordinal,
      imageId: proseBlocks.imageId
    })
    .from(proseBlocks)
    .where(eq(proseBlocks.revisionId, asset.revision.id));
  for (const section of sections) {
    for (const block of blocks
      .filter((candidate) => candidate.sectionId === section.id)
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
      if (block.imageId === asset.media.id) return true;
      if (
        section.id === presentation.previewProseSectionId &&
        block.id === presentation.previewProseBlockId
      ) return false;
    }
  }
  return false;
}

async function publicComicAssetAllowed(
  database: Database,
  asset: ReaderAssetRecord
): Promise<boolean> {
  const [presentation] = await database
    .select({
      id: revisionPresentations.id,
      previewProseSectionId: revisionPresentations.previewProseSectionId,
      previewProseBlockId: revisionPresentations.previewProseBlockId,
      previewComicPageId: revisionPresentations.previewComicPageId
    })
    .from(revisionPresentations)
    .where(
      and(
        eq(revisionPresentations.revisionId, asset.revision.id),
        eq(revisionPresentations.state, 'published')
      )
    )
    .limit(1);
  if (!presentation?.previewComicPageId) return false;
  const pages = await database
    .select({ id: comicPages.id, ordinal: comicPages.ordinal })
    .from(comicPages)
    .where(eq(comicPages.revisionId, asset.revision.id))
    .orderBy(asc(comicPages.ordinal), asc(comicPages.id));
  const assetIndex = pages.findIndex((page) => page.id === asset.media.id);
  const boundaryIndex = pages.findIndex((page) => page.id === presentation.previewComicPageId);
  return assetIndex >= 0 && boundaryIndex >= 0 && assetIndex <= boundaryIndex;
}

export async function resolveReaderImageAccess(
  database: Database,
  storage: ObjectStorage,
  actor: Actor,
  input: { revisionId: string; imageId: string; checksum: string }
): Promise<ResolvedMediaAccess> {
  const [proseAsset] = await database
    .select({ title: titles, revision: titleRevisions, media: proseImages })
    .from(proseImages)
    .innerJoin(titleRevisions, eq(titleRevisions.id, proseImages.revisionId))
    .innerJoin(titles, eq(titles.id, titleRevisions.titleId))
    .where(
      and(
        eq(proseImages.id, input.imageId),
        eq(proseImages.revisionId, input.revisionId),
        eq(proseImages.checksumSha256, input.checksum)
      )
    )
    .limit(1);
  let asset: ReaderAssetRecord | undefined = proseAsset;
  let format: 'prose' | 'comic' = 'prose';
  if (!asset) {
    const [comicAsset] = await database
      .select({ title: titles, revision: titleRevisions, media: comicPages })
      .from(comicPages)
      .innerJoin(titleRevisions, eq(titleRevisions.id, comicPages.revisionId))
      .innerJoin(titles, eq(titles.id, titleRevisions.titleId))
      .where(
        and(
          eq(comicPages.id, input.imageId),
          eq(comicPages.revisionId, input.revisionId),
          eq(comicPages.checksumSha256, input.checksum)
        )
      )
      .limit(1);
    asset = comicAsset;
    format = 'comic';
  }
  if (!asset) throw new MediaNotFoundError();

  const accepted = ['ready_for_review', 'active', 'retired'].includes(asset.revision.state);
  if (isAdmin(actor) && accepted) return resolvedAccess(storage, asset.media, false);
  const decision = await resolvePublicationAccess({
    db: database,
    actor,
    titleId: asset.title.id,
    purpose: 'derived-media'
  });
  if (
    (decision.level !== 'preview' && decision.level !== 'entitled') ||
    decision.revisionId !== asset.revision.id
  ) throw new MediaNotFoundError();
  if (decision.level === 'entitled') return resolvedAccess(storage, asset.media, false);
  const allowed = format === 'prose'
    ? await publicProseAssetAllowed(database, asset)
    : await publicComicAssetAllowed(database, asset);
  if (!allowed) throw new MediaNotFoundError();
  return resolvedAccess(storage, asset.media, true);
}

export async function resolveCoverSuggestionAccess(
  database: Database,
  storage: ObjectStorage,
  actor: Actor,
  input: { revisionId: string; suggestionId: string; checksum: string }
): Promise<ResolvedMediaAccess> {
  requireCapability(actor, 'catalog.manage');
  const [asset] = await database
    .select({ revision: titleRevisions, media: revisionCoverSuggestions })
    .from(revisionCoverSuggestions)
    .innerJoin(titleRevisions, eq(titleRevisions.id, revisionCoverSuggestions.revisionId))
    .where(
      and(
        eq(revisionCoverSuggestions.id, input.suggestionId),
        eq(revisionCoverSuggestions.revisionId, input.revisionId),
        eq(revisionCoverSuggestions.checksumSha256, input.checksum)
      )
    )
    .limit(1);
  if (!asset || !['ready_for_review', 'active', 'retired'].includes(asset.revision.state)) {
    throw new MediaNotFoundError();
  }
  return resolvedAccess(storage, asset.media, false);
}

function safeDownloadFilename(value: string): string {
  const leaf = posix.basename(value.normalize('NFC').replaceAll('\\', '/'));
  const safe = [...leaf]
    .filter((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && point > 0x1f && point !== 0x7f;
    })
    .slice(0, 255)
    .join('')
    .trim();
  return safe || 'publication-download';
}

export async function resolveOriginalDownload(
  database: Database,
  storage: ObjectStorage,
  actor: Actor,
  input: {
    titleId: string;
    revisionId: string;
    correlationId: string;
    requestMetadata?: AuditRequestMetadata;
  }
): Promise<ResolvedMediaAccess> {
  requireCapability(actor, 'catalog.manage');
  return withTransaction(database, async (transaction) => {
    const [record] = await transaction
      .select({ revision: titleRevisions })
      .from(titleRevisions)
      .where(
        and(
          eq(titleRevisions.id, input.revisionId),
          eq(titleRevisions.titleId, input.titleId)
        )
      )
      .limit(1);
    const revision = record?.revision;
    if (
      !revision ||
      !['ready_for_review', 'active', 'retired'].includes(revision.state) ||
      !revision.originalStorageKey ||
      !revision.originalMimeType ||
      !revision.originalFilename ||
      !revision.originalChecksumSha256 ||
      !revision.originalByteSize
    ) throw new MediaNotFoundError();
    const access = await resolvedAccess(
      storage,
      {
        storageKey: revision.originalStorageKey,
        mediaType: revision.originalMimeType,
        checksumSha256: revision.originalChecksumSha256,
        byteSize: revision.originalByteSize
      },
      false,
      safeDownloadFilename(revision.originalFilename),
      'attachment',
      true
    );
    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.original.download',
      outcome: 'succeeded',
      resourceType: 'title_revision',
      resourceId: revision.id,
      correlationId: input.correlationId,
      ...(input.requestMetadata ? { requestMetadata: input.requestMetadata } : {}),
      after: { titleId: input.titleId, revisionId: input.revisionId }
    });
    return access;
  });
}

function customerDownloadExtension(
  format: 'prose' | 'comic',
  originalFilename: string
): 'epub' | 'cbz' | 'zip' | null {
  const extension = originalFilename.toLowerCase().match(/\.([^.]+)$/u)?.[1];
  if (format === 'prose') return extension === 'epub' ? 'epub' : null;
  return extension === 'cbz' || extension === 'zip' ? extension : null;
}

export async function streamCustomerOriginalDownload(
  database: Database,
  storage: ObjectStorage,
  actor: Actor,
  input: {
    titleId: string;
    correlationId: string;
    method: 'GET' | 'HEAD';
    rangeHeader: string | null;
  }
): Promise<Response> {
  let startedResponse: Response | undefined;
  try {
    return await withTransaction(database, async (transaction) => {
      const locked = await lockReaderTitle(transaction, actor, input.titleId);
      const [record] = await transaction
        .select({ revision: titleRevisions })
        .from(titleRevisions)
        .where(
          and(
            eq(titleRevisions.id, locked.revisionId),
            eq(titleRevisions.titleId, locked.title.id),
            eq(titleRevisions.state, 'active')
          )
        )
        .limit(1);
      const revision = record?.revision;
      if (
        !revision?.originalStorageKey ||
        !revision.originalChecksumSha256 ||
        !revision.originalMimeType ||
        !revision.originalByteSize ||
        !revision.originalFilename
      ) throw new MediaNotFoundError();
      const extension = customerDownloadExtension(
        locked.title.format,
        revision.originalFilename
      );
      if (!extension) throw new MediaNotFoundError();
      const mediaType = locked.title.format === 'prose'
        ? 'application/epub+zip'
        : extension === 'cbz'
          ? 'application/vnd.comicbook+zip'
          : 'application/zip';
      const access = await resolvedAccess(
        storage,
        {
          storageKey: revision.originalStorageKey,
          mediaType,
          checksumSha256: revision.originalChecksumSha256,
          byteSize: revision.originalByteSize
        },
        false,
        safeDownloadFilename(`${locked.title.title}.${extension}`),
        'attachment',
        true
      );
      const response = await streamMediaResponse(
        storage,
        access,
        input.method,
        input.rangeHeader
      );
      startedResponse = response;
      if (response.status !== 200 && response.status !== 206) return response;
      await appendAuditEvent(transaction, {
        actor,
        action: 'library.original.download',
        outcome: 'succeeded',
        resourceType: 'title_revision',
        resourceId: revision.id,
        correlationId: input.correlationId,
        after: {
          titleId: locked.title.id,
          activeRevisionId: revision.id,
          range: input.rangeHeader !== null
        }
      });
      return response;
    });
  } catch (cause: unknown) {
    if (startedResponse) await closeMediaResponse(startedResponse);
    if (cause instanceof ReaderStateNotFoundError) throw new MediaNotFoundError();
    throw cause;
  }
}
