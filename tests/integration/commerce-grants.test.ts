import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  entitlementGrants,
  entitlements,
  orderItems,
  orders,
  titles,
  user,
  type EntitlementGrantRow
} from '$lib/server/db/schema';
import { CommerceConflictError } from '$lib/server/commerce/errors';
import {
  assertGrantTransitionAllowed,
  projectEffectiveEntitlement,
  setPreservedGrantState
} from '$lib/server/commerce/grants';
import { lockEntitlementScopes } from '$lib/server/commerce/lock';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { databaseClient } from './database';

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await databaseClient.db.insert(user).values({
    id,
    name: label,
    email: `${id}@example.com`,
    emailVerified: true
  });
  return id;
}

async function createTitle(label: string): Promise<string> {
  const [title] = await databaseClient.db
    .insert(titles)
    .values({
      slug: `commerce-grant-${randomUUID()}`,
      title: label,
      description: 'Commerce grant projection fixture',
      creatorName: 'Pale Orbit',
      format: 'prose',
      priceMinor: 1000,
      currency: 'USD'
    })
    .returning({ id: titles.id });
  if (!title) throw new Error('Expected title fixture');
  return title.id;
}

async function createPreservedGrant(
  userId: string,
  titleId: string,
  state: EntitlementGrantRow['state'] = 'active'
): Promise<string> {
  const now = new Date();
  const [grant] = await databaseClient.db
    .insert(entitlementGrants)
    .values({
      userId,
      titleId,
      source: 'preserved',
      state,
      stateReason: 'test_preserved_access',
      suspendedAt: state === 'suspended' ? now : null,
      revokedAt: state === 'revoked' ? now : null
    })
    .returning({ id: entitlementGrants.id });
  if (!grant) throw new Error('Expected preserved grant fixture');
  return grant.id;
}

async function createPurchaseGrant(
  titleId: string,
  userId: string | null,
  state: EntitlementGrantRow['state']
): Promise<string> {
  const [order] = await databaseClient.db
    .insert(orders)
    .values({
      initiatingUserId: userId,
      purchaseEmail: userId ? `${userId}@example.com` : null,
      currency: 'USD',
      subtotalMinor: 1000,
      clientCheckoutAttemptId: randomUUID(),
      quoteFingerprintSha256: 'a'.repeat(64),
      statusTokenSha256: 'b'.repeat(64)
    })
    .returning({ id: orders.id });
  if (!order) throw new Error('Expected order fixture');
  const [item] = await databaseClient.db
    .insert(orderItems)
    .values({
      orderId: order.id,
      titleId,
      titleSnapshot: 'Safe title snapshot',
      creatorNameSnapshot: 'Safe creator snapshot',
      format: 'prose',
      currency: 'USD',
      unitSubtotalMinor: 1000
    })
    .returning({ id: orderItems.id });
  if (!item) throw new Error('Expected order item fixture');
  const now = new Date();
  const [grant] = await databaseClient.db
    .insert(entitlementGrants)
    .values({
      titleId,
      userId,
      source: 'purchase',
      orderItemId: item.id,
      state,
      stateReason: `test_purchase_${state}`,
      suspendedAt: state === 'suspended' ? now : null,
      revokedAt: state === 'revoked' ? now : null
    })
    .returning({ id: entitlementGrants.id });
  if (!grant) throw new Error('Expected purchase grant fixture');
  return grant.id;
}

async function setGrantState(
  transaction: DatabaseTransaction,
  grantId: string,
  state: EntitlementGrantRow['state'],
  now: Date
): Promise<void> {
  await transaction
    .update(entitlementGrants)
    .set({
      state,
      stateReason: `test_${state}`,
      suspendedAt: state === 'suspended' ? now : null,
      revokedAt: state === 'revoked' ? now : null,
      updatedAt: now
    })
    .where(eq(entitlementGrants.id, grantId));
}

async function readEntitlement(userId: string, titleId: string) {
  const [row] = await databaseClient.db
    .select()
    .from(entitlements)
    .where(and(eq(entitlements.userId, userId), eq(entitlements.titleId, titleId)))
    .limit(1);
  return row;
}

describe('durable grant projection', () => {
  it('maintains preserved test access through the production projection path', async () => {
    const userId = await createUser('Preserved Maintenance Customer');
    const titleId = await createTitle('Preserved Maintenance Title');
    const grantedAt = new Date(Date.now() + 60 * 60 * 1000);

    const activated = await databaseClient.db.transaction((transaction) =>
      setPreservedGrantState(transaction, {
        userId,
        titleId,
        active: true,
        stateReason: 'test_preserved_access',
        now: grantedAt
      })
    );
    expect(activated).toEqual({ beforeActive: false, afterActive: true });
    const [firstGrant] = await databaseClient.db
      .select()
      .from(entitlementGrants)
      .where(
        and(
          eq(entitlementGrants.userId, userId),
          eq(entitlementGrants.titleId, titleId),
          eq(entitlementGrants.source, 'preserved')
        )
      );
    expect(firstGrant).toMatchObject({ state: 'active', grantedAt });

    const revokedAt = new Date(grantedAt.getTime() + 60 * 60 * 1000);
    await expect(
      databaseClient.db.transaction((transaction) =>
        setPreservedGrantState(transaction, {
          userId,
          titleId,
          active: false,
          stateReason: 'test_preserved_revoked',
          now: revokedAt
        })
      )
    ).resolves.toEqual({ beforeActive: true, afterActive: false });
    expect(await readEntitlement(userId, titleId)).toMatchObject({ revokedAt });

    const reactivatedAt = new Date(revokedAt.getTime() + 60 * 60 * 1000);
    await databaseClient.db.transaction((transaction) =>
      setPreservedGrantState(transaction, {
        userId,
        titleId,
        active: true,
        stateReason: 'test_preserved_reactivated',
        now: reactivatedAt
      })
    );
    const [reactivatedGrant] = await databaseClient.db
      .select()
      .from(entitlementGrants)
      .where(eq(entitlementGrants.id, firstGrant!.id));
    expect(reactivatedGrant).toMatchObject({ id: firstGrant!.id, state: 'active', grantedAt });
  });

  it('creates, revokes, and reactivates one effective entitlement without resetting grantedAt', async () => {
    const userId = await createUser('Projection Customer');
    const titleId = await createTitle('Projection Title');
    const grantId = await createPreservedGrant(userId, titleId);
    const activatedAt = new Date(Date.now() + 60 * 60 * 1000);

    await expect(
      databaseClient.db.transaction((transaction) =>
        projectEffectiveEntitlement(transaction, userId, titleId, activatedAt)
      )
    ).resolves.toEqual({ beforeActive: false, afterActive: true });
    const activated = await readEntitlement(userId, titleId);
    expect(activated).toMatchObject({ revokedAt: null, grantedAt: activatedAt });

    const revokedAt = new Date(activatedAt.getTime() + 60 * 60 * 1000);
    await databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      await setGrantState(transaction, grantId, 'revoked', revokedAt);
      await expect(
        projectEffectiveEntitlement(transaction, userId, titleId, revokedAt)
      ).resolves.toEqual({ beforeActive: true, afterActive: false });
    });
    const revoked = await readEntitlement(userId, titleId);
    expect(revoked).toMatchObject({ grantedAt: activatedAt, revokedAt });

    const reactivatedAt = new Date(revokedAt.getTime() + 60 * 60 * 1000);
    await databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      await setGrantState(transaction, grantId, 'active', reactivatedAt);
      await expect(
        projectEffectiveEntitlement(transaction, userId, titleId, reactivatedAt)
      ).resolves.toEqual({ beforeActive: false, afterActive: true });
    });
    const reactivated = await readEntitlement(userId, titleId);
    expect(reactivated).toMatchObject({ grantedAt: activatedAt, revokedAt: null });
  });

  it('keeps access active while another purchase or preserved grant remains active', async () => {
    const userId = await createUser('Multiple Grant Customer');
    const titleId = await createTitle('Multiple Grant Title');
    const preservedId = await createPreservedGrant(userId, titleId);
    const purchaseId = await createPurchaseGrant(titleId, userId, 'active');
    const now = new Date(Date.now() + 60 * 60 * 1000);
    await databaseClient.db.transaction((transaction) =>
      projectEffectiveEntitlement(transaction, userId, titleId, now)
    );

    await databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      await setGrantState(transaction, purchaseId, 'revoked', now);
      await expect(
        projectEffectiveEntitlement(transaction, userId, titleId, now)
      ).resolves.toEqual({ beforeActive: true, afterActive: true });
    });
    expect((await readEntitlement(userId, titleId))?.revokedAt).toBeNull();

    await databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      await setGrantState(transaction, preservedId, 'revoked', now);
      await expect(
        projectEffectiveEntitlement(transaction, userId, titleId, now)
      ).resolves.toEqual({ beforeActive: true, afterActive: false });
    });
  });

  it('restores a suspended purchase after a won dispute but never a revoked purchase', async () => {
    const userId = await createUser('Dispute Customer');
    const titleId = await createTitle('Dispute Title');
    const grantId = await createPurchaseGrant(titleId, userId, 'active');
    const now = new Date(Date.now() + 60 * 60 * 1000);
    await databaseClient.db.transaction((transaction) =>
      projectEffectiveEntitlement(transaction, userId, titleId, now)
    );

    await databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      await setGrantState(transaction, grantId, 'suspended', now);
      await projectEffectiveEntitlement(transaction, userId, titleId, now);
    });
    expect((await readEntitlement(userId, titleId))?.revokedAt).toEqual(now);

    await databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      const [grant] = await transaction
        .select({ source: entitlementGrants.source, state: entitlementGrants.state })
        .from(entitlementGrants)
        .where(eq(entitlementGrants.id, grantId))
        .for('update');
      if (!grant) throw new Error('Expected locked grant');
      assertGrantTransitionAllowed(grant, 'active', 'dispute');
      await setGrantState(transaction, grantId, 'active', now);
      await projectEffectiveEntitlement(transaction, userId, titleId, now);
    });
    expect((await readEntitlement(userId, titleId))?.revokedAt).toBeNull();

    await databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      await setGrantState(transaction, grantId, 'revoked', now);
      await projectEffectiveEntitlement(transaction, userId, titleId, now);
    });
    await expect(
      databaseClient.db.transaction(async (transaction) => {
        await lockEntitlementScopes(transaction, [{ userId, titleId }]);
        const [grant] = await transaction
          .select({ source: entitlementGrants.source, state: entitlementGrants.state })
          .from(entitlementGrants)
          .where(eq(entitlementGrants.id, grantId))
          .for('update');
        if (!grant) throw new Error('Expected locked grant');
        assertGrantTransitionAllowed(grant, 'active', 'dispute');
      })
    ).rejects.toBeInstanceOf(CommerceConflictError);
    expect((await readEntitlement(userId, titleId))?.revokedAt).toEqual(now);
  });

  it('never projects an unclaimed purchase grant', async () => {
    const userId = await createUser('Unclaimed Observer');
    const titleId = await createTitle('Unclaimed Title');
    await createPurchaseGrant(titleId, null, 'unclaimed');

    await expect(
      databaseClient.db.transaction((transaction) =>
        projectEffectiveEntitlement(transaction, userId, titleId)
      )
    ).resolves.toEqual({ beforeActive: false, afterActive: false });
    expect(await readEntitlement(userId, titleId)).toBeUndefined();
  });

  it('waits for the same scope and re-reads grants after acquiring the lock', async () => {
    const userId = await createUser('Concurrent Customer');
    const titleId = await createTitle('Concurrent Title');
    const grantId = await createPreservedGrant(userId, titleId);
    await databaseClient.db.transaction((transaction) =>
      projectEffectiveEntitlement(transaction, userId, titleId)
    );

    let releaseBlocker!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const revokedAt = new Date(Date.now() + 60 * 60 * 1000);
    const blocker = databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [{ userId, titleId }]);
      signalLocked();
      await release;
      await setGrantState(transaction, grantId, 'revoked', revokedAt);
    });
    await locked;

    const waitingProjection = databaseClient.db.transaction((transaction) =>
      projectEffectiveEntitlement(transaction, userId, titleId, revokedAt)
    );
    releaseBlocker();
    await blocker;
    await expect(waitingProjection).resolves.toEqual({
      beforeActive: true,
      afterActive: false
    });
    expect((await readEntitlement(userId, titleId))?.revokedAt).toEqual(revokedAt);
  });

  it('allows an independent user/title scope to project while another scope is locked', async () => {
    const firstUserId = await createUser('Blocked Scope Customer');
    const firstTitleId = await createTitle('Blocked Scope Title');
    const secondUserId = await createUser('Independent Scope Customer');
    const secondTitleId = await createTitle('Independent Scope Title');
    await createPreservedGrant(firstUserId, firstTitleId);
    await createPreservedGrant(secondUserId, secondTitleId);

    let releaseBlocker!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const blocker = databaseClient.db.transaction(async (transaction) => {
      await lockEntitlementScopes(transaction, [
        { userId: firstUserId, titleId: firstTitleId }
      ]);
      signalLocked();
      await release;
    });
    await locked;
    const waitingProjection = databaseClient.db.transaction((transaction) =>
      projectEffectiveEntitlement(transaction, firstUserId, firstTitleId)
    );

    await expect(
      databaseClient.db.transaction((transaction) =>
        projectEffectiveEntitlement(transaction, secondUserId, secondTitleId)
      )
    ).resolves.toEqual({ beforeActive: false, afterActive: true });
    releaseBlocker();
    await blocker;
    await expect(waitingProjection).resolves.toEqual({
      beforeActive: false,
      afterActive: true
    });
  });
});
