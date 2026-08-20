import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import {
  databaseClient,
  ownerDatabaseClient,
  storageCleanupDatabaseClient,
  workerDatabaseClient
} from './database';

beforeEach(async () => {
  await ownerDatabaseClient.db.execute(sql`
    truncate table
      refund_allocation_finalization_effects,
      refund_reporting_correction_items, refund_reporting_correction_sets,
      refund_allocation_draft_items, refund_allocation_drafts,
      financial_item_allocations, refund_allocation_components,
      dispute_item_allocations, financial_allocation_sets,
      stripe_payout_balance_transactions, payout_import_run_entries,
      payout_import_runs, stripe_balance_transaction_fee_details,
      stripe_payouts, stripe_balance_transactions,
      financial_projection_versions, financial_classification_versions,
      financial_reconciliation_issues,
      financial_payout_discovery_state,
      financial_scan_runs,
      entitlement_grants, refund_allocations, disputes, refunds,
      payments, order_items, orders, stripe_events, application_rate_limits,
      reader_bookmarks, reader_progress, reader_revision_migrations,
      reader_title_preferences, reader_preferences, entitlements,
      comic_panel_regions, revision_presentations, prose_blocks, prose_images,
      prose_sections, comic_pages, revision_cover_suggestions,
      revision_ingestion_warnings,
      audit_events, commerce_claim_issuances, outbox_messages, jobs, title_revisions, titles,
      guest_identities, user_roles, verification, account, session, rate_limit, "user"
    restart identity cascade
  `);
  await ownerDatabaseClient.db.execute(sql`
    insert into financial_projection_versions
      (singleton, classifier_version, allocation_algorithm_version, activation_correlation_id)
    values (true, 1, 1, 'integration-reset-c1-a1')
  `);
  await ownerDatabaseClient.db.execute(sql`
    insert into financial_payout_discovery_state (singleton, covered_through)
    values (true, null)
  `);
});

afterAll(async () => {
  await Promise.all([
    databaseClient.close(),
    ownerDatabaseClient.close(),
    workerDatabaseClient.close(),
    storageCleanupDatabaseClient.close()
  ]);
});
