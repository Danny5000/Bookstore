import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { getReaderDocumentForAccess } from '$lib/server/catalog/reader';
import {
  proseBlocks,
  proseSections,
  readerProgress,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import { resolvePublicationAccess } from '$lib/server/library/access';
import { listCustomerLibrary } from '$lib/server/library/query';
import { databaseClient } from './database';

const anonymous = { type: 'anonymous' } satisfies Actor;
const admin = { type: 'user', id: randomUUID(), roles: ['admin'] } satisfies Actor;

async function createCustomer(): Promise<Extract<Actor, { type: 'user' }>> {
  const id = randomUUID();
  await databaseClient.db.insert(user).values({
    id,
    name: 'Library Customer',
    email: `${id}@example.com`,
    emailVerified: true
  });
  return { type: 'user', id, roles: ['customer'] };
}

async function createPublishedProse(
  visibility: 'public' | 'private' | 'archived',
  titleLabel = 'Access Title'
) {
  const [title] = await databaseClient.db
    .insert(titles)
    .values({
      slug: `access-${randomUUID()}`,
      title: titleLabel,
      description: 'Access policy fixture',
      creatorName: 'Pale Orbit',
      format: 'prose',
      priceMinor: 1299,
      currency: 'USD',
      visibility: 'private'
    })
    .returning();
  if (!title) throw new Error('Expected title');
  const [revision] = await databaseClient.db
    .insert(titleRevisions)
    .values({
      titleId: title.id,
      state: 'active',
      createdByActorId: admin.id,
      changeSummary: 'Access fixture',
      originalStorageKey: `originals/${randomUUID()}`,
      originalChecksumSha256: 'a'.repeat(64),
      originalMimeType: 'application/epub+zip',
      originalByteSize: 1_024,
      originalFilename: `${titleLabel.toLowerCase().replaceAll(' ', '-')}.epub`
    })
    .returning();
  if (!revision) throw new Error('Expected revision');
  const [section] = await databaseClient.db
    .insert(proseSections)
    .values({
      revisionId: revision.id,
      ordinal: 0,
      label: 'Chapter',
      sourceReference: 'EPUB/chapter.xhtml'
    })
    .returning();
  if (!section) throw new Error('Expected section');
  const blocks = [0, 1, 2].map((ordinal) => ({
    id: randomUUID(),
    revisionId: revision.id,
    sectionId: section.id,
    ordinal,
    kind: 'paragraph' as const,
    content: {
      kind: 'paragraph' as const,
      fragments: [{ text: `Block ${ordinal}`, marks: [] }]
    },
    imageId: null
  }));
  await databaseClient.db.insert(proseBlocks).values(blocks);
  const [presentation] = await databaseClient.db
    .insert(revisionPresentations)
    .values({
      revisionId: revision.id,
      state: 'published',
      previewProseSectionId: section.id,
      previewProseBlockId: blocks[1]!.id,
      previewComicPageId: null
    })
    .returning();
  if (!presentation) throw new Error('Expected presentation');
  await databaseClient.db
    .update(titles)
    .set({ activeRevisionId: revision.id, visibility })
    .where(eq(titles.id, title.id));
  return { title, revision, presentation, blocks };
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

async function revoke(userId: string, titleId: string): Promise<void> {
  await databaseClient.db.transaction((transaction) =>
    setPreservedGrantState(transaction, {
      userId,
      titleId,
      active: false,
      stateReason: 'test_preserved_revoked'
    })
  );
}

describe('effective publication access', () => {
  it('resolves admin, entitlement, preview, revocation, and unavailable states', async () => {
    const customer = await createCustomer();
    const publication = await createPublishedProse('public');

    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: anonymous,
        titleId: publication.title.id,
        purpose: 'reader'
      })
    ).resolves.toMatchObject({ level: 'preview', titleId: publication.title.id });
    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: customer,
        titleId: publication.title.id,
        purpose: 'reader'
      })
    ).resolves.toMatchObject({ level: 'preview' });

    await grant(customer.id, publication.title.id);
    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: customer,
        titleId: publication.title.id,
        purpose: 'reader'
      })
    ).resolves.toMatchObject({ level: 'entitled', revisionId: publication.revision.id });
    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: admin,
        titleId: publication.title.id,
        purpose: 'reader'
      })
    ).resolves.toMatchObject({ level: 'admin' });

    await databaseClient.db
      .update(titles)
      .set({ visibility: 'archived' })
      .where(eq(titles.id, publication.title.id));
    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: customer,
        titleId: publication.title.id,
        purpose: 'reader'
      })
    ).resolves.toMatchObject({ level: 'entitled' });

    await revoke(customer.id, publication.title.id);
    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: customer,
        titleId: publication.title.id,
        purpose: 'reader'
      })
    ).resolves.toEqual({ level: 'denied' });

    const unavailable = await databaseClient.db
      .insert(titles)
      .values({
        slug: `unavailable-${randomUUID()}`,
        title: 'Unavailable Title',
        description: 'No current edition',
        creatorName: 'Pale Orbit',
        format: 'prose',
        priceMinor: 0,
        currency: 'USD',
        visibility: 'private'
      })
      .returning();
    await grant(customer.id, unavailable[0]!.id);
    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: customer,
        titleId: unavailable[0]!.id,
        purpose: 'reader'
      })
    ).resolves.toEqual({ level: 'unavailable', titleId: unavailable[0]!.id });
    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: customer,
        titleId: randomUUID(),
        purpose: 'reader'
      })
    ).resolves.toEqual({ level: 'denied' });
  });

  it('never lets one title entitlement unlock another and builds full entitled content', async () => {
    const customer = await createCustomer();
    const entitledPublication = await createPublishedProse('private');
    const otherPublication = await createPublishedProse('private');
    await grant(customer.id, entitledPublication.title.id);

    const decision = await resolvePublicationAccess({
      db: databaseClient.db,
      actor: customer,
      titleId: entitledPublication.title.id,
      purpose: 'reader'
    });
    const document = await getReaderDocumentForAccess(databaseClient.db, decision);
    expect(document?.access).toBe('entitled');
    expect(document?.format === 'prose' ? document.sections[0]?.blocks : []).toHaveLength(3);

    await expect(
      resolvePublicationAccess({
        db: databaseClient.db,
        actor: customer,
        titleId: otherPublication.title.id,
        purpose: 'reader'
      })
    ).resolves.toEqual({ level: 'denied' });

    const persistedBlocks = await databaseClient.db
      .select()
      .from(proseBlocks)
      .where(eq(proseBlocks.revisionId, entitledPublication.revision.id))
      .orderBy(asc(proseBlocks.ordinal));
    expect(persistedBlocks).toHaveLength(3);
  });

  it('returns a safe deterministic shelf with current progress and unavailable titles', async () => {
    const customer = await createCustomer();
    const alpha = await createPublishedProse('public', 'Alpha Public');
    const beta = await createPublishedProse('private', 'Beta Private');
    const gamma = await createPublishedProse('archived', 'Gamma Archived');
    const revoked = await createPublishedProse('public', 'Revoked Title');
    const [unavailable] = await databaseClient.db
      .insert(titles)
      .values({
        slug: `unavailable-shelf-${randomUUID()}`,
        title: 'Zeta Unavailable',
        description: 'No current edition',
        creatorName: 'Pale Orbit',
        format: 'prose',
        priceMinor: 0,
        currency: 'USD',
        visibility: 'archived'
      })
      .returning();
    if (!unavailable) throw new Error('Expected unavailable title');

    for (const titleId of [
      alpha.title.id,
      beta.title.id,
      gamma.title.id,
      revoked.title.id,
      unavailable.id
    ]) await grant(customer.id, titleId);
    await revoke(customer.id, revoked.title.id);
    await databaseClient.db.insert(readerProgress).values({
      userId: customer.id,
      titleId: alpha.title.id,
      revisionId: alpha.revision.id,
      format: 'prose',
      blockId: alpha.blocks[1]!.id,
      proseOffset: 3
    });
    const [historicalRevision] = await databaseClient.db
      .insert(titleRevisions)
      .values({
        titleId: beta.title.id,
        state: 'retired',
        createdByActorId: admin.id,
        changeSummary: 'Historical progress fixture'
      })
      .returning();
    if (!historicalRevision) throw new Error('Expected historical revision');
    const [historicalSection] = await databaseClient.db
      .insert(proseSections)
      .values({
        revisionId: historicalRevision.id,
        ordinal: 0,
        label: 'Historical chapter',
        sourceReference: 'EPUB/historical.xhtml'
      })
      .returning();
    if (!historicalSection) throw new Error('Expected historical section');
    const [historicalBlock] = await databaseClient.db
      .insert(proseBlocks)
      .values({
        revisionId: historicalRevision.id,
        sectionId: historicalSection.id,
        ordinal: 0,
        kind: 'paragraph',
        content: {
          kind: 'paragraph',
          fragments: [{ text: 'Old position', marks: [] }]
        },
        imageId: null
      })
      .returning();
    if (!historicalBlock) throw new Error('Expected historical block');
    await databaseClient.db.insert(readerProgress).values({
      userId: customer.id,
      titleId: beta.title.id,
      revisionId: historicalRevision.id,
      format: 'prose',
      blockId: historicalBlock.id,
      proseOffset: 4
    });

    const shelf = await listCustomerLibrary(databaseClient.db, customer.id);
    expect(shelf.map((entry) => entry.title)).toEqual([
      'Alpha Public',
      'Beta Private',
      'Gamma Archived',
      'Zeta Unavailable'
    ]);
    expect(shelf[0]).toMatchObject({
      availability: 'available',
      activeRevisionId: alpha.revision.id,
      downloadFormat: 'epub',
      progressPercent: 47.62,
      readUrl: `/read/${alpha.title.id}`,
      downloadUrl: `/library/${alpha.title.id}/download`
    });
    expect(shelf[1]?.progressPercent).toBeNull();
    expect(shelf[2]?.availability).toBe('available');
    expect(shelf[3]).toMatchObject({
      availability: 'temporarily_unavailable',
      activeRevisionId: null,
      downloadFormat: null,
      progressPercent: null,
      readUrl: null,
      resumeUrl: null,
      downloadUrl: null
    });
    expect(JSON.stringify(shelf)).not.toMatch(
      /userId|entitlementId|storageKey|originalFilename|presentationId|candidate|retired/iu
    );
  });
});
