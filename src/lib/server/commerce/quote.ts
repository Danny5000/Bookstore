import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  entitlements,
  entitlementGrants,
  guestIdentities,
  orderItems,
  orders,
  revisionPresentations,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import type { DatabaseExecutor, DatabaseTransaction } from '$lib/server/db/transaction';
import {
  quoteRequestSchema,
  type CommerceQuoteDto,
  type CommerceQuoteItemDto
} from '$lib/types/commerce';
import { InvalidCartError } from './errors';
import { lockEntitlementScopes } from './lock';

export interface QuoteFingerprintItemV1 {
  titleId: string;
  priceMinor: number;
  currency: string;
  activeRevisionId: string;
  presentationPublishedAt: string;
}

export interface QuoteFingerprintInputV1 {
  version: 1;
  actorUserId: string | null;
  items: QuoteFingerprintItemV1[];
  alreadyOwnedTitleIds: string[];
  claimableTitleIds: string[];
  reservedTitleIds: string[];
  unavailableTitleIds: string[];
}

export const CHECKOUT_PROVIDER_CALL_WINDOW_SECONDS = 30;

export function checkoutProviderStartDeadline(createdAt: Date): Date {
  const epochSeconds = Math.floor(createdAt.getTime() / 1000);
  return new Date((epochSeconds + CHECKOUT_PROVIDER_CALL_WINDOW_SECONDS) * 1000);
}

function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createQuoteFingerprint(input: QuoteFingerprintInputV1): string {
  const canonical: QuoteFingerprintInputV1 = {
    version: 1,
    actorUserId: input.actorUserId,
    items: [...input.items]
      .sort((left, right) => rawCompare(left.titleId, right.titleId))
      .map((item) => ({
        titleId: item.titleId,
        priceMinor: item.priceMinor,
        currency: item.currency,
        activeRevisionId: item.activeRevisionId,
        presentationPublishedAt: item.presentationPublishedAt
      })),
    alreadyOwnedTitleIds: [...input.alreadyOwnedTitleIds].sort(rawCompare),
    claimableTitleIds: [...input.claimableTitleIds].sort(rawCompare),
    reservedTitleIds: [...input.reservedTitleIds].sort(rawCompare),
    unavailableTitleIds: [...input.unavailableTitleIds].sort(rawCompare)
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function validatedTitleIds(titleIds: readonly string[]): string[] {
  const parsed = quoteRequestSchema.shape.titleIds.safeParse([...titleIds]);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new InvalidCartError();
  }
  return [...parsed.data].sort(rawCompare);
}

function actorUserId(actor: Actor): string | null {
  return actor.type === 'user' ? actor.id : null;
}

async function buildQuote(
  database: DatabaseExecutor,
  actor: Actor,
  requestedTitleIds: readonly string[],
  checkoutAttemptId: string | null,
  now: Date
): Promise<CommerceQuoteDto> {
  const rows = await database
    .select({
      titleId: titles.id,
      slug: titles.slug,
      title: titles.title,
      creatorName: titles.creatorName,
      format: titles.format,
      priceMinor: titles.priceMinor,
      currency: titles.currency,
      visibility: titles.visibility,
      activeRevisionId: titles.activeRevisionId,
      coverChecksumSha256: titles.coverChecksumSha256,
      coverMediaType: titles.coverMediaType,
      coverByteSize: titles.coverByteSize,
      coverWidth: titles.coverWidth,
      coverHeight: titles.coverHeight,
      revisionId: titleRevisions.id,
      revisionState: titleRevisions.state,
      presentationId: revisionPresentations.id,
      presentationState: revisionPresentations.state,
      presentationPublishedAt: revisionPresentations.updatedAt
    })
    .from(titles)
    .leftJoin(
      titleRevisions,
      and(
        eq(titleRevisions.id, titles.activeRevisionId),
        eq(titleRevisions.titleId, titles.id)
      )
    )
    .leftJoin(
      revisionPresentations,
      and(
        eq(revisionPresentations.revisionId, titleRevisions.id),
        eq(revisionPresentations.state, 'published')
      )
    )
    .where(inArray(titles.id, requestedTitleIds));
  const eligible = rows.filter(
    (row) =>
      row.visibility === 'public' &&
      row.priceMinor > 0 &&
      row.activeRevisionId !== null &&
      row.revisionId === row.activeRevisionId &&
      row.revisionState === 'active' &&
      row.presentationId !== null &&
      row.presentationState === 'published' &&
      row.presentationPublishedAt !== null
  );
  const eligibleIds = new Set(eligible.map((row) => row.titleId));
  const unavailableTitleIds = requestedTitleIds.filter((id) => !eligibleIds.has(id));

  const userId = actorUserId(actor);
  const ownedIds = new Set<string>();
  const claimableIds = new Set<string>();
  const reservedIds = new Set<string>();
  if (userId && eligible.length > 0) {
    const eligibleTitleIds = eligible.map((row) => row.titleId);
    const activeEntitlements = await database
      .select({ titleId: entitlements.titleId })
      .from(entitlements)
      .where(
        and(
          eq(entitlements.userId, userId),
          inArray(
            entitlements.titleId,
            eligibleTitleIds
          ),
          isNull(entitlements.revokedAt)
        )
    );
    for (const entitlement of activeEntitlements) ownedIds.add(entitlement.titleId);

    const [account] = await database
      .select({ email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (account?.emailVerified) {
      const claimablePurchases = await database
        .select({ titleId: orderItems.titleId, state: entitlementGrants.state })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .innerJoin(guestIdentities, eq(guestIdentities.id, orders.guestIdentityId))
        .innerJoin(entitlementGrants, eq(entitlementGrants.orderItemId, orderItems.id))
        .where(and(
          eq(orders.status, 'paid'),
          eq(orders.purchaseEmail, account.email),
          isNull(orders.initiatingUserId),
          isNull(guestIdentities.claimedByUserId),
          inArray(entitlementGrants.state, ['unclaimed', 'suspended']),
          inArray(orderItems.titleId, eligibleTitleIds)
        ));
      for (const purchase of claimablePurchases) {
        if (purchase.state === 'unclaimed') claimableIds.add(purchase.titleId);
        else reservedIds.add(purchase.titleId);
      }
    }

    const suspendedAccountPurchases = await database
      .select({ titleId: entitlementGrants.titleId })
      .from(entitlementGrants)
      .where(and(
        eq(entitlementGrants.userId, userId),
        eq(entitlementGrants.source, 'purchase'),
        eq(entitlementGrants.state, 'suspended'),
        inArray(entitlementGrants.titleId, eligibleTitleIds)
      ));
    for (const purchase of suspendedAccountPurchases) reservedIds.add(purchase.titleId);

    const activeReservations = await database
      .select({
        titleId: orderItems.titleId,
        checkoutAttemptId: orders.clientCheckoutAttemptId,
        status: orders.status,
        createdAt: orders.createdAt
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(
        eq(orders.initiatingUserId, userId),
        inArray(orderItems.titleId, eligibleTitleIds),
        inArray(orders.status, [
          'checkout_pending',
          'checkout_open',
          'payment_pending',
          'failed',
          'exception'
        ])
      ));
    for (const reservation of activeReservations) {
      const isResumableSelfAttempt =
        checkoutAttemptId !== null &&
        reservation.checkoutAttemptId === checkoutAttemptId &&
        (reservation.status === 'checkout_pending' || reservation.status === 'checkout_open') &&
        now.getTime() <= checkoutProviderStartDeadline(reservation.createdAt).getTime();
      if (!isResumableSelfAttempt) reservedIds.add(reservation.titleId);
    }
    for (const titleId of ownedIds) {
      claimableIds.delete(titleId);
      reservedIds.delete(titleId);
    }
    for (const titleId of claimableIds) reservedIds.delete(titleId);
  }

  const purchasable = eligible
    .filter((row) =>
      !ownedIds.has(row.titleId) &&
      !claimableIds.has(row.titleId) &&
      !reservedIds.has(row.titleId)
    )
    .sort((left, right) => rawCompare(left.titleId, right.titleId));
  const currencies = new Set(purchasable.map((row) => row.currency));
  if (currencies.size > 1) throw new InvalidCartError();

  const items: CommerceQuoteItemDto[] = purchasable.map((row) => ({
    titleId: row.titleId,
    slug: row.slug,
    title: row.title,
    creatorName: row.creatorName,
    format: row.format,
    coverUrl:
      row.coverChecksumSha256 &&
      row.coverMediaType &&
      row.coverByteSize &&
      row.coverWidth &&
      row.coverHeight
        ? `/media/covers/${row.titleId}/${row.coverChecksumSha256}`
        : null,
    unitSubtotalMinor: row.priceMinor,
    currency: row.currency
  }));
  const alreadyOwnedTitleIds = [...ownedIds].sort(rawCompare);
  const claimableTitleIds = [...claimableIds].sort(rawCompare);
  const reservedTitleIds = [...reservedIds].sort(rawCompare);
  const subtotalMinor = items.reduce((total, item) => total + item.unitSubtotalMinor, 0);
  const fingerprint = createQuoteFingerprint({
    version: 1,
    actorUserId: userId,
    items: purchasable.map((row) => ({
      titleId: row.titleId,
      priceMinor: row.priceMinor,
      currency: row.currency,
      activeRevisionId: row.activeRevisionId!,
      presentationPublishedAt: row.presentationPublishedAt!.toISOString()
    })),
    alreadyOwnedTitleIds,
    claimableTitleIds,
    reservedTitleIds,
    unavailableTitleIds: [...unavailableTitleIds]
  });

  return {
    fingerprint,
    currency: currencies.values().next().value ?? null,
    subtotalMinor,
    items,
    alreadyOwnedTitleIds,
    claimableTitleIds,
    reservedTitleIds,
    unavailableTitleIds: [...unavailableTitleIds],
    taxNotice: 'calculated_at_checkout',
    canCheckout: items.length > 0
  };
}

export async function quoteCart(
  database: DatabaseExecutor,
  actor: Actor,
  titleIds: readonly string[],
  checkoutAttemptId: string | null = null,
  now = new Date()
): Promise<CommerceQuoteDto> {
  return buildQuote(database, actor, validatedTitleIds(titleIds), checkoutAttemptId, now);
}

export async function lockAndQuoteCart(
  transaction: DatabaseTransaction,
  actor: Actor,
  titleIds: readonly string[],
  checkoutAttemptId: string | null = null,
  now = new Date()
): Promise<CommerceQuoteDto> {
  const requestedTitleIds = validatedTitleIds(titleIds);
  for (const titleId of requestedTitleIds) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${titleId}, 0))`
    );
  }
  const userId = actorUserId(actor);
  if (userId) {
    await lockEntitlementScopes(
      transaction,
      requestedTitleIds.map((titleId) => ({ userId, titleId }))
    );
  }
  return buildQuote(transaction, actor, requestedTitleIds, checkoutAttemptId, now);
}
