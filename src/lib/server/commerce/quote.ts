import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  entitlements,
  revisionPresentations,
  titleRevisions,
  titles
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
  unavailableTitleIds: string[];
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
    unavailableTitleIds: [...input.unavailableTitleIds].sort(rawCompare)
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function validatedTitleIds(titleIds: readonly string[]): string[] {
  const parsed = quoteRequestSchema.safeParse({ titleIds: [...titleIds] });
  if (!parsed.success || new Set(parsed.data.titleIds).size !== parsed.data.titleIds.length) {
    throw new InvalidCartError();
  }
  return [...parsed.data.titleIds].sort(rawCompare);
}

function actorUserId(actor: Actor): string | null {
  return actor.type === 'user' ? actor.id : null;
}

async function buildQuote(
  database: DatabaseExecutor,
  actor: Actor,
  requestedTitleIds: readonly string[]
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
  if (userId && eligible.length > 0) {
    const activeEntitlements = await database
      .select({ titleId: entitlements.titleId })
      .from(entitlements)
      .where(
        and(
          eq(entitlements.userId, userId),
          inArray(
            entitlements.titleId,
            eligible.map((row) => row.titleId)
          ),
          isNull(entitlements.revokedAt)
        )
      );
    for (const entitlement of activeEntitlements) ownedIds.add(entitlement.titleId);
  }

  const purchasable = eligible
    .filter((row) => !ownedIds.has(row.titleId))
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
    unavailableTitleIds: [...unavailableTitleIds]
  });

  return {
    fingerprint,
    currency: currencies.values().next().value ?? null,
    subtotalMinor,
    items,
    alreadyOwnedTitleIds,
    unavailableTitleIds: [...unavailableTitleIds],
    taxNotice: 'calculated_at_checkout',
    canCheckout: items.length > 0
  };
}

export async function quoteCart(
  database: DatabaseExecutor,
  actor: Actor,
  titleIds: readonly string[]
): Promise<CommerceQuoteDto> {
  return buildQuote(database, actor, validatedTitleIds(titleIds));
}

export async function lockAndQuoteCart(
  transaction: DatabaseTransaction,
  actor: Actor,
  titleIds: readonly string[]
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
  return buildQuote(transaction, actor, requestedTitleIds);
}
