import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { databaseClient } from './database';

beforeEach(async () => {
  await databaseClient.db.execute(sql`
    truncate table
      audit_events, outbox_messages, jobs, title_revisions, titles,
      guest_identities, user_roles, verification, account, session, rate_limit, "user"
    restart identity cascade
  `);
});

afterAll(async () => {
  await databaseClient.close();
});
