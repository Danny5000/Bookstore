import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { getEntitledInitialReader } from '$lib/server/catalog/reader';
import {
  comicPages,
  comicPanelRegions,
  proseBlocks,
  proseSections,
  readerBookmarks,
  readerProgress,
  readerRevisionMigrations,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import { StaleReaderStateError } from '$lib/server/reader-state/errors';
import { lockReaderTitle } from '$lib/server/reader-state/lock';
import { migrateLockedReaderState } from '$lib/server/reader-state/migration';
import {
  acknowledgeMigrationNotice,
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
  await databaseClient.db.transaction((transaction) =>
    setPreservedGrantState(transaction, {
      userId,
      titleId,
      active: true,
      stateReason: 'test_preserved_access'
    })
  );
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

async function seedHistoricalProseState(
  customer: Extract<Actor, { type: 'user' }>,
  publication: Awaited<ReturnType<typeof createProsePublication>>,
  options: { digest: string | null; targetMatches: readonly number[] }
) {
  for (const index of options.targetMatches) {
    await databaseClient.db.update(proseBlocks).set({
      semanticFingerprintSha256: options.digest,
      semanticFingerprintVersion: options.digest ? 1 : null
    }).where(eq(proseBlocks.id, publication.blocks[index]!.id));
  }
  const [sourceRevision] = await databaseClient.db.insert(titleRevisions).values({
    titleId: publication.title.id,
    state: 'retired',
    createdByActorId: 'fixture',
    changeSummary: 'Historical migration source'
  }).returning();
  if (!sourceRevision) throw new Error('Expected source revision');
  const [sourceSection] = await databaseClient.db.insert(proseSections).values({
    revisionId: sourceRevision.id,
    ordinal: 0,
    label: 'Old chapter',
    sourceReference: 'EPUB/old.xhtml'
  }).returning();
  if (!sourceSection) throw new Error('Expected source section');
  const [sourceBlock] = await databaseClient.db.insert(proseBlocks).values({
    revisionId: sourceRevision.id,
    sectionId: sourceSection.id,
    ordinal: 0,
    kind: 'paragraph',
    content: { kind: 'paragraph', fragments: [{ text: 'hello', marks: [] }] },
    imageId: null,
    semanticFingerprintSha256: options.digest,
    semanticFingerprintVersion: options.digest ? 1 : null
  }).returning();
  if (!sourceBlock) throw new Error('Expected source block');
  await databaseClient.db.insert(readerProgress).values({
    userId: customer.id,
    titleId: publication.title.id,
    revisionId: sourceRevision.id,
    format: 'prose',
    blockId: sourceBlock.id,
    proseOffset: 2
  });
  const [bookmark] = await databaseClient.db.insert(readerBookmarks).values({
    userId: customer.id,
    titleId: publication.title.id,
    revisionId: sourceRevision.id,
    format: 'prose',
    blockId: sourceBlock.id,
    proseOffset: 3
  }).returning();
  if (!bookmark) throw new Error('Expected source bookmark');
  return { sourceRevision, sourceSection, sourceBlock, bookmark };
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

    await databaseClient.db.transaction((transaction) =>
      setPreservedGrantState(transaction, {
        userId: customer.id,
        titleId: publication.title.id,
        active: false,
        stateReason: 'test_preserved_revoked'
      })
    );
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

  it('loads entitled document and state from one current snapshot after a replacement', async () => {
    const customer = await createCustomer('Reader Snapshot Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    await databaseClient.db.update(proseBlocks)
      .set({ semanticFingerprintSha256: '8'.repeat(64), semanticFingerprintVersion: 1 })
      .where(eq(proseBlocks.id, publication.blocks[0]!.id));
    await saveProgress({
      ...context(customer, publication.title.id),
      location: { format: 'prose', blockId: publication.blocks[0]!.id, offset: 1 },
      expectedVersion: 0
    });

    const [replacementRevision] = await databaseClient.db.insert(titleRevisions).values({
      titleId: publication.title.id,
      state: 'ready_for_review',
      createdByActorId: 'fixture',
      changeSummary: 'Reader snapshot replacement'
    }).returning();
    if (!replacementRevision) throw new Error('Expected reader snapshot replacement');
    const [replacementSection] = await databaseClient.db.insert(proseSections).values({
      revisionId: replacementRevision.id,
      ordinal: 0,
      label: 'Replacement',
      sourceReference: 'EPUB/reader-snapshot-replacement.xhtml'
    }).returning();
    if (!replacementSection) throw new Error('Expected reader snapshot replacement section');
    const [replacementBlock] = await databaseClient.db.insert(proseBlocks).values({
      revisionId: replacementRevision.id,
      sectionId: replacementSection.id,
      ordinal: 0,
      kind: 'paragraph',
      content: { kind: 'paragraph', fragments: [{ text: 'replacement edition', marks: [] }] },
      imageId: null,
      semanticFingerprintSha256: '8'.repeat(64),
      semanticFingerprintVersion: 1
    }).returning();
    if (!replacementBlock) throw new Error('Expected reader snapshot replacement block');
    const [replacementPresentation] = await databaseClient.db.insert(revisionPresentations).values({
      revisionId: replacementRevision.id,
      state: 'published',
      previewProseSectionId: replacementSection.id,
      previewProseBlockId: replacementBlock.id,
      previewComicPageId: null
    }).returning();
    if (!replacementPresentation) throw new Error('Expected reader snapshot replacement presentation');

    const staleDecision = {
      level: 'entitled' as const,
      titleId: publication.title.id,
      revisionId: publication.revision.id,
      presentationId: publication.presentation.id,
      root: {
        title: publication.title,
        revisionId: publication.revision.id,
        presentation: publication.presentation
      }
    };
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
    const loading = getEntitledInitialReader(databaseClient.db, staleDecision, {
      actor: customer,
      correlationId: randomUUID()
    });
    releaseReplacement();
    await replacement;
    const payload = await loading;

    expect(payload.document.revisionId).toBe(replacementRevision.id);
    expect(payload.initialState.progress).toMatchObject({
      revisionId: replacementRevision.id,
      location: { format: 'prose', blockId: replacementBlock.id, offset: 1 }
    });
    expect(payload.initialState.progress?.revisionId).toBe(payload.document.revisionId);
    expect(JSON.stringify(payload.document)).not.toContain(publication.revision.id);
  });

  it('migrates exact prose state once across concurrent loads and acknowledges its notice', async () => {
    const customer = await createCustomer('Migration Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    const source = await seedHistoricalProseState(customer, publication, {
      digest: 'd'.repeat(64),
      targetMatches: [1]
    });
    const base = context(customer, publication.title.id);

    const [first, second] = await Promise.all([
      getReaderInitialState(base),
      getReaderInitialState(base)
    ]);
    for (const state of [first, second]) {
      expect(state.progress).toMatchObject({
        revisionId: publication.revision.id,
        location: { format: 'prose', blockId: publication.blocks[1]!.id, offset: 2 }
      });
      expect(state.bookmarks[0]).toMatchObject({
        revisionId: publication.revision.id,
        location: { format: 'prose', blockId: publication.blocks[1]!.id, offset: 3 }
      });
      expect(state.migrationNotice).toMatchObject({
        progress: 'migrated',
        migratedBookmarkCount: 1,
        unmatchedBookmarkCount: 0,
        acknowledged: false
      });
    }
    const migrations = await databaseClient.db.select().from(readerRevisionMigrations)
      .where(and(
        eq(readerRevisionMigrations.userId, customer.id),
        eq(readerRevisionMigrations.targetRevisionId, publication.revision.id)
      ));
    expect(migrations).toHaveLength(1);
    const [migratedBookmark] = await databaseClient.db.select().from(readerBookmarks)
      .where(eq(readerBookmarks.migratedFromBookmarkId, source.bookmark.id));
    expect(migratedBookmark?.revisionId).toBe(publication.revision.id);

    const acknowledged = await acknowledgeMigrationNotice({
      ...base,
      targetRevisionId: publication.revision.id
    });
    expect(acknowledged.acknowledged).toBe(true);
    await expect(acknowledgeMigrationNotice({
      ...base,
      targetRevisionId: publication.revision.id
    })).resolves.toMatchObject({ acknowledged: true });
    await expect(getReaderInitialState(base)).resolves.toMatchObject({ migrationNotice: null });
  });

  it('resets ambiguous prose progress, retains unmatched bookmarks, and never overwrites target state', async () => {
    const customer = await createCustomer('Ambiguous Migration Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    await seedHistoricalProseState(customer, publication, {
      digest: 'e'.repeat(64),
      targetMatches: [0, 1]
    });
    const base = context(customer, publication.title.id);
    const reset = await getReaderInitialState(base);
    expect(reset.progress).toMatchObject({
      location: { format: 'prose', blockId: publication.blocks[0]!.id, offset: 0 }
    });
    expect(reset.bookmarks).toHaveLength(0);
    expect(reset.migrationNotice).toMatchObject({
      progress: 'reset',
      migratedBookmarkCount: 0,
      unmatchedBookmarkCount: 1
    });

    const existingCustomer = await createCustomer('Existing Target Customer');
    const existingPublication = await createProsePublication();
    await grant(existingCustomer.id, existingPublication.title.id);
    await seedHistoricalProseState(existingCustomer, existingPublication, {
      digest: 'f'.repeat(64),
      targetMatches: [1]
    });
    await databaseClient.db.insert(readerProgress).values({
      userId: existingCustomer.id,
      titleId: existingPublication.title.id,
      revisionId: existingPublication.revision.id,
      format: 'prose',
      blockId: existingPublication.blocks[0]!.id,
      proseOffset: 1
    });
    const [targetBookmark] = await databaseClient.db.insert(readerBookmarks).values({
      userId: existingCustomer.id,
      titleId: existingPublication.title.id,
      revisionId: existingPublication.revision.id,
      format: 'prose',
      blockId: existingPublication.blocks[0]!.id,
      proseOffset: 1
    }).returning();
    const existing = await getReaderInitialState(context(existingCustomer, existingPublication.title.id));
    expect(existing.progress?.location).toEqual({
      format: 'prose',
      blockId: existingPublication.blocks[0]!.id,
      offset: 1
    });
    expect(existing.bookmarks.map((bookmark) => bookmark.id)).toEqual([targetBookmark!.id]);
    expect(existing.migrationNotice).toMatchObject({
      progress: 'absent',
      migratedBookmarkCount: 0,
      unmatchedBookmarkCount: 1
    });
  });

  it('simplifies comic panels when exact page fingerprints have different geometry', async () => {
    const customer = await createCustomer('Comic Migration Customer');
    const publication = await createComicPublication();
    await grant(customer.id, publication.title.id);
    await databaseClient.db.update(comicPages).set({
      semanticFingerprintSha256: '9'.repeat(64),
      semanticFingerprintVersion: 1
    }).where(eq(comicPages.id, publication.page.id));
    const [sourceRevision] = await databaseClient.db.insert(titleRevisions).values({
      titleId: publication.title.id,
      state: 'retired',
      createdByActorId: 'fixture',
      changeSummary: 'Historical comic source'
    }).returning();
    if (!sourceRevision) throw new Error('Expected comic source revision');
    const [sourcePage] = await databaseClient.db.insert(comicPages).values({
      revisionId: sourceRevision.id,
      ordinal: 1,
      sourcePath: 'old.png',
      storageKey: `derived/${sourceRevision.id}/old.webp`,
      mediaType: 'image/webp',
      checksumSha256: '8'.repeat(64),
      semanticFingerprintSha256: '9'.repeat(64),
      semanticFingerprintVersion: 1,
      byteSize: 100,
      width: 100,
      height: 200
    }).returning();
    if (!sourcePage) throw new Error('Expected comic source page');
    const [sourcePresentation] = await databaseClient.db.insert(revisionPresentations).values({
      revisionId: sourceRevision.id,
      state: 'published',
      guidedViewEnabled: true,
      previewComicPageId: sourcePage.id
    }).returning();
    if (!sourcePresentation) throw new Error('Expected comic source presentation');
    await databaseClient.db.insert(comicPanelRegions).values({
      revisionId: sourceRevision.id,
      presentationId: sourcePresentation.id,
      pageId: sourcePage.id,
      ordinal: 0,
      x: 0,
      y: 0,
      width: 0.5,
      height: 1
    });
    await databaseClient.db.insert(readerProgress).values({
      userId: customer.id,
      titleId: publication.title.id,
      revisionId: sourceRevision.id,
      format: 'comic',
      pageId: sourcePage.id,
      panelOrdinal: 0
    });

    const state = await getReaderInitialState(context(customer, publication.title.id));
    expect(state.progress?.location).toEqual({
      format: 'comic',
      pageId: publication.page.id,
      panelOrdinal: null
    });
    expect(state.migrationNotice).toMatchObject({
      progress: 'migrated',
      panelPositionSimplified: true
    });
  });

  it('resolves the active target again after waiting for a replacement', async () => {
    const customer = await createCustomer('Migration Replacement Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    await seedHistoricalProseState(customer, publication, {
      digest: '6'.repeat(64),
      targetMatches: [1]
    });
    const [replacementRevision] = await databaseClient.db.insert(titleRevisions).values({
      titleId: publication.title.id,
      state: 'ready_for_review',
      createdByActorId: 'fixture',
      changeSummary: 'Migration race replacement'
    }).returning();
    if (!replacementRevision) throw new Error('Expected migration replacement');
    const [replacementSection] = await databaseClient.db.insert(proseSections).values({
      revisionId: replacementRevision.id,
      ordinal: 0,
      label: 'Replacement',
      sourceReference: 'EPUB/migration-replacement.xhtml'
    }).returning();
    if (!replacementSection) throw new Error('Expected migration replacement section');
    const [replacementBlock] = await databaseClient.db.insert(proseBlocks).values({
      revisionId: replacementRevision.id,
      sectionId: replacementSection.id,
      ordinal: 0,
      kind: 'paragraph',
      content: { kind: 'paragraph', fragments: [{ text: 'hello', marks: [] }] },
      imageId: null,
      semanticFingerprintSha256: '6'.repeat(64),
      semanticFingerprintVersion: 1
    }).returning();
    if (!replacementBlock) throw new Error('Expected migration replacement block');
    await databaseClient.db.insert(revisionPresentations).values({
      revisionId: replacementRevision.id,
      state: 'published',
      previewProseSectionId: replacementSection.id,
      previewProseBlockId: replacementBlock.id
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
    const loading = getReaderInitialState(context(customer, publication.title.id));
    releaseReplacement();
    await replacement;
    const state = await loading;
    expect(state.progress).toMatchObject({
      revisionId: replacementRevision.id,
      location: { format: 'prose', blockId: replacementBlock.id, offset: 2 }
    });
    const staleTarget = await databaseClient.db.select().from(readerProgress)
      .where(and(
        eq(readerProgress.userId, customer.id),
        eq(readerProgress.revisionId, publication.revision.id)
      ));
    expect(staleTarget).toHaveLength(0);
  });

  it('rolls back target state and the migration record on transaction failure', async () => {
    const customer = await createCustomer('Migration Rollback Customer');
    const publication = await createProsePublication();
    await grant(customer.id, publication.title.id);
    await seedHistoricalProseState(customer, publication, {
      digest: '7'.repeat(64),
      targetMatches: [1]
    });
    await expect(databaseClient.db.transaction(async (transaction) => {
      const locked = await lockReaderTitle(transaction, customer, publication.title.id);
      await migrateLockedReaderState(transaction, locked);
      throw new Error('injected migration failure');
    })).rejects.toThrow('injected migration failure');

    const targetProgress = await databaseClient.db.select().from(readerProgress)
      .where(and(
        eq(readerProgress.userId, customer.id),
        eq(readerProgress.revisionId, publication.revision.id)
      ));
    const targetBookmarks = await databaseClient.db.select().from(readerBookmarks)
      .where(and(
        eq(readerBookmarks.userId, customer.id),
        eq(readerBookmarks.revisionId, publication.revision.id)
      ));
    const records = await databaseClient.db.select().from(readerRevisionMigrations)
      .where(and(
        eq(readerRevisionMigrations.userId, customer.id),
        eq(readerRevisionMigrations.targetRevisionId, publication.revision.id)
      ));
    expect(targetProgress).toHaveLength(0);
    expect(targetBookmarks).toHaveLength(0);
    expect(records).toHaveLength(0);
  });
});
