import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';

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

export type CredentialAuthorityRow = typeof credentialAuthority.$inferSelect;
