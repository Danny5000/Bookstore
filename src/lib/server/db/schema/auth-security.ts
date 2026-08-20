import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { orders } from './commerce';

/**
 * Project-owned credential generation state. This deliberately lives outside
 * generated auth.ts so `npm run auth:schema` cannot erase the security boundary.
 */
export const credentialAuthority = pgTable(
  'credential_authority',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    authorizedPasswordHash: text('authorized_password_hash'),
    resetEpochSha256: text('reset_epoch_sha256'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    check(
      'credential_authority_reset_epoch_sha256_valid',
      sql`${table.resetEpochSha256} is null or ${table.resetEpochSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'credential_authority_has_authorized_hash_or_active_reset',
      sql`${table.authorizedPasswordHash} is not null or ${table.resetEpochSha256} is not null`
    )
  ]
);

/**
 * Protected mailbox proof lifecycle for guest-purchase claims. Application
 * roles never receive table access; they can only call the bounded routines
 * installed by migration 0010.
 */
export const commerceClaimIssuances = pgTable(
  'commerce_claim_issuances',
  {
    claimProofSha256: text('claim_proof_sha256').primaryKey(),
    authTokenSha256: text('auth_token_sha256'),
    normalizedEmail: text('normalized_email'),
    anchorOrderId: uuid('anchor_order_id').references(() => orders.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    state: text('state').default('issued').notNull(),
    authorizedUserId: uuid('authorized_user_id').references(() => user.id, {
      onDelete: 'restrict'
    }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    resultDisposition: text('result_disposition'),
    resultChanged: boolean('result_changed'),
    resultOrderCount: integer('result_order_count'),
    resultTitleCount: integer('result_title_count')
  },
  (table) => [
    uniqueIndex('commerce_claim_issuances_auth_token_sha256_unique')
      .on(table.authTokenSha256)
      .where(sql`${table.authTokenSha256} is not null`),
    index('commerce_claim_issuances_live_email_idx')
      .on(table.normalizedEmail, table.state, table.claimProofSha256)
      .where(sql`${table.normalizedEmail} is not null and ${table.state} in ('issued', 'authorized')`),
    index('commerce_claim_issuances_retention_idx').on(table.state, table.expiresAt, table.consumedAt),
    check(
      'commerce_claim_issuances_claim_proof_sha256_valid',
      sql`${table.claimProofSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'commerce_claim_issuances_auth_token_sha256_valid',
      sql`${table.authTokenSha256} is null or ${table.authTokenSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'commerce_claim_issuances_email_normalized',
      sql`${table.normalizedEmail} is null or ${table.normalizedEmail} = lower(btrim(${table.normalizedEmail}))`
    ),
    check(
      'commerce_claim_issuances_kind_valid',
      sql`${table.kind} in ('password-reset', 'commerce-magic')`
    ),
    check(
      'commerce_claim_issuances_lifecycle_consistent',
      sql`(
        ${table.state} = 'issued' and
        ${table.authTokenSha256} is not null and ${table.normalizedEmail} is not null and
        ${table.anchorOrderId} is not null and ${table.authorizedUserId} is null and
        ${table.authorizedAt} is null and ${table.consumedAt} is null and
        ${table.resultDisposition} is null and ${table.resultChanged} is null and
        ${table.resultOrderCount} is null and ${table.resultTitleCount} is null
      ) or (
        ${table.state} = 'authorized' and
        ${table.authTokenSha256} is not null and ${table.normalizedEmail} is not null and
        ${table.anchorOrderId} is not null and ${table.authorizedUserId} is not null and
        ${table.authorizedAt} is not null and ${table.consumedAt} is null and
        ${table.resultDisposition} is null and ${table.resultChanged} is null and
        ${table.resultOrderCount} is null and ${table.resultTitleCount} is null
      ) or (
        ${table.state} = 'consumed' and
        ${table.authTokenSha256} is null and ${table.normalizedEmail} is null and
        ${table.anchorOrderId} is null and ${table.authorizedUserId} is null and
        ${table.authorizedAt} is not null and ${table.consumedAt} is not null and
        ${table.resultDisposition} is not null and ${table.resultChanged} is not null and
        ${table.resultOrderCount} is not null and ${table.resultTitleCount} is not null
      )`
    ),
    check(
      'commerce_claim_issuances_result_valid',
      sql`(
        ${table.resultDisposition} is null and ${table.resultChanged} is null and
        ${table.resultOrderCount} is null and ${table.resultTitleCount} is null
      ) or (
        ${table.resultDisposition} in (
          'claimed', 'not_eligible', 'definitive_invalid', 'identity_conflict'
        ) and ${table.resultChanged} is not null and
        ${table.resultOrderCount} is not null and ${table.resultOrderCount} >= 0 and
        ${table.resultTitleCount} is not null and ${table.resultTitleCount} >= 0 and (
          (${table.resultDisposition} = 'claimed' and
            ${table.resultOrderCount} > 0 and ${table.resultTitleCount} > 0)
          or (${table.resultDisposition} <> 'claimed' and not ${table.resultChanged} and
            ${table.resultOrderCount} = 0 and ${table.resultTitleCount} = 0)
        )
      )`
    ),
    check(
      'commerce_claim_issuances_timestamp_order',
      sql`${table.expiresAt} > ${table.issuedAt} and
        (${table.authorizedAt} is null or ${table.authorizedAt} >= ${table.issuedAt}) and
        (${table.consumedAt} is null or ${table.consumedAt} >= ${table.authorizedAt})`
    )
  ]
);

export type CredentialAuthorityRow = typeof credentialAuthority.$inferSelect;
export type CommerceClaimIssuanceRow = typeof commerceClaimIssuances.$inferSelect;
