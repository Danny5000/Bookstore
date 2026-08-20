import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  commerceClaimTokenSha256,
  createCommerceClaimProofToken,
  registerCommerceClaimIssuance
} from '$lib/server/auth/commerce-claim-capability';
import { createRevisionSkeleton } from '$lib/server/catalog/service';
import {
  account,
  credentialAuthority,
  entitlementGrants,
  guestIdentities,
  jobs,
  orderItems,
  orders,
  payments,
  titleRevisions,
  titles,
  user
} from '$lib/server/db/schema';
import { databaseClient, ownerDatabaseClient, workerDatabaseClient } from './database';

const issuanceFunctions = [
  'public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)',
  'public.authorize_commerce_claim_issuance(text,text)',
  'public.claim_guest_purchases_after_authorization(text,text)',
  'public.purge_commerce_claim_issuances()',
  'public.outbox_message_exists_by_deduplication_key(text)',
  'public.outbox_message_deduplication_metadata(text,text,jsonb)'
] as const;
const issuanceFunctionNames = issuanceFunctions.map(
  (signature) => signature.slice('public.'.length, signature.indexOf('('))
);
const routinePrivilegeQuery = `
  select
    has_function_privilege(current_user,
      'public.register_commerce_claim_issuance(text,text,text,uuid,text,timestamp with time zone)',
      'EXECUTE') as can_register,
    has_function_privilege(current_user,
      'public.authorize_commerce_claim_issuance(text,text)', 'EXECUTE') as can_authorize,
    has_function_privilege(current_user,
      'public.claim_guest_purchases_after_authorization(text,text)', 'EXECUTE') as can_claim,
    has_function_privilege(current_user,
      'public.purge_commerce_claim_issuances()', 'EXECUTE') as can_purge
`;

interface ExpiringClaimFixture {
  email: string;
  orderId: string;
}

async function createExpiringClaimFixture(): Promise<ExpiringClaimFixture> {
  const suffix = randomUUID();
  const claimantId = randomUUID();
  const titleId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const email = `claim-expiry-${suffix}@example.com`;
  const password = `claim-expiry-password-${suffix}`;
  const paidAt = new Date('2026-08-10T12:05:00.000Z');

  await ownerDatabaseClient.db.insert(user).values({
    id: claimantId,
    name: 'Claim expiry reader',
    email,
    emailVerified: true
  });
  await ownerDatabaseClient.db.insert(account).values({
    accountId: claimantId,
    providerId: 'credential',
    userId: claimantId,
    password
  });
  await ownerDatabaseClient.db.insert(credentialAuthority).values({
    userId: claimantId,
    authorizedPasswordHash: password,
    resetEpochSha256: null
  });
  await ownerDatabaseClient.db.insert(titles).values({
    id: titleId,
    slug: `claim-expiry-${titleId}`,
    title: 'Claim expiry fixture',
    description: 'Wall-clock claim expiry fixture',
    creatorName: 'Authority fixture',
    format: 'prose',
    priceMinor: 1100,
    currency: 'USD',
    visibility: 'private'
  });
  const [identity] = await ownerDatabaseClient.db.insert(guestIdentities).values({ email })
    .returning();
  if (!identity) throw new Error('Expected expiry guest identity');
  await ownerDatabaseClient.db.insert(orders).values({
    id: orderId,
    status: 'paid',
    initiatingUserId: null,
    guestIdentityId: identity.id,
    purchaseEmail: email,
    currency: 'USD',
    subtotalMinor: 1100,
    taxMinor: 0,
    totalMinor: 1100,
    clientCheckoutAttemptId: randomUUID(),
    quoteFingerprintSha256: 'f'.repeat(64),
    stripeCheckoutSessionId: `cs_claim_expiry_${suffix}`,
    statusTokenSha256: 'e'.repeat(64),
    checkoutExpiresAt: new Date('2026-08-10T12:30:00.000Z'),
    paidAt
  });
  await ownerDatabaseClient.db.insert(orderItems).values({
    id: orderItemId,
    orderId,
    titleId,
    titleSnapshot: 'Claim expiry fixture',
    creatorNameSnapshot: 'Authority fixture',
    format: 'prose',
    currency: 'USD',
    unitSubtotalMinor: 1100,
    taxMinor: 0,
    totalMinor: 1100,
    stripeLineItemId: `li_claim_expiry_${suffix}`
  });
  await ownerDatabaseClient.db.insert(payments).values({
    orderId,
    stripePaymentIntentId: `pi_claim_expiry_${suffix}`,
    stripeLatestChargeId: `ch_claim_expiry_${suffix}`,
    status: 'succeeded',
    amountMinor: 1100,
    currency: 'USD',
    paymentMethodCategory: 'card',
    paidAt
  });
  await ownerDatabaseClient.db.insert(entitlementGrants).values({
    titleId,
    userId: null,
    source: 'purchase',
    orderItemId,
    state: 'unclaimed',
    stateReason: 'payment_succeeded',
    grantedAt: paidAt
  });
  return { email, orderId };
}

async function databaseExpiry(milliseconds: number): Promise<Date> {
  const result = await ownerDatabaseClient.pool.query<{ expires_at: Date }>(`
    select clock_timestamp() + ($1::integer * interval '1 millisecond') as expires_at
  `, [milliseconds]);
  const expiresAt = result.rows[0]?.expires_at;
  if (!(expiresAt instanceof Date)) throw new Error('Expected database expiry timestamp');
  return expiresAt;
}

async function sleepPastExpiry(
  client: import('pg').PoolClient,
  expiresAt: Date
): Promise<void> {
  await client.query(`
    select pg_sleep(
      (greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))) + 0.1)
        ::double precision
    )
  `, [expiresAt]);
  const result = await client.query<{ expired: boolean }>(`
    select clock_timestamp() >= $1::timestamptz as expired
  `, [expiresAt]);
  expect(result.rows[0]?.expired).toBe(true);
}

describe('commerce claim database authority', () => {
  it('lets the web catalog path insert a defaulted revision through exact granted columns', async () => {
    const actorId = randomUUID();
    const [title] = await ownerDatabaseClient.db.insert(titles).values({
      slug: `runtime-revision-${randomUUID()}`,
      title: 'Runtime revision authority',
      description: 'Exact-column revision insertion witness',
      creatorName: 'Authority fixture',
      format: 'prose',
      priceMinor: 1200,
      currency: 'USD'
    }).returning();
    if (!title) throw new Error('Expected title fixture');

    const revision = await createRevisionSkeleton(databaseClient.db, {
      actor: { type: 'user', id: actorId, roles: ['customer', 'admin'] },
      correlationId: `runtime-revision-${randomUUID()}`,
      input: {
        titleId: title.id,
        parentRevisionId: null,
        changeSummary: 'Exact-column web revision'
      }
    });

    expect(revision).toMatchObject({
      titleId: title.id,
      parentRevisionId: null,
      state: 'uploaded',
      createdByActorId: actorId,
      changeSummary: 'Exact-column web revision',
      ingestionGeneration: 0,
      derivationVersion: 1,
      stagingByteSize: null,
      createdAt: expect.any(Date)
    });
    expect(await ownerDatabaseClient.db.select().from(titleRevisions)
      .where(eq(titleRevisions.id, revision.id))).toHaveLength(1);
    expect(await ownerDatabaseClient.db.select().from(jobs)
      .where(eq(jobs.deduplicationKey, `catalog.ingest:${revision.id}:0`)))
      .toEqual([]);
  });

  it('limits guest identity creation to email and denies raw web ownership mutations', async () => {
    const webEmail = `web-guest-${randomUUID()}@example.com`;
    const workerEmail = `worker-guest-${randomUUID()}@example.com`;
    const webIdentity = await databaseClient.pool.query<{ id: string; email: string }>(`
      insert into guest_identities (email)
      values ($1)
      returning id, email
    `, [webEmail]);
    expect(webIdentity.rows[0]?.email).toBe(webEmail);
    await expect(workerDatabaseClient.pool.query(`
      insert into guest_identities (email)
      values ($1)
    `, [workerEmail])).resolves.toMatchObject({ rowCount: 1 });
    await expect(databaseClient.pool.query(
      'select id from guest_identities where id = $1 for update',
      [webIdentity.rows[0]!.id]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(workerDatabaseClient.pool.query(
      'select id from guest_identities where id = $1 for update',
      [webIdentity.rows[0]!.id]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(databaseClient.pool.query(
      'update guest_identities set updated_at = clock_timestamp() where id = $1',
      [webIdentity.rows[0]!.id]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query(
      'update guest_identities set updated_at = clock_timestamp() where id = $1',
      [webIdentity.rows[0]!.id]
    )).rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query(
      'update guest_identities set id = $2 where id = $1',
      [webIdentity.rows[0]!.id, randomUUID()]
    )).rejects.toMatchObject({ code: '42501' });

    await expect(databaseClient.pool.query(`
      insert into guest_identities (email, claimed_by_user_id, claimed_at)
      values ($1, $2, clock_timestamp())
    `, [`forged-${randomUUID()}@example.com`, randomUUID()]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query(`
      insert into guest_identities (email, claimed_by_user_id, claimed_at)
      values ($1, $2, clock_timestamp())
    `, [`worker-forged-${randomUUID()}@example.com`, randomUUID()]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query(`
      update guest_identities
      set claimed_by_user_id = $2, claimed_at = clock_timestamp()
      where id = $1
    `, [webIdentity.rows[0]!.id, randomUUID()]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query(`
      update guest_identities
      set claimed_by_user_id = $2, claimed_at = clock_timestamp()
      where id = $1
    `, [webIdentity.rows[0]!.id, randomUUID()]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query(
      'delete from guest_identities where id = $1',
      [webIdentity.rows[0]!.id]
    )).rejects.toMatchObject({ code: '42501' });

    for (const statement of [
      `insert into entitlement_grants
        (title_id, user_id, source, state, state_reason)
       values ('00000000-0000-4000-8000-000000000001', null,
         'purchase', 'unclaimed', 'forged')`,
      'update entitlement_grants set updated_at = clock_timestamp() where false',
      'delete from entitlement_grants where false',
      `insert into entitlements
        (user_id, title_id)
       values ('00000000-0000-4000-8000-000000000001',
         '00000000-0000-4000-8000-000000000002')`,
      'update entitlements set revoked_at = clock_timestamp() where false',
      'delete from entitlements where false',
      `insert into commerce_claim_issuances
        (claim_proof_sha256, auth_token_sha256, normalized_email,
         anchor_order_id, kind, expires_at)
       values (repeat('a', 64), repeat('b', 64), 'forged@example.com',
         '00000000-0000-4000-8000-000000000001', 'password-reset',
         clock_timestamp() + interval '10 minutes')`
    ]) {
      await expect(databaseClient.pool.query(statement))
        .rejects.toMatchObject({ code: '42501' });
    }
  });

  it('keeps claim proofs and outbox payloads unreadable with exact routine grants', async () => {
    await expect(databaseClient.pool.query('select * from commerce_claim_issuances limit 0'))
      .rejects.toMatchObject({ code: '42501' });
    await expect(workerDatabaseClient.pool.query('select * from commerce_claim_issuances limit 0'))
      .rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query('select payload from outbox_messages limit 0'))
      .rejects.toMatchObject({ code: '42501' });
    await expect(databaseClient.pool.query(`
      select id, topic, deduplication_key, dispatch_job_id, status, last_error,
        delivered_at, created_at, updated_at
      from outbox_messages
      limit 0
    `)).resolves.toMatchObject({ rowCount: 0 });
    await expect(workerDatabaseClient.pool.query('select payload from outbox_messages limit 0'))
      .resolves.toMatchObject({ rowCount: 0 });

    const publicColumnSelect = await ownerDatabaseClient.pool.query<{
      relation_name: string;
      column_name: string;
    }>(`
      select relation.relname as relation_name, attribute.attname as column_name
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
      cross join lateral pg_catalog.aclexplode(attribute.attacl) privilege
      where namespace.nspname = 'public'
        and (
          (relation.relname = 'commerce_claim_issuances' and attribute.attnum > 0) or
          (relation.relname = 'outbox_messages' and attribute.attname = 'payload')
        )
        and not attribute.attisdropped
        and privilege.grantee = 0
        and privilege.privilege_type = 'SELECT'
    `);
    expect(publicColumnSelect.rows).toEqual([]);
    const publicTableSelect = await ownerDatabaseClient.pool.query<{ relation_name: string }>(`
      select relation.relname as relation_name
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) privilege
      where namespace.nspname = 'public'
        and relation.relname = 'commerce_claim_issuances'
        and privilege.grantee = 0
        and privilege.privilege_type = 'SELECT'
    `);
    expect(publicTableSelect.rows).toEqual([]);

    const publicExecute = await ownerDatabaseClient.pool.query<{ function_name: string }>(`
      select routine.proname as function_name
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      cross join lateral pg_catalog.aclexplode(
        coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
      ) privilege
      where namespace.nspname = 'public'
        and routine.proname = any($1::text[])
        and privilege.grantee = 0
        and privilege.privilege_type = 'EXECUTE'
    `, [issuanceFunctionNames]);
    expect(publicExecute.rows).toEqual([]);

    const runtimePrivileges = await databaseClient.pool.query<{
      can_register: boolean;
      can_authorize: boolean;
      can_claim: boolean;
      can_purge: boolean;
    }>(routinePrivilegeQuery);
    expect(runtimePrivileges.rows[0]).toEqual({
      can_register: false,
      can_authorize: true,
      can_claim: true,
      can_purge: false
    });
    const workerPrivileges = await workerDatabaseClient.pool.query<{
      can_register: boolean;
      can_authorize: boolean;
      can_claim: boolean;
      can_purge: boolean;
    }>(routinePrivilegeQuery);
    expect(workerPrivileges.rows[0]).toEqual({
      can_register: true,
      can_authorize: true,
      can_claim: true,
      can_purge: true
    });
  });

  it('rejects forged native verification state without the independent claim proof', async () => {
    const claimProof = createCommerceClaimProofToken();
    const nativeToken = `native-${randomUUID()}`;
    await databaseClient.pool.query(`
      insert into verification (identifier, value, expires_at)
      values ('forged-claim@example.com', $1, clock_timestamp() + interval '10 minutes')
    `, [nativeToken]);

    const authorization = await databaseClient.pool.query<{ authorized: boolean }>(`
      select authorize_commerce_claim_issuance($1, $2) as authorized
    `, [claimProof, nativeToken]);
    expect(authorization.rows[0]?.authorized).toBe(false);
    const claim = await databaseClient.pool.query<{
      claimed: boolean;
      definitive_invalid: boolean;
    }>(`
      select claimed, definitive_invalid
      from claim_guest_purchases_after_authorization($1, $2)
    `, [claimProof, `forged-native-${randomUUID()}`]);
    expect(claim.rows[0]).toEqual({ claimed: false, definitive_invalid: true });
  });

  it('expires authorization and claim against wall time inside an older transaction', async () => {
    const fixture = await createExpiringClaimFixture();

    const expiredProof = createCommerceClaimProofToken();
    const expiredAuthToken = createCommerceClaimProofToken();
    const expiredAt = await databaseExpiry(2_000);
    await expect(registerCommerceClaimIssuance(workerDatabaseClient.db, {
      claimProofSha256: commerceClaimTokenSha256(expiredProof),
      authTokenSha256: commerceClaimTokenSha256(expiredAuthToken),
      email: fixture.email,
      anchorOrderId: fixture.orderId,
      kind: 'password-reset',
      expiresAt: expiredAt
    })).resolves.toBe(true);

    const authorizationClient = await databaseClient.pool.connect();
    try {
      await authorizationClient.query('begin');
      await expect(authorizationClient.query<{ before_expiry: boolean }>(`
        select transaction_timestamp() < $1::timestamptz as before_expiry
      `, [expiredAt])).resolves.toMatchObject({ rows: [{ before_expiry: true }] });
      await sleepPastExpiry(authorizationClient, expiredAt);
      const authorization = await authorizationClient.query<{ authorized: boolean }>(`
        select authorize_commerce_claim_issuance($1, $2) as authorized
      `, [expiredProof, expiredAuthToken]);
      expect(authorization.rows[0]?.authorized).toBe(false);
    } finally {
      await authorizationClient.query('rollback').catch(() => undefined);
      authorizationClient.release();
    }

    const claimProof = createCommerceClaimProofToken();
    const claimAuthToken = createCommerceClaimProofToken();
    const claimExpiresAt = await databaseExpiry(2_000);
    await expect(registerCommerceClaimIssuance(workerDatabaseClient.db, {
      claimProofSha256: commerceClaimTokenSha256(claimProof),
      authTokenSha256: commerceClaimTokenSha256(claimAuthToken),
      email: fixture.email,
      anchorOrderId: fixture.orderId,
      kind: 'password-reset',
      expiresAt: claimExpiresAt
    })).resolves.toBe(true);

    const claimClient = await databaseClient.pool.connect();
    try {
      await claimClient.query('begin');
      const authorization = await claimClient.query<{ authorized: boolean }>(`
        select authorize_commerce_claim_issuance($1, $2) as authorized
      `, [claimProof, claimAuthToken]);
      expect(authorization.rows[0]?.authorized).toBe(true);
      await sleepPastExpiry(claimClient, claimExpiresAt);
      const claim = await claimClient.query<{
        claimed: boolean;
        definitive_invalid: boolean;
      }>(`
        select claimed, definitive_invalid
        from claim_guest_purchases_after_authorization($1, $2)
      `, [claimProof, `claim-expiry-${randomUUID()}`]);
      expect(claim.rows[0]).toEqual({ claimed: false, definitive_invalid: true });
    } finally {
      await claimClient.query('rollback').catch(() => undefined);
      claimClient.release();
    }
  }, 15_000);

  it('purges only expired claim tombstones after the bounded retention period', async () => {
    const expiredDigest = 'a'.repeat(64);
    const recentDigest = 'b'.repeat(64);
    await ownerDatabaseClient.pool.query(`
      insert into commerce_claim_issuances (
        claim_proof_sha256, kind, state, issued_at, expires_at,
        authorized_at, consumed_at, result_disposition, result_changed,
        result_order_count, result_title_count
      ) values
        ($1, 'password-reset', 'consumed',
          clock_timestamp() - interval '50 hours',
          clock_timestamp() - interval '49 hours',
          clock_timestamp() - interval '48 hours',
          clock_timestamp() - interval '25 hours',
          'definitive_invalid', false, 0, 0),
        ($2, 'commerce-magic', 'consumed',
          clock_timestamp() - interval '3 hours',
          clock_timestamp() - interval '2 hours',
          clock_timestamp() - interval '90 minutes',
          clock_timestamp() - interval '1 hour',
          'definitive_invalid', false, 0, 0)
    `, [expiredDigest, recentDigest]);

    const purge = await workerDatabaseClient.pool.query<{ deleted: number }>(`
      select purge_commerce_claim_issuances() as deleted
    `);
    expect(purge.rows[0]?.deleted).toBe(1);
    const retained = await ownerDatabaseClient.pool.query<{ claim_proof_sha256: string }>(`
      select claim_proof_sha256
      from commerce_claim_issuances
      order by claim_proof_sha256
    `);
    expect(retained.rows).toEqual([{ claim_proof_sha256: recentDigest }]);
  });
});
