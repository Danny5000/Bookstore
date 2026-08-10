import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  comicPages,
  comicPanelRegions,
  entitlements,
  proseBlocks,
  proseSections,
  readerBookmarks,
  readerProgress,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { StaleReaderStateError } from '$lib/server/reader-state/errors';
import {
  createBookmark,
  deleteBookmark,
  getReaderInitialState,
  saveProgress,
  saveReaderPreferences,
  saveReaderTitlePreferences
} from '$lib/server/reader-state/service';
import { databaseClient } from './database';

async function createCustomer(label: string): Promise<Extract<Actor, { type: 'user' }>> {
  const id = randomUUID();
  await databaseClient.db.insert(user).values({
    id,
    name: label,
    email: `${id}@example.com`,
    emailVerified: true
  });
  return { type: 'user', id, roles: ['customer'] };
}

async function grant(userId: string, titleId: string): Promise<void> {
  await databaseClient.db.insert(entitlements).values({ userId, titleId });
}

async function createProsePublication() {
  const [title] = await databaseClient.db.insert(titles).values({
    slug: `state-prose-${randomUUID()}`,
    title: 'State Prose',
    description: 'Reader state prose fixture',
    creatorName: 'Pale Orbit',
    format: 'prose',
    priceMinor: 100,
    currency: 'USD',
    visibility: 'private'
  }).returning();
  if (!title) throw new Error('Expected title');
  const [revision] = await databaseClient.db.insert(titleRevisions).values({
    titleId: title.id,
    state: 'active',
    createdByActorId: 'fixture',
    changeSummary: 'State fixture'
  }).returning();
  if (!revision) throw new Error('Expected revision');
  const [section] = await databaseClient.db.insert(proseSections).values({
    revisionId: revision.id,
    ordinal: 0,
    label: 'Chapter',
    sourceReference: 'EPUB/chapter.xhtml'
  }).returning();
  if (!section) throw new Error('Expected section');
  const blocks = [0, 1].map((ordinal) => ({
    id: randomUUID(),
    revisionId: revision.id,
    sectionId: section.id,
    ordinal,
    kind: 'paragraph' as const,
    content: {
      kind: 'paragraph' as const,
      fragments: [{ text: ordinal === 0 ? 'hello' : 'second block', marks: [] }]
    },
    imageId: null
  }));
  await databaseClient.db.insert(proseBlocks).values(blocks);
  const [presentation] = await databaseClient.db.insert(revisionPresentations).values({
    revisionId: revision.id,
    state: 'published',
    previewProseSectionId: section.id,
    previewProseBlockId: blocks[0]!.id,
    previewComicPageId: null
  }).returning();
  if (!presentation) throw new Error('Expected presentation');
  await databaseClient.db.update(titles)
    .set({ activeRevisionId: revision.id })
    .where(eq(titles.id, title.id));
  return { title, revision, presentation, section, blocks };
}

async function createComicPublication() {
  const [title] = await databaseClient.db.insert(titles).values({
    slug: `state-comic-${randomUUID()}`,
    title: 'State Comic',
    description: 'Reader state comic fixture',
    creatorName: 'Pale Orbit',
    format: 'comic',
    priceMinor: 100,
    currency: 'USD',
    visibility: 'private'
  }).returning();
  if (!title) throw new Error('Expected comic title');
  const [revision] = await databaseClient.db.insert(titleRevisions).values({
    titleId: title.id,
    state: 'active',
    createdByActorId: 'fixture',
    changeSummary: 'Comic state fixture'
  }).returning();
  if (!revision) throw new Error('Expected comic revision');
  const [page] = await databaseClient.db.insert(comicPages).values({
    revisionId: revision.id,
    ordinal: 1,
    sourcePath: '001.png',
    storageKey: `derived/${revision.id}/001.webp`,
    mediaType: 'image/webp',
    checksumSha256: 'c'.repeat(64),
    byteSize: 100,
    width: 100,
    height: 200
  }).returning();
  if (!page) throw new Error('Expected comic page');
  const [presentation] = await databaseClient.db.insert(revisionPresentations).values({
    revisionId: revision.id,
    state: 'published',
    guidedViewEnabled: true,
    previewProseSectionId: null,
    previewProseBlockId: null,
    previewComicPageId: page.id
  }).returning();
  if (!presentation) throw new Error('Expected comic presentation');
  await databaseClient.db.insert(comicPanelRegions).values({
    revisionId: revision.id,
    presentationId: presentation.id,
    pageId: page.id,
    ordinal: 0,
    x: 0,
    y: 0,
    width: 1,
    height: 1
  });
  await databaseClient.db.update(titles)
    .set({ activeRevisionId: revision.id })
    .where(eq(titles.id, title.id));
  return { title, revision, presentation, page };
}

function context(actor: Actor, titleId: string) {
  return {
    database: databaseClient.db,
    actor,
    titleId,
    correlationId: randomUUID()
  };
}

describe('optimistic reader state', () => {
  it('creates, updates, and serializes concurrent progress with one stale result', async () => {
    const customer = await createCustomer('Progress Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    const base = context(customer, publication.title.id);

    const created = await saveProgress({
      ...base,
      location: { format: 'prose', blockId: publication.blocks[0]!.id, offset: 0 },
      expectedVersion: 0
    });
    expect(created).toMatchObject({ version: 1, revisionId: publication.revision.id });
    const updated = await saveProgress({
      ...base,
      location: { format: 'prose', blockId: publication.blocks[1]!.id, offset: 2 },
      expectedVersion: 1
    });
    expect(updated.version).toBe(2);

    const results = await Promise.allSettled([
      saveProgress({
        ...base,
        location: { format: 'prose', blockId: publication.blocks[1]!.id, offset: 3 },
        expectedVersion: 2
      }),
      saveProgress({
        ...base,
        location: { format: 'prose', blockId: publication.blocks[1]!.id, offset: 4 },
        expectedVersion: 2
      })
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === 'rejected' ? rejected[0].reason : null)
      .toBeInstanceOf(StaleReaderStateError);
    expect(rejected[0]?.status === 'rejected' ? rejected[0].reason.current.version : null).toBe(3);
  });

  it('creates bookmarks idempotently and never deletes another user bookmark', async () => {
    const owner = await createCustomer('Bookmark Owner');
    const other = await createCustomer('Bookmark Other');
    const publication = await createProsePublication();
    await grant(owner.id, publication.title.id);
    await grant(other.id, publication.title.id);
    const input = {
      ...context(owner, publication.title.id),
      location: { format: 'prose' as const, blockId: publication.blocks[0]!.id, offset: 2 }
    };
    const first = await createBookmark(input);
    const replay = await createBookmark(input);
    expect(replay).toEqual(first);

    await deleteBookmark({
      ...context(other, publication.title.id),
      bookmarkId: first.id
    });
    const [persisted] = await databaseClient.db.select({ id: readerBookmarks.id })
      .from(readerBookmarks)
      .where(eq(readerBookmarks.id, first.id));
    expect(persisted?.id).toBe(first.id);
    await deleteBookmark({ ...context(owner, publication.title.id), bookmarkId: first.id });
    await deleteBookmark({ ...context(owner, publication.title.id), bookmarkId: first.id });
    const remaining = await databaseClient.db.select({ id: readerBookmarks.id })
      .from(readerBookmarks)
      .where(eq(readerBookmarks.id, first.id));
    expect(remaining).toHaveLength(0);
  });

  it('stores account preferences independently and comic mode per title', async () => {
    const customer = await createCustomer('Preferences Customer');
    const prose = await createProsePublication();
    const comic = await createComicPublication();
    await grant(customer.id, prose.title.id);
    await grant(customer.id, comic.title.id);
    const preferences = await saveReaderPreferences({
      database: databaseClient.db,
      actor: customer,
      correlationId: randomUUID(),
      fontSize: 20,
      typeface: 'georgia',
      paper: 'dim',
      expectedVersion: 0
    });
    expect(preferences).toEqual({
      fontSize: 20,
      typeface: 'georgia',
      paper: 'dim',
      version: 1
    });
    const titlePreferences = await saveReaderTitlePreferences({
      ...context(customer, comic.title.id),
      comicMode: 'guided',
      expectedVersion: 0
    });
    expect(titlePreferences).toEqual({
      titleId: comic.title.id,
      comicMode: 'guided',
      version: 1
    });
    await expect(
      saveReaderTitlePreferences({
        ...context(customer, prose.title.id),
        comicMode: 'page',
        expectedVersion: 0
      })
    ).rejects.toMatchObject({ code: 'reader_state_not_found' });
  });

  it('returns current initial state and denies state after entitlement revocation', async () => {
    const customer = await createCustomer('Initial State Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    const base = context(customer, publication.title.id);
    await saveProgress({
      ...base,
      location: { format: 'prose', blockId: publication.blocks[0]!.id, offset: 1 },
      expectedVersion: 0
    });
    await createBookmark({
      ...base,
      location: { format: 'prose', blockId: publication.blocks[1]!.id, offset: 2 }
    });
    const state = await getReaderInitialState(base);
    expect(state.progress?.version).toBe(1);
    expect(state.bookmarks).toHaveLength(1);
    expect(state.preferences).toEqual({ fontSize: 18, typeface: 'serif', paper: 'white', version: 0 });

    await databaseClient.db.update(entitlements)
      .set({ revokedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(and(
        eq(entitlements.userId, customer.id),
        eq(entitlements.titleId, publication.title.id)
      ));
    await expect(saveProgress({
      ...base,
      location: { format: 'prose', blockId: publication.blocks[0]!.id, offset: 2 },
      expectedVersion: 1
    })).rejects.toMatchObject({ code: 'reader_state_not_found' });
    const rows = await databaseClient.db.select().from(readerProgress)
      .where(and(
        eq(readerProgress.userId, customer.id),
        eq(readerProgress.titleId, publication.title.id)
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  it('rechecks the active revision after waiting on a concurrent replacement', async () => {
    const customer = await createCustomer('Replacement Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    const base = context(customer, publication.title.id);
    await saveProgress({
      ...base,
      location: { format: 'prose', blockId: publication.blocks[0]!.id, offset: 1 },
      expectedVersion: 0
    });

    const [replacementRevision] = await databaseClient.db.insert(titleRevisions).values({
      titleId: publication.title.id,
      state: 'ready_for_review',
      createdByActorId: 'fixture',
      changeSummary: 'Concurrent replacement'
    }).returning();
    if (!replacementRevision) throw new Error('Expected replacement revision');
    const [replacementSection] = await databaseClient.db.insert(proseSections).values({
      revisionId: replacementRevision.id,
      ordinal: 0,
      label: 'Replacement',
      sourceReference: 'EPUB/replacement.xhtml'
    }).returning();
    if (!replacementSection) throw new Error('Expected replacement section');
    const [replacementBlock] = await databaseClient.db.insert(proseBlocks).values({
      revisionId: replacementRevision.id,
      sectionId: replacementSection.id,
      ordinal: 0,
      kind: 'paragraph',
      content: { kind: 'paragraph', fragments: [{ text: 'new edition', marks: [] }] },
      imageId: null
    }).returning();
    if (!replacementBlock) throw new Error('Expected replacement block');
    await databaseClient.db.insert(revisionPresentations).values({
      revisionId: replacementRevision.id,
      state: 'published',
      previewProseSectionId: replacementSection.id,
      previewProseBlockId: replacementBlock.id,
      previewComicPageId: null
    });

    let releaseReplacement!: () => void;
    const release = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const replacement = databaseClient.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${publication.title.id}, 0))`
      );
      signalLocked();
      await release;
      await transaction.update(titleRevisions)
        .set({ state: 'retired', retiredAt: sql`clock_timestamp()` })
        .where(eq(titleRevisions.id, publication.revision.id));
      await transaction.update(titleRevisions)
        .set({ state: 'active', activatedAt: sql`clock_timestamp()` })
        .where(eq(titleRevisions.id, replacementRevision.id));
      await transaction.update(titles)
        .set({ activeRevisionId: replacementRevision.id, updatedAt: sql`clock_timestamp()` })
        .where(eq(titles.id, publication.title.id));
    });
    await locked;
    const waitingWrite = saveProgress({
      ...base,
      location: { format: 'prose', blockId: publication.blocks[0]!.id, offset: 2 },
      expectedVersion: 1
    });
    releaseReplacement();
    await replacement;
    await expect(waitingWrite).rejects.toMatchObject({ code: 'invalid_reader_location' });
    const replacementRows = await databaseClient.db.select().from(readerProgress)
      .where(and(
        eq(readerProgress.userId, customer.id),
        eq(readerProgress.revisionId, replacementRevision.id)
      ));
    expect(replacementRows).toHaveLength(0);
  });
});
