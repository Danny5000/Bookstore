import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { getReaderDocumentForAccess } from '$lib/server/catalog/reader';
import {
  entitlements,
  proseBlocks,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { resolvePublicationAccess } from '$lib/server/library/access';
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

async function createPublishedProse(visibility: 'public' | 'private' | 'archived') {
  const [title] = await databaseClient.db
    .insert(titles)
    .values({
      slug: `access-${randomUUID()}`,
      title: 'Access Title',
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
      changeSummary: 'Access fixture'
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
  await databaseClient.db.insert(entitlements).values({ userId, titleId });
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

    await databaseClient.db
      .update(entitlements)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(entitlements.userId, customer.id));
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
});
