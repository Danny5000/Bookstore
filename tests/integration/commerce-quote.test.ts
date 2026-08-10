import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { InvalidCartError } from '$lib/server/commerce/errors';
import { lockAndQuoteCart, quoteCart } from '$lib/server/commerce/quote';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import {
  proseBlocks,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { databaseClient } from './database';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

async function createCustomer(): Promise<Extract<Actor, { type: 'user' }>> {
  const id = randomUUID();
  await databaseClient.db.insert(user).values({
    id,
    name: 'Quote Customer',
    email: `${id}@example.com`,
    emailVerified: true
  });
  return { type: 'user', id, roles: ['customer'] };
}

interface QuoteTitleOptions {
  label: string;
  visibility?: 'public' | 'private' | 'archived';
  revisionState?: 'active' | 'ready_for_review' | 'retired';
  presentationState?: 'published' | 'draft' | null;
  activePointer?: boolean;
  priceMinor?: number;
  currency?: string;
}

async function createQuoteTitle(options: QuoteTitleOptions) {
  const [title] = await databaseClient.db
    .insert(titles)
    .values({
      slug: `quote-${randomUUID()}`,
      title: options.label,
      description: `${options.label} description`,
      creatorName: `${options.label} creator`,
      format: 'prose',
      priceMinor: options.priceMinor ?? 1000,
      currency: options.currency ?? 'USD',
      visibility: options.visibility ?? 'public'
    })
    .returning();
  if (!title) throw new Error('Expected quote title');
  const [revision] = await databaseClient.db
    .insert(titleRevisions)
    .values({
      titleId: title.id,
      state: options.revisionState ?? 'active',
      createdByActorId: 'system:test',
      changeSummary: 'Quote fixture revision'
    })
    .returning();
  if (!revision) throw new Error('Expected quote revision');

  let presentationId: string | null = null;
  const presentationState = options.presentationState === undefined
    ? 'published'
    : options.presentationState;
  if (presentationState === 'published') {
    const [section] = await databaseClient.db
      .insert(proseSections)
      .values({
        revisionId: revision.id,
        ordinal: 0,
        label: 'Chapter',
        sourceReference: 'EPUB/chapter.xhtml'
      })
      .returning();
    if (!section) throw new Error('Expected quote section');
    const [block] = await databaseClient.db
      .insert(proseBlocks)
      .values({
        revisionId: revision.id,
        sectionId: section.id,
        ordinal: 0,
        kind: 'paragraph',
        content: { kind: 'paragraph', fragments: [{ text: 'Preview', marks: [] }] },
        imageId: null
      })
      .returning();
    if (!block) throw new Error('Expected quote block');
    const [presentation] = await databaseClient.db
      .insert(revisionPresentations)
      .values({
        revisionId: revision.id,
        state: 'published',
        previewProseSectionId: section.id,
        previewProseBlockId: block.id,
        previewComicPageId: null
      })
      .returning({ id: revisionPresentations.id });
    presentationId = presentation?.id ?? null;
  } else if (presentationState === 'draft') {
    const [presentation] = await databaseClient.db
      .insert(revisionPresentations)
      .values({ revisionId: revision.id, state: 'draft' })
      .returning({ id: revisionPresentations.id });
    presentationId = presentation?.id ?? null;
  }

  if (options.activePointer ?? true) {
    await databaseClient.db
      .update(titles)
      .set({ activeRevisionId: revision.id })
      .where(eq(titles.id, title.id));
  }
  return { title, revision, presentationId };
}

describe('authoritative commerce quotes', () => {
  it('quotes only public, active, published, positive-price titles without leaking unavailable metadata', async () => {
    const eligible = await createQuoteTitle({ label: 'Eligible Quote Title' });
    const privateTitle = await createQuoteTitle({
      label: 'Secret Private Quote Title',
      visibility: 'private'
    });
    const draft = await createQuoteTitle({
      label: 'Draft Quote Title',
      presentationState: 'draft'
    });
    const inactive = await createQuoteTitle({
      label: 'Inactive Quote Title',
      revisionState: 'ready_for_review'
    });
    const free = await createQuoteTitle({ label: 'Free Quote Title', priceMinor: 0 });
    const missingPresentation = await createQuoteTitle({
      label: 'Missing Presentation Quote Title',
      presentationState: null
    });
    const unknownId = randomUUID();
    const requested = [
      eligible.title.id,
      privateTitle.title.id,
      draft.title.id,
      inactive.title.id,
      free.title.id,
      missingPresentation.title.id,
      unknownId
    ];

    const quote = await quoteCart(databaseClient.db, { type: 'anonymous' }, requested);

    expect(quote).toMatchObject({
      currency: 'USD',
      subtotalMinor: 1000,
      alreadyOwnedTitleIds: [],
      taxNotice: 'calculated_at_checkout',
      canCheckout: true
    });
    expect(quote.items).toEqual([
      {
        titleId: eligible.title.id,
        slug: eligible.title.slug,
        title: eligible.title.title,
        creatorName: eligible.title.creatorName,
        format: 'prose',
        coverUrl: null,
        unitSubtotalMinor: 1000,
        currency: 'USD'
      }
    ]);
    expect(quote.unavailableTitleIds.sort()).toEqual(
      requested.filter((id) => id !== eligible.title.id).sort()
    );
    expect(quote.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(quote)).not.toContain('Secret Private Quote Title');
  });

  it('rejects mixed currencies', async () => {
    const usd = await createQuoteTitle({ label: 'USD Quote Title' });
    const cad = await createQuoteTitle({ label: 'CAD Quote Title', currency: 'CAD' });

    await expect(
      quoteCart(databaseClient.db, { type: 'anonymous' }, [usd.title.id, cad.title.id])
    ).rejects.toBeInstanceOf(InvalidCartError);
  });

  it('classifies active ownership while allowing a revoked entitlement to repurchase', async () => {
    const customer = await createCustomer();
    const owned = await createQuoteTitle({ label: 'Owned Quote Title' });
    const revoked = await createQuoteTitle({ label: 'Revoked Quote Title' });
    await databaseClient.db.transaction((transaction) =>
      setPreservedGrantState(transaction, {
        userId: customer.id,
        titleId: owned.title.id,
        active: true,
        stateReason: 'test_quote_owned'
      })
    );
    await databaseClient.db.transaction(async (transaction) => {
      await setPreservedGrantState(transaction, {
        userId: customer.id,
        titleId: revoked.title.id,
        active: true,
        stateReason: 'test_quote_revoked_setup'
      });
      await setPreservedGrantState(transaction, {
        userId: customer.id,
        titleId: revoked.title.id,
        active: false,
        stateReason: 'test_quote_revoked'
      });
    });

    const quote = await quoteCart(databaseClient.db, customer, [
      owned.title.id,
      revoked.title.id
    ]);

    expect(quote.alreadyOwnedTitleIds).toEqual([owned.title.id]);
    expect(quote.items.map((item) => item.titleId)).toEqual([revoked.title.id]);
    expect(quote.subtotalMinor).toBe(1000);
  });

  it('rejects duplicate and 26-title requests while accepting 25 unknown IDs safely', async () => {
    const title = await createQuoteTitle({ label: 'Duplicate Quote Title' });
    await expect(
      quoteCart(databaseClient.db, { type: 'anonymous' }, [title.title.id, title.title.id])
    ).rejects.toBeInstanceOf(InvalidCartError);
    await expect(
      quoteCart(
        databaseClient.db,
        { type: 'anonymous' },
        Array.from({ length: 26 }, (_, index) => uuid(index + 1))
      )
    ).rejects.toBeInstanceOf(InvalidCartError);

    const boundary = Array.from({ length: 25 }, (_, index) => uuid(index + 1));
    await expect(
      quoteCart(databaseClient.db, { type: 'anonymous' }, boundary)
    ).resolves.toMatchObject({
      items: [],
      alreadyOwnedTitleIds: [],
      unavailableTitleIds: boundary,
      currency: null,
      subtotalMinor: 0,
      canCheckout: false
    });
  });

  it('locked re-quote observes a catalog change committed while waiting for the title lock', async () => {
    const fixture = await createQuoteTitle({ label: 'Concurrent Price Quote Title' });
    let releaseChange!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseChange = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const catalogChange = databaseClient.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${fixture.title.id}, 0))`
      );
      signalLocked();
      await release;
      await transaction
        .update(titles)
        .set({ priceMinor: 1500, updatedAt: new Date() })
        .where(eq(titles.id, fixture.title.id));
    });
    await locked;
    const waitingQuote = databaseClient.db.transaction((transaction) =>
      lockAndQuoteCart(transaction, { type: 'anonymous' }, [fixture.title.id])
    );
    releaseChange();
    await catalogChange;

    await expect(waitingQuote).resolves.toMatchObject({
      subtotalMinor: 1500,
      items: [{ titleId: fixture.title.id, unitSubtotalMinor: 1500 }]
    });
  });

  it('locked re-quote observes an entitlement committed while waiting for the user/title lock', async () => {
    const customer = await createCustomer();
    const fixture = await createQuoteTitle({ label: 'Concurrent Ownership Quote Title' });
    let releaseChange!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseChange = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const entitlementChange = databaseClient.db.transaction(async (transaction) => {
      await setPreservedGrantState(transaction, {
        userId: customer.id,
        titleId: fixture.title.id,
        active: true,
        stateReason: 'test_concurrent_quote_owned'
      });
      signalLocked();
      await release;
    });
    await locked;
    const waitingQuote = databaseClient.db.transaction((transaction) =>
      lockAndQuoteCart(transaction, customer, [fixture.title.id])
    );
    releaseChange();
    await entitlementChange;

    await expect(waitingQuote).resolves.toMatchObject({
      items: [],
      alreadyOwnedTitleIds: [fixture.title.id],
      subtotalMinor: 0,
      canCheckout: false
    });
  });
});
