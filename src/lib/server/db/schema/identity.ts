import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const applicationRole = pgEnum('application_role', ['customer', 'admin']);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: applicationRole('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    grantedByUserId: uuid('granted_by_user_id').references(() => user.id, {
      onDelete: 'set null'
    })
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.role], name: 'user_roles_pk' }),
    index('user_roles_role_idx').on(table.role, table.userId)
  ]
);

export const guestIdentities = pgTable(
  'guest_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    claimedByUserId: uuid('claimed_by_user_id').references(() => user.id, {
      onDelete: 'restrict'
    }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('guest_identities_email_unique').on(table.email),
    index('guest_identities_claimed_user_idx').on(table.claimedByUserId),
    check('guest_identities_email_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
    check(
      'guest_identities_claim_state_consistent',
      sql`(${table.claimedByUserId} is null) = (${table.claimedAt} is null)`
    )
  ]
);

export type UserRoleRow = typeof userRoles.$inferSelect;
export type GuestIdentityRow = typeof guestIdentities.$inferSelect;
