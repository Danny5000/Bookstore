import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { databaseClient } from './database';

beforeEach(async () => {
  await databaseClient.db.execute(sql`
    truncate table
      refund_allocations, disputes, refunds, entitlement_grants,
      payments, order_items, orders, stripe_events, application_rate_limits,
      reader_bookmarks, reader_progress, reader_revision_migrations,
      reader_title_preferences, reader_preferences, entitlements,
      comic_panel_regions, revision_presentations, prose_blocks, prose_images,
      prose_sections, comic_pages, revision_cover_suggestions,
      revision_ingestion_warnings,
      audit_events, outbox_messages, jobs, title_revisions, titles,
      guest_identities, user_roles, verification, account, session, rate_limit, "user"
    restart identity cascade
  `);
});

afterAll(async () => {
  await databaseClient.close();
});
