import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { account, credentialAuthority, user } from '$lib/server/db/schema';
import { databaseClient } from './database';

async function migrationStatements(): Promise<readonly string[]> {
  const source = await readFile(
    new URL('../../drizzle/0006_credential_authority.sql', import.meta.url),
    'utf8'
  );
  return source
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function expectAuthorityTableRestoredEmpty(): Promise<void> {
  const restored = await databaseClient.db.execute<{ table_name: string | null }>(sql`
    select to_regclass('public.credential_authority')::text as table_name
  `);
  expect(restored.rows[0]?.table_name).toBe('credential_authority');
  expect(await databaseClient.db.select().from(credentialAuthority)).toHaveLength(0);
}

describe('credential authority migration', () => {
  it('executes the actual migration and backfills the exact legacy credential hash', async () => {
    const statements = await migrationStatements();
    const userId = randomUUID();
    const legacyHash = '$2b$12$exact-legacy-password-hash';
    const rollback = new Error('rollback successful migration fixture');

    await expect(databaseClient.db.transaction(async (transaction) => {
      await transaction.execute(sql`drop table credential_authority`);
      await transaction.insert(user).values({
        id: userId,
        name: 'Legacy credential user',
        email: 'legacy-migration@example.com',
        emailVerified: true
      });
      await transaction.insert(account).values({
        id: randomUUID(),
        accountId: 'legacy-migration@example.com',
        providerId: 'credential',
        userId,
        password: legacyHash
      });

      for (const statement of statements) {
        await transaction.execute(sql.raw(statement));
      }
      const backfilled = await transaction.execute<{
        user_id: string;
        authorized_password_hash: string;
        reset_epoch_sha256: string | null;
      }>(sql`
        select user_id, authorized_password_hash, reset_epoch_sha256
        from credential_authority
        where user_id = ${userId}
      `);
      expect(backfilled.rows).toEqual([{
        user_id: userId,
        authorized_password_hash: legacyHash,
        reset_epoch_sha256: null
      }]);
      throw rollback;
    })).rejects.toBe(rollback);

    await expectAuthorityTableRestoredEmpty();
  });

  it('rolls back the actual migration when a legacy user has duplicate credentials', async () => {
    const statements = await migrationStatements();
    const userId = randomUUID();
    const migration = databaseClient.db.transaction(async (transaction) => {
      await transaction.execute(sql`drop table credential_authority`);
      await transaction.insert(user).values({
        id: userId,
        name: 'Duplicate legacy credential user',
        email: 'duplicate-migration@example.com',
        emailVerified: true
      });
      await transaction.insert(account).values([
        {
          id: randomUUID(),
          accountId: 'duplicate-migration-a',
          providerId: 'credential',
          userId,
          password: '$2b$12$first-legacy-password-hash'
        },
        {
          id: randomUUID(),
          accountId: 'duplicate-migration-b',
          providerId: 'credential',
          userId,
          password: '$2b$12$second-legacy-password-hash'
        }
      ]);
      for (const statement of statements) {
        await transaction.execute(sql.raw(statement));
      }
    });

    await expect(migration).rejects.toThrow(
      'credential authority backfill requires exactly one credential account per user'
    );
    await expectAuthorityTableRestoredEmpty();
  });

  it('rolls back the actual migration when a legacy credential has no password hash', async () => {
    const statements = await migrationStatements();
    const userId = randomUUID();
    const migration = databaseClient.db.transaction(async (transaction) => {
      await transaction.execute(sql`drop table credential_authority`);
      await transaction.insert(user).values({
        id: userId,
        name: 'Null legacy credential user',
        email: 'null-migration@example.com',
        emailVerified: true
      });
      await transaction.insert(account).values({
        id: randomUUID(),
        accountId: 'null-migration@example.com',
        providerId: 'credential',
        userId,
        password: null
      });
      for (const statement of statements) {
        await transaction.execute(sql.raw(statement));
      }
    });

    await expect(migration).rejects.toThrow(
      'credential authority backfill requires every credential account to have a password hash'
    );
    await expectAuthorityTableRestoredEmpty();
  });
});
