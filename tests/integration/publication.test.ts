import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, asc, count, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  auditEvents,
  comicPages,
  comicPanelRegions,
  jobs,
  proseBlocks,
  proseSections,
  revisionCoverSuggestions,
  revisionPresentations,
  titleRevisions,
  titles,
  user,
  userRoles
} from '$lib/server/db/schema';
import {
  confirmCoverSuggestion,
  replaceTitleCover
} from '$lib/server/catalog/covers';
import {
  createPrivateTitle,
  getAdminTitleDetail,
  listAdminTitles,
  updateTitleMetadata
} from '$lib/server/catalog/titles';
import {
  publishReaderSettings,
  saveDraftPresentation
} from '$lib/server/catalog/presentations';
import {
  activatePrivateRevision,
  publishReplacementRevision,
  publishTitleToStorefront,
  rollbackRevision,
  withdrawTitle
} from '$lib/server/catalog/publication';
import { retryFailedRevision } from '$lib/server/catalog/revisions';
import type { IngestionLimits } from '$lib/server/ingestion/limits';
import {
  parseStorageKey,
  revisionCoverSuggestionKey,
  revisionComicPageKey,
  stagingUploadKey,
  titleCoversPrefix
} from '$lib/server/storage/keys';
import { createLocalObjectStorage } from '$lib/server/storage/local';
import { onePixelPng } from '../fixtures/publications';
import { databaseClient } from './database';

const admin = { type: 'user', id: randomUUID(), roles: ['admin'] } satisfies Actor;
const customer = { type: 'user', id: randomUUID(), roles: ['customer'] } satisfies Actor;
const storage = createLocalObjectStorage(process.env.STORAGE_LOCAL_ROOT!);
const limits: IngestionLimits = {
  maxUploadBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024,
  maxEntries: 1_000,
  maxXmlBytes: 1024 * 1024,
  maxImagePixels: 10_000_000,
  maxCompressionRatio: 1_000,
  timeoutMs: 30_000
};

async function createTitle(slug = `publication-${randomUUID()}`, format: 'prose' | 'comic' = 'prose') {
  return createPrivateTitle(databaseClient.db, {
    actor: admin,
    correlationId: `create-${slug}`,
    input: {
      slug,
      title: 'Original Title',
      subtitle: null,
      description: 'Original description.',
      creatorName: 'Pale Orbit',
      format,
      priceMinor: 1299,
      currency: 'USD'
    }
  });
}

async function createCoverSuggestion(titleId: string) {
  const [revision] = await databaseClient.db
    .insert(titleRevisions)
    .values({
      titleId,
      state: 'ready_for_review',
      createdByActorId: admin.id,
      changeSummary: 'Cover candidate'
    })
    .returning();
  if (!revision) throw new Error('Expected revision');
  const suggestionId = randomUUID();
  const key = revisionCoverSuggestionKey(titleId, revision.id, suggestionId);
  const bytes = await sharp(onePixelPng).webp().toBuffer();
  await storage.write(key, Readable.from(bytes), { maxBytes: limits.maxUploadBytes });
  const [suggestion] = await databaseClient.db
    .insert(revisionCoverSuggestions)
    .values({
      id: suggestionId,
      revisionId: revision.id,
      storageKey: key,
      sourceDescription: 'Test suggestion',
      mediaType: 'image/webp',
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.byteLength,
      width: 1,
      height: 1
    })
    .returning();
  if (!suggestion) throw new Error('Expected suggestion');
  return { revision, suggestion, bytes };
}

async function persistAdminRole(): Promise<void> {
  if (admin.type !== 'user') throw new Error('Expected user administrator');
  await databaseClient.db
    .insert(user)
    .values({
      id: admin.id,
      name: 'Publication Administrator',
      email: 'publication-admin@example.com',
      emailVerified: true
    })
    .onConflictDoNothing();
  await databaseClient.db
    .insert(userRoles)
    .values({ userId: admin.id, role: 'admin' })
    .onConflictDoNothing();
}

async function createProsePresentation(
  slug = `prose-presentation-${randomUUID()}`,
  existingTitle?: Awaited<ReturnType<typeof createTitle>>
) {
  const title = existingTitle ?? await createTitle(slug, 'prose');
  const [revision] = await databaseClient.db
    .insert(titleRevisions)
    .values({
      titleId: title.id,
      state: 'ready_for_review',
      createdByActorId: admin.type === 'user' ? admin.id : 'admin',
      changeSummary: 'Ready prose'
    })
    .returning();
  if (!revision) throw new Error('Expected revision');
  const sections = [
    { id: randomUUID(), revisionId: revision.id, ordinal: 0, label: 'One', sourceReference: 'one.xhtml' },
    { id: randomUUID(), revisionId: revision.id, ordinal: 1, label: 'Two', sourceReference: 'two.xhtml' }
  ];
  await databaseClient.db.insert(proseSections).values(sections);
  const blocks = [
    { id: randomUUID(), revisionId: revision.id, sectionId: sections[0]!.id, ordinal: 0 },
    { id: randomUUID(), revisionId: revision.id, sectionId: sections[0]!.id, ordinal: 1 },
    { id: randomUUID(), revisionId: revision.id, sectionId: sections[1]!.id, ordinal: 0 }
  ].map((block) => ({
    ...block,
    kind: 'paragraph' as const,
    content: { kind: 'paragraph' as const, fragments: [{ text: 'Text', marks: [] }] },
    imageId: null
  }));
  await databaseClient.db.insert(proseBlocks).values(blocks);
  const [presentation] = await databaseClient.db
    .insert(revisionPresentations)
    .values({ revisionId: revision.id, state: 'draft' })
    .returning();
  if (!presentation) throw new Error('Expected presentation');
  return { title, revision, sections, blocks, presentation };
}

async function publishProseSettings(
  existingTitle?: Awaited<ReturnType<typeof createTitle>>,
  slug = `published-prose-${randomUUID()}`
) {
  const candidate = await createProsePresentation(slug, existingTitle);
  const draft = await saveDraftPresentation(databaseClient.db, {
    actor: admin,
    correlationId: `save-${slug}`,
    input: proseDraftInput(candidate)
  });
  await persistAdminRole();
  const published = await publishReaderSettings(databaseClient.db, {
    actor: admin,
    correlationId: `publish-settings-${slug}`,
    input: {
      titleId: candidate.title.id,
      revisionId: candidate.revision.id,
      presentationId: draft.id,
      expectedUpdatedAt: draft.updatedAt
    }
  });
  return { ...candidate, published };
}

async function createComicPresentation(slug = `comic-presentation-${randomUUID()}`) {
  const title = await createTitle(slug, 'comic');
  const [revision] = await databaseClient.db
    .insert(titleRevisions)
    .values({
      titleId: title.id,
      state: 'ready_for_review',
      createdByActorId: admin.type === 'user' ? admin.id : 'admin',
      changeSummary: 'Ready comic'
    })
    .returning();
  if (!revision) throw new Error('Expected revision');
  const pages = [1, 2, 3].map((ordinal) => {
    const id = randomUUID();
    return {
      id,
      revisionId: revision.id,
      ordinal,
      sourcePath: `page-${ordinal}.png`,
      storageKey: revisionComicPageKey(title.id, revision.id, id),
      mediaType: 'image/webp',
      checksumSha256: String(ordinal).repeat(64),
      byteSize: 100,
      width: 100,
      height: 150
    };
  });
  await databaseClient.db.insert(comicPages).values(pages);
  const [presentation] = await databaseClient.db
    .insert(revisionPresentations)
    .values({ revisionId: revision.id, state: 'draft' })
    .returning();
  if (!presentation) throw new Error('Expected presentation');
  return { title, revision, pages, presentation };
}

function proseDraftInput(candidate: Awaited<ReturnType<typeof createProsePresentation>>) {
  return {
    titleId: candidate.title.id,
    revisionId: candidate.revision.id,
    presentationId: candidate.presentation.id,
    expectedUpdatedAt: candidate.presentation.updatedAt,
    format: 'prose' as const,
    readingDirection: 'ltr' as const,
    guidedViewEnabled: false as const,
    previewSectionId: candidate.sections[0]!.id,
    previewBlockId: candidate.blocks[1]!.id,
    previewPageId: null,
    panels: []
  };
}

function comicDraftInput(
  candidate: Awaited<ReturnType<typeof createComicPresentation>>,
  guidedViewEnabled: boolean,
  panels = candidate.pages.map((page) => ({
    pageId: page.id,
    ordinal: 1,
    x: 0,
    y: 0,
    width: 1,
    height: 1
  }))
) {
  return {
    titleId: candidate.title.id,
    revisionId: candidate.revision.id,
    presentationId: candidate.presentation.id,
    expectedUpdatedAt: candidate.presentation.updatedAt,
    format: 'comic' as const,
    readingDirection: 'ltr' as const,
    guidedViewEnabled,
    previewSectionId: null,
    previewBlockId: null,
    previewPageId: candidate.pages[1]!.id,
    panels
  };
}

describe('title metadata and covers', () => {
  it('updates strict metadata with authorization, audit, and immediate admin queries', async () => {
    const title = await createTitle('metadata-title');

    const updated = await updateTitleMetadata(databaseClient.db, {
      actor: admin,
      correlationId: 'update-metadata',
      input: {
        titleId: title.id,
        slug: 'metadata-title-revised',
        title: 'Revised Title',
        subtitle: 'A subtitle',
        description: 'Revised description.',
        creatorName: 'Revised Creator',
        priceMinor: 1599,
        currency: 'usd'
      }
    });

    expect(updated).toMatchObject({
      id: title.id,
      slug: 'metadata-title-revised',
      title: 'Revised Title',
      format: 'prose',
      priceMinor: 1599,
      currency: 'USD'
    });
    await expect(getAdminTitleDetail(databaseClient.db, title.id)).resolves.toMatchObject(updated);
    await expect(listAdminTitles(databaseClient.db)).resolves.toEqual([
      expect.objectContaining({ id: title.id, slug: 'metadata-title-revised' })
    ]);
    const [event] = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'catalog.title.update'));
    expect(event).toMatchObject({ actorId: admin.id, resourceId: title.id, outcome: 'succeeded' });
  });

  it('rejects unauthorized or format-changing metadata without writing', async () => {
    const title = await createTitle('protected-metadata');
    const input = {
      titleId: title.id,
      slug: title.slug,
      title: 'Changed',
      subtitle: null,
      description: title.description,
      creatorName: title.creatorName,
      priceMinor: title.priceMinor,
      currency: title.currency
    };

    await expect(
      updateTitleMetadata(databaseClient.db, { actor: customer, correlationId: 'denied', input })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      updateTitleMetadata(databaseClient.db, {
        actor: admin,
        correlationId: 'format-change',
        input: { ...input, format: 'comic' } as never
      })
    ).rejects.toThrow();
    await expect(getAdminTitleDetail(databaseClient.db, title.id)).resolves.toMatchObject({
      title: 'Original Title',
      format: 'prose'
    });
  });

  it('confirms a same-revision suggestion by copying it to a title cover', async () => {
    const title = await createTitle('suggestion-cover');
    const { revision, suggestion, bytes } = await createCoverSuggestion(title.id);

    const result = await confirmCoverSuggestion(databaseClient.db, storage, {
      actor: admin,
      correlationId: 'confirm-suggestion',
      input: { titleId: title.id, revisionId: revision.id, suggestionId: suggestion.id }
    });

    expect(result).toEqual({ titleId: title.id, checksumSha256: suggestion.checksumSha256 });
    const [updated] = await databaseClient.db.select().from(titles).where(eq(titles.id, title.id));
    expect(updated).toMatchObject({
      coverMediaType: 'image/webp',
      coverChecksumSha256: suggestion.checksumSha256,
      coverByteSize: suggestion.byteSize,
      coverWidth: 1,
      coverHeight: 1
    });
    expect(updated?.coverStorageKey).not.toBe(suggestion.storageKey);
    const copied = await storage.read(parseStorageKey(updated!.coverStorageKey!));
    const chunks: Buffer[] = [];
    for await (const chunk of copied) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });

  it('rejects a suggestion from another title without changing either cover', async () => {
    const sourceTitle = await createTitle('source-cover-title');
    const targetTitle = await createTitle('target-cover-title');
    const { revision, suggestion } = await createCoverSuggestion(sourceTitle.id);

    await expect(
      confirmCoverSuggestion(databaseClient.db, storage, {
        actor: admin,
        correlationId: 'cross-title-suggestion',
        input: { titleId: targetTitle.id, revisionId: revision.id, suggestionId: suggestion.id }
      })
    ).rejects.toMatchObject({ code: 'cover_suggestion_not_found' });
    const rows = await databaseClient.db.select().from(titles);
    expect(rows.every((row) => row.coverStorageKey === null)).toBe(true);
  });

  it('normalizes a standalone PNG before updating the title pointer', async () => {
    const title = await createTitle('standalone-cover');
    const sourceKey = stagingUploadKey(randomUUID());
    await storage.write(sourceKey, Readable.from(onePixelPng), { maxBytes: limits.maxUploadBytes });

    const result = await replaceTitleCover(databaseClient.db, storage, limits, {
      actor: admin,
      correlationId: 'replace-cover',
      input: { titleId: title.id, sourceKey },
      signal: new AbortController().signal
    });

    const [updated] = await databaseClient.db.select().from(titles).where(eq(titles.id, title.id));
    expect(result).toEqual({ titleId: title.id, checksumSha256: updated?.coverChecksumSha256 });
    expect(updated).toMatchObject({ coverMediaType: 'image/webp', coverWidth: 1, coverHeight: 1 });
    expect(updated?.coverStorageKey).toMatch(new RegExp(`^titles/${title.id}/covers/`));
  });

  it('leaves an unreferenced delayed-cleanup cover when the pointer transaction fails', async () => {
    const title = await createTitle('cover-rollback');
    const sourceKey = stagingUploadKey(randomUUID());
    await storage.write(sourceKey, Readable.from(onePixelPng), { maxBytes: limits.maxUploadBytes });
    await databaseClient.pool.query(`
      create function reject_plan4_cover_update() returns trigger language plpgsql as $$
      begin
        if new.cover_storage_key is not null then raise exception 'forced cover update failure'; end if;
        return new;
      end $$;
      create trigger reject_plan4_cover_update_trigger before update on titles
      for each row execute function reject_plan4_cover_update();
    `);
    try {
      await expect(
        replaceTitleCover(databaseClient.db, storage, limits, {
          actor: admin,
          correlationId: 'cover-rollback',
          input: { titleId: title.id, sourceKey },
          signal: new AbortController().signal
        })
      ).rejects.toThrow();
    } finally {
      await databaseClient.pool.query('drop trigger reject_plan4_cover_update_trigger on titles');
      await databaseClient.pool.query('drop function reject_plan4_cover_update()');
    }

    const [unchanged] = await databaseClient.db.select().from(titles).where(eq(titles.id, title.id));
    expect(unchanged?.coverStorageKey).toBeNull();
    const orphanPage = await storage.listPrefix(titleCoversPrefix(title.id), { limit: 10 });
    expect(orphanPage.objects).toHaveLength(1);
    const [coverAuditCount] = await databaseClient.db
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.correlationId, 'cover-rollback'));
    expect(coverAuditCount?.value).toBe(0);
  });
});

describe('reader presentation drafts and publication', () => {
  it('saves a valid prose boundary but rejects stale tabs and the final work unit', async () => {
    const candidate = await createProsePresentation();
    const input = proseDraftInput(candidate);

    const saved = await saveDraftPresentation(databaseClient.db, {
      actor: admin,
      correlationId: 'save-prose-draft',
      input
    });
    expect(saved).toMatchObject({
      id: candidate.presentation.id,
      previewProseSectionId: candidate.sections[0]!.id,
      previewProseBlockId: candidate.blocks[1]!.id
    });
    await expect(
      saveDraftPresentation(databaseClient.db, {
        actor: admin,
        correlationId: 'stale-prose-draft',
        input
      })
    ).rejects.toMatchObject({ code: 'stale_presentation' });
    await expect(
      saveDraftPresentation(databaseClient.db, {
        actor: admin,
        correlationId: 'full-prose-preview',
        input: {
          ...input,
          expectedUpdatedAt: saved.updatedAt,
          previewSectionId: candidate.sections[1]!.id,
          previewBlockId: candidate.blocks[2]!.id
        }
      })
    ).rejects.toMatchObject({ code: 'invalid_preview_boundary' });
  });

  it('accepts only editable revisions and same-revision boundaries', async () => {
    const candidate = await createProsePresentation();
    await databaseClient.db
      .update(titleRevisions)
      .set({ state: 'uploaded' })
      .where(eq(titleRevisions.id, candidate.revision.id));
    await expect(
      saveDraftPresentation(databaseClient.db, {
        actor: admin,
        correlationId: 'not-editable',
        input: proseDraftInput(candidate)
      })
    ).rejects.toMatchObject({ code: 'revision_not_editable' });

    const other = await createProsePresentation();
    await databaseClient.db
      .update(titleRevisions)
      .set({ state: 'ready_for_review' })
      .where(eq(titleRevisions.id, candidate.revision.id));
    await expect(
      saveDraftPresentation(databaseClient.db, {
        actor: admin,
        correlationId: 'cross-revision-boundary',
        input: {
          ...proseDraftInput(candidate),
          previewSectionId: other.sections[0]!.id,
          previewBlockId: other.blocks[0]!.id
        }
      })
    ).rejects.toMatchObject({ code: 'invalid_preview_boundary' });
  });

  it('replaces comic panels atomically and rejects a page from another revision', async () => {
    const candidate = await createComicPresentation();
    const saved = await saveDraftPresentation(databaseClient.db, {
      actor: admin,
      correlationId: 'save-comic-panels',
      input: comicDraftInput(candidate, true)
    });
    const before = await databaseClient.db
      .select()
      .from(comicPanelRegions)
      .where(eq(comicPanelRegions.presentationId, candidate.presentation.id));
    expect(before).toHaveLength(3);
    const other = await createComicPresentation();

    await expect(
      saveDraftPresentation(databaseClient.db, {
        actor: admin,
        correlationId: 'cross-revision-panel',
        input: {
          ...comicDraftInput(candidate, true),
          expectedUpdatedAt: saved.updatedAt,
          panels: [
            {
              pageId: other.pages[0]!.id,
              ordinal: 1,
              x: 0,
              y: 0,
              width: 1,
              height: 1
            }
          ]
        }
      })
    ).rejects.toMatchObject({ code: 'invalid_panel_page' });
    const after = await databaseClient.db
      .select()
      .from(comicPanelRegions)
      .where(eq(comicPanelRegions.presentationId, candidate.presentation.id));
    expect(after).toEqual(before);
  });

  it('requires complete panels only when publishing guided comic view', async () => {
    const candidate = await createComicPresentation();
    const saved = await saveDraftPresentation(databaseClient.db, {
      actor: admin,
      correlationId: 'save-incomplete-guided',
      input: comicDraftInput(candidate, true, [
        { pageId: candidate.pages[0]!.id, ordinal: 1, x: 0, y: 0, width: 1, height: 1 }
      ])
    });
    await persistAdminRole();

    await expect(
      publishReaderSettings(databaseClient.db, {
        actor: admin,
        correlationId: 'publish-incomplete-guided',
        input: {
          titleId: candidate.title.id,
          revisionId: candidate.revision.id,
          presentationId: saved.id,
          expectedUpdatedAt: saved.updatedAt
        }
      })
    ).rejects.toMatchObject({ code: 'incomplete_guided_view' });

    const wholePageCandidate = await createComicPresentation();
    const wholePage = await saveDraftPresentation(databaseClient.db, {
      actor: admin,
      correlationId: 'save-whole-page',
      input: comicDraftInput(wholePageCandidate, false, [])
    });
    await expect(
      publishReaderSettings(databaseClient.db, {
        actor: admin,
        correlationId: 'publish-whole-page',
        input: {
          titleId: wholePageCandidate.title.id,
          revisionId: wholePageCandidate.revision.id,
          presentationId: wholePage.id,
          expectedUpdatedAt: wholePage.updatedAt
        }
      })
    ).resolves.toMatchObject({ state: 'published' });
  });

  it('atomically promotes, supersedes, and clones settings with their panels', async () => {
    const candidate = await createComicPresentation();
    const firstDraft = await saveDraftPresentation(databaseClient.db, {
      actor: admin,
      correlationId: 'save-complete-guided',
      input: comicDraftInput(candidate, true)
    });
    await persistAdminRole();
    const firstPublished = await publishReaderSettings(databaseClient.db, {
      actor: admin,
      correlationId: 'publish-first-settings',
      input: {
        titleId: candidate.title.id,
        revisionId: candidate.revision.id,
        presentationId: firstDraft.id,
        expectedUpdatedAt: firstDraft.updatedAt
      }
    });
    const [clonedDraft] = await databaseClient.db
      .select()
      .from(revisionPresentations)
      .where(
        and(
          eq(revisionPresentations.revisionId, candidate.revision.id),
          eq(revisionPresentations.state, 'draft')
        )
      );
    expect(clonedDraft).toBeTruthy();
    expect(
      await databaseClient.db
        .select()
        .from(comicPanelRegions)
        .where(eq(comicPanelRegions.presentationId, clonedDraft!.id))
    ).toHaveLength(3);

    const secondPublished = await publishReaderSettings(databaseClient.db, {
      actor: admin,
      correlationId: 'publish-second-settings',
      input: {
        titleId: candidate.title.id,
        revisionId: candidate.revision.id,
        presentationId: clonedDraft!.id,
        expectedUpdatedAt: clonedDraft!.updatedAt
      }
    });
    expect(secondPublished.id).not.toBe(firstPublished.id);
    const presentations = await databaseClient.db
      .select()
      .from(revisionPresentations)
      .where(eq(revisionPresentations.revisionId, candidate.revision.id))
      .orderBy(asc(revisionPresentations.createdAt));
    expect(presentations.filter((value) => value.state === 'superseded')).toHaveLength(1);
    expect(presentations.filter((value) => value.state === 'published')).toHaveLength(1);
    expect(presentations.filter((value) => value.state === 'draft')).toHaveLength(1);
    const events = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'catalog.reader_settings.publish'));
    expect(events).toHaveLength(2);
  });
});

describe('reviewed publication lifecycle', () => {
  it('activates a reviewed revision privately and explicitly publishes and withdraws it', async () => {
    const candidate = await publishProseSettings();

    await activatePrivateRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'activate-private',
      input: { titleId: candidate.title.id, revisionId: candidate.revision.id }
    });
    let [title] = await databaseClient.db.select().from(titles).where(eq(titles.id, candidate.title.id));
    expect(title).toMatchObject({ visibility: 'private', activeRevisionId: candidate.revision.id });
    await expect(
      publishTitleToStorefront(databaseClient.db, {
        actor: admin,
        correlationId: 'publish-storefront',
        input: { titleId: candidate.title.id }
      })
    ).resolves.toMatchObject({ visibility: 'public' });
    await expect(
      withdrawTitle(databaseClient.db, {
        actor: admin,
        correlationId: 'withdraw-title',
        input: { titleId: candidate.title.id }
      })
    ).resolves.toMatchObject({ visibility: 'private', activeRevisionId: candidate.revision.id });
    await expect(
      publishTitleToStorefront(databaseClient.db, {
        actor: admin,
        correlationId: 'republish-storefront',
        input: { titleId: candidate.title.id }
      })
    ).resolves.toMatchObject({ visibility: 'public' });
    [title] = await databaseClient.db.select().from(titles).where(eq(titles.id, candidate.title.id));
    expect(title?.activeRevisionId).toBe(candidate.revision.id);
  });

  it('replaces privately, requires the explicit public replacement command, and rolls back', async () => {
    const first = await publishProseSettings();
    await activatePrivateRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'activate-first',
      input: { titleId: first.title.id, revisionId: first.revision.id }
    });
    const privateReplacement = await publishProseSettings(first.title, 'private-replacement');
    await activatePrivateRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'activate-private-replacement',
      input: { titleId: first.title.id, revisionId: privateReplacement.revision.id }
    });
    const [retiredFirst] = await databaseClient.db
      .select()
      .from(titleRevisions)
      .where(eq(titleRevisions.id, first.revision.id));
    expect(retiredFirst?.state).toBe('retired');
    await publishTitleToStorefront(databaseClient.db, {
      actor: admin,
      correlationId: 'publish-current',
      input: { titleId: first.title.id }
    });

    const publicReplacement = await publishProseSettings(first.title, 'public-replacement');
    await expect(
      activatePrivateRevision(databaseClient.db, {
        actor: admin,
        correlationId: 'forbidden-generic-public-activation',
        input: { titleId: first.title.id, revisionId: publicReplacement.revision.id }
      })
    ).rejects.toMatchObject({ code: 'publication_precondition' });
    await publishReplacementRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'publish-replacement',
      input: { titleId: first.title.id, revisionId: publicReplacement.revision.id }
    });
    let [title] = await databaseClient.db.select().from(titles).where(eq(titles.id, first.title.id));
    expect(title).toMatchObject({ visibility: 'public', activeRevisionId: publicReplacement.revision.id });

    await rollbackRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'rollback-replacement',
      input: { titleId: first.title.id, revisionId: privateReplacement.revision.id }
    });
    [title] = await databaseClient.db.select().from(titles).where(eq(titles.id, first.title.id));
    expect(title).toMatchObject({ visibility: 'public', activeRevisionId: privateReplacement.revision.id });
    const [rolledBackFrom] = await databaseClient.db
      .select()
      .from(titleRevisions)
      .where(eq(titleRevisions.id, publicReplacement.revision.id));
    expect(rolledBackFrom?.state).toBe('retired');
  });

  it('never changes the confirmed cover during activation, replacement, or rollback', async () => {
    const first = await publishProseSettings();
    const { revision, suggestion } = await createCoverSuggestion(first.title.id);
    await confirmCoverSuggestion(databaseClient.db, storage, {
      actor: admin,
      correlationId: 'confirm-lifecycle-cover',
      input: { titleId: first.title.id, revisionId: revision.id, suggestionId: suggestion.id }
    });
    const [covered] = await databaseClient.db.select().from(titles).where(eq(titles.id, first.title.id));
    const coverSnapshot = {
      key: covered?.coverStorageKey,
      checksum: covered?.coverChecksumSha256,
      updatedAt: covered?.coverUpdatedAt
    };
    await activatePrivateRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'cover-activate',
      input: { titleId: first.title.id, revisionId: first.revision.id }
    });
    await publishTitleToStorefront(databaseClient.db, {
      actor: admin,
      correlationId: 'cover-publish',
      input: { titleId: first.title.id }
    });
    const replacement = await publishProseSettings(first.title, 'cover-replacement');
    await publishReplacementRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'cover-replace',
      input: { titleId: first.title.id, revisionId: replacement.revision.id }
    });
    await rollbackRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'cover-rollback-revision',
      input: { titleId: first.title.id, revisionId: first.revision.id }
    });
    const [after] = await databaseClient.db.select().from(titles).where(eq(titles.id, first.title.id));
    expect({
      key: after?.coverStorageKey,
      checksum: after?.coverChecksumSha256,
      updatedAt: after?.coverUpdatedAt
    }).toEqual(coverSnapshot);
  });

  it('rechecks the current admin role after locking and serializes duplicate replacements', async () => {
    const first = await publishProseSettings();
    await activatePrivateRevision(databaseClient.db, {
      actor: admin,
      correlationId: 'concurrent-activate',
      input: { titleId: first.title.id, revisionId: first.revision.id }
    });
    await publishTitleToStorefront(databaseClient.db, {
      actor: admin,
      correlationId: 'concurrent-publish',
      input: { titleId: first.title.id }
    });
    const replacement = await publishProseSettings(first.title, 'concurrent-replacement');
    const attempts = await Promise.allSettled([
      publishReplacementRevision(databaseClient.db, {
        actor: admin,
        correlationId: 'replacement-a',
        input: { titleId: first.title.id, revisionId: replacement.revision.id }
      }),
      publishReplacementRevision(databaseClient.db, {
        actor: admin,
        correlationId: 'replacement-b',
        input: { titleId: first.title.id, revisionId: replacement.revision.id }
      })
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(
      await databaseClient.db
        .select()
        .from(titleRevisions)
        .where(eq(titleRevisions.state, 'active'))
    ).toHaveLength(1);

    await databaseClient.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, admin.id), eq(userRoles.role, 'admin')));
    await expect(
      withdrawTitle(databaseClient.db, {
        actor: admin,
        correlationId: 'demoted-withdraw',
        input: { titleId: first.title.id }
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const [title] = await databaseClient.db.select().from(titles).where(eq(titles.id, first.title.id));
    expect(title?.visibility).toBe('public');
  });
});

describe('failed revision retry', () => {
  it('copies the retained staged source and enqueues a new immutable generation', async () => {
    const title = await createTitle('retry-revision');
    await persistAdminRole();
    const oldKey = stagingUploadKey(randomUUID());
    const bytes = Buffer.from('retry source bytes');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await storage.write(oldKey, Readable.from(bytes), { maxBytes: limits.maxUploadBytes });
    const [failed] = await databaseClient.db
      .insert(titleRevisions)
      .values({
        titleId: title.id,
        state: 'failed',
        createdByActorId: admin.id,
        changeSummary: 'Failed candidate',
        stagingStorageKey: oldKey,
        stagingChecksumSha256: digest,
        stagingByteSize: bytes.byteLength,
        uploadFilename: 'retry.epub',
        uploadMimeType: 'application/epub+zip',
        failureCode: 'archive_structure',
        failureDetails: 'Archive is invalid',
        processedAt: new Date()
      })
      .returning();
    if (!failed) throw new Error('Expected failed revision');

    const retried = await retryFailedRevision(databaseClient.db, storage, {
      actor: admin,
      correlationId: 'retry-failed',
      input: { titleId: title.id, revisionId: failed.id }
    });

    expect(retried).toMatchObject({
      id: failed.id,
      state: 'uploaded',
      ingestionGeneration: 1,
      failureCode: null,
      failureDetails: null,
      processedAt: null
    });
    expect(retried.stagingStorageKey).not.toBe(oldKey);
    const [job] = await databaseClient.db
      .select()
      .from(jobs)
      .where(eq(jobs.deduplicationKey, `catalog.ingest:${failed.id}:1`));
    expect(job?.payload).toEqual({ revisionId: failed.id, generation: 1 });
    expect(await storage.stat(parseStorageKey(retried.stagingStorageKey!))).toMatchObject({
      byteSize: bytes.byteLength
    });
  });

  it('rejects retry when no staged source remains', async () => {
    const title = await createTitle('retry-without-source');
    await persistAdminRole();
    const [failed] = await databaseClient.db
      .insert(titleRevisions)
      .values({
        titleId: title.id,
        state: 'failed',
        createdByActorId: admin.id,
        changeSummary: 'No source',
        failureCode: 'archive_structure',
        failureDetails: 'Archive is invalid'
      })
      .returning();
    if (!failed) throw new Error('Expected failed revision');
    await expect(
      retryFailedRevision(databaseClient.db, storage, {
        actor: admin,
        correlationId: 'retry-no-source',
        input: { titleId: title.id, revisionId: failed.id }
      })
    ).rejects.toMatchObject({ code: 'retry_source_unavailable' });
  });
});
