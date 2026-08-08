import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { databaseClient } from './database';

beforeEach(async () => {
  await databaseClient.db.execute(sql`
    truncate table audit_events, outbox_messages, jobs, title_revisions, titles
    restart identity cascade
  `);
});

afterAll(async () => {
  await databaseClient.close();
});
