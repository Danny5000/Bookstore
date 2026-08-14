import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

export const balanceTransactionSourceFamilyValues = [
  'charge',
  'refund',
  'dispute',
  'payout',
  'adjustment',
  'unknown'
] as const;
export const balanceTransactionStatusValues = ['pending', 'available'] as const;
export const financialClassificationSubjectTypeValues = [
  'balance_transaction',
  'fee_detail'
] as const;
export const financialClassificationValues = [
  'charge',
  'refund',
  'refund_failure',
  'dispute_withdrawal',
  'dispute_reinstatement',
  'payout',
  'processing_fee',
  'refund_fee',
  'dispute_fee',
  'provider_fee_tax',
  'fee_credit',
  'other',
  'unknown'
] as const;
export const payoutMethodValues = ['standard', 'instant', 'unknown'] as const;
export const payoutStatusValues = [
  'pending',
  'in_transit',
  'paid',
  'failed',
  'canceled'
] as const;
export const payoutReconciliationStatusValues = [
  'completed',
  'in_progress',
  'not_applicable'
] as const;
export const payoutImportStateValues = [
  'collecting',
  'publishable',
  'published',
  'abandoned',
  'exception'
] as const;
export const financialScanStateValues = ['running', 'completed', 'exception'] as const;

export const balanceTransactionSourceFamilyEnum = pgEnum(
  'stripe_balance_transaction_source_family',
  balanceTransactionSourceFamilyValues
);
export const balanceTransactionStatusEnum = pgEnum(
  'stripe_balance_transaction_status',
  balanceTransactionStatusValues
);
export const financialClassificationSubjectTypeEnum = pgEnum(
  'financial_classification_subject_type',
  financialClassificationSubjectTypeValues
);
export const financialClassificationEnum = pgEnum(
  'financial_classification',
  financialClassificationValues
);
export const payoutMethodEnum = pgEnum('stripe_payout_method', payoutMethodValues);
export const payoutStatusEnum = pgEnum('stripe_payout_status', payoutStatusValues);
export const payoutReconciliationStatusEnum = pgEnum(
  'stripe_payout_reconciliation_status',
  payoutReconciliationStatusValues
);
export const payoutImportStateEnum = pgEnum('payout_import_state', payoutImportStateValues);
export const financialScanStateEnum = pgEnum('financial_scan_state', financialScanStateValues);

const SAFE_MONEY_MAX = 99_999_999;
const GENERATION_MAX = 2_147_483_647;
const SAFE_MONEY_MAX_SQL = sql.raw(String(SAFE_MONEY_MAX));
const SAFE_MONEY_MIN_SQL = sql.raw(String(-SAFE_MONEY_MAX));
const GENERATION_MAX_SQL = sql.raw(String(GENERATION_MAX));

export const financialProjectionVersions = pgTable(
  'financial_projection_versions',
  {
    singleton: boolean('singleton').default(true).primaryKey(),
    classifierVersion: integer('classifier_version').notNull(),
    allocationAlgorithmVersion: integer('allocation_algorithm_version').notNull(),
    pendingClassifierVersion: integer('pending_classifier_version'),
    pendingAllocationAlgorithmVersion: integer('pending_allocation_algorithm_version'),
    pendingReplayId: varchar('pending_replay_id', { length: 50 }),
    pendingScanRunId: uuid('pending_scan_run_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true }).defaultNow().notNull(),
    activationCorrelationId: varchar('activation_correlation_id', { length: 100 }).notNull()
  },
  (table) => [
    check('financial_projection_versions_singleton_true', sql`${table.singleton} = true`),
    check(
      'financial_projection_versions_versions_positive',
      sql`${table.classifierVersion} > 0 and ${table.allocationAlgorithmVersion} > 0`
    ),
    check(
      'financial_projection_versions_correlation_safe',
      sql`char_length(${table.activationCorrelationId}) between 1 and 100`
    ),
    check(
      'financial_projection_versions_pending_consistent',
      sql`(
        ${table.pendingClassifierVersion} is null and
        ${table.pendingAllocationAlgorithmVersion} is null and
        ${table.pendingReplayId} is null and ${table.pendingScanRunId} is null
      ) or (
        ${table.pendingClassifierVersion} is not null and
        ${table.pendingAllocationAlgorithmVersion} is not null and
        ${table.pendingReplayId} is not null and ${table.pendingScanRunId} is not null and
        ${table.pendingClassifierVersion} >= ${table.classifierVersion} and
        ${table.pendingAllocationAlgorithmVersion} >= ${table.allocationAlgorithmVersion} and
        (
          ${table.pendingClassifierVersion} > ${table.classifierVersion} or
          ${table.pendingAllocationAlgorithmVersion} > ${table.allocationAlgorithmVersion}
        ) and
        ${table.pendingReplayId} = 'c' || ${table.pendingClassifierVersion}::text ||
          '-a' || ${table.pendingAllocationAlgorithmVersion}::text
      )`
    )
  ]
);

export const financialPayoutDiscoveryState = pgTable(
  'financial_payout_discovery_state',
  {
    singleton: boolean('singleton').default(true).primaryKey(),
    coveredThrough: timestamp('covered_through', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    check('financial_payout_discovery_state_singleton_true', sql`${table.singleton} = true`)
  ]
);

export const stripeBalanceTransactions = pgTable(
  'stripe_balance_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    liveMode: boolean('live_mode').notNull(),
    sourceFamily: balanceTransactionSourceFamilyEnum('source_family'),
    sourceId: varchar('source_id', { length: 255 }),
    rawType: varchar('raw_type', { length: 100 }).notNull(),
    reportingCategory: varchar('reporting_category', { length: 100 }).notNull(),
    balanceType: varchar('balance_type', { length: 100 }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    feeMinor: integer('fee_minor').notNull(),
    netMinor: integer('net_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    status: balanceTransactionStatusEnum('status').notNull(),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    exchangeRate: numeric('exchange_rate', { precision: 38, scale: 18, mode: 'string' }),
    exchangeSourceCurrency: varchar('exchange_source_currency', { length: 3 }),
    exchangeTargetCurrency: varchar('exchange_target_currency', { length: 3 }),
    fingerprintSha256: varchar('fingerprint_sha256', { length: 64 }).notNull(),
    firstImportedAt: timestamp('first_imported_at', { withTimezone: true }).defaultNow().notNull(),
    lastImportedAt: timestamp('last_imported_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('stripe_balance_transactions_provider_unique').on(table.providerId),
    index('stripe_balance_transactions_source_idx').on(table.sourceFamily, table.sourceId),
    index('stripe_balance_transactions_status_available_idx').on(
      table.status,
      table.availableAt,
      table.id
    ),
    index('stripe_balance_transactions_currency_created_idx').on(
      table.currency,
      table.providerCreatedAt,
      table.id
    ),
    check(
      'stripe_balance_transactions_money_bounded',
      sql`${table.amountMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL} and ${table.feeMinor} between 0 and ${SAFE_MONEY_MAX_SQL} and ${table.netMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL}`
    ),
    check('stripe_balance_transactions_fee_nonnegative', sql`${table.feeMinor} >= 0`),
    check(
      'stripe_balance_transactions_net_consistent',
      sql`${table.netMinor} = ${table.amountMinor} - ${table.feeMinor}`
    ),
    check('stripe_balance_transactions_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'stripe_balance_transactions_source_consistent',
      sql`${table.sourceId} is null or (${table.sourceFamily} is not null and char_length(${table.sourceId}) between 1 and 255)`
    ),
    check(
      'stripe_balance_transactions_provider_fields_safe',
      sql`char_length(${table.providerId}) > 0 and char_length(${table.rawType}) > 0 and char_length(${table.reportingCategory}) > 0 and char_length(${table.balanceType}) > 0`
    ),
    check(
      'stripe_balance_transactions_exchange_evidence_consistent',
      sql`(
        ${table.exchangeRate} is null and ${table.exchangeSourceCurrency} is null and ${table.exchangeTargetCurrency} is null
      ) or (
        ${table.exchangeRate} is not null and
        ${table.exchangeSourceCurrency} is not null and
        ${table.exchangeTargetCurrency} is not null and
        ${table.exchangeRate} > 0 and
        ${table.exchangeSourceCurrency} ~ '^[A-Z]{3}$' and
        ${table.exchangeTargetCurrency} ~ '^[A-Z]{3}$' and
        ${table.exchangeTargetCurrency} = ${table.currency} and
        ${table.exchangeSourceCurrency} <> ${table.exchangeTargetCurrency}
      )`
    ),
    check(
      'stripe_balance_transactions_fingerprint_sha256',
      sql`${table.fingerprintSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'stripe_balance_transactions_import_timestamp_order',
      sql`${table.lastImportedAt} >= ${table.firstImportedAt}`
    )
  ]
);

export const stripeBalanceTransactionFeeDetails = pgTable(
  'stripe_balance_transaction_fee_details',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    balanceTransactionId: uuid('balance_transaction_id')
      .notNull()
      .references(() => stripeBalanceTransactions.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    rawType: varchar('raw_type', { length: 100 }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    fingerprintSha256: varchar('fingerprint_sha256', { length: 64 }).notNull()
  },
  (table) => [
    uniqueIndex('stripe_balance_transaction_fee_details_parent_ordinal_unique').on(
      table.balanceTransactionId,
      table.ordinal
    ),
    check('stripe_balance_transaction_fee_details_ordinal_nonnegative', sql`${table.ordinal} >= 0`),
    check(
      'stripe_balance_transaction_fee_details_amount_bounded',
      sql`${table.amountMinor} between 0 and ${SAFE_MONEY_MAX_SQL}`
    ),
    check(
      'stripe_balance_transaction_fee_details_currency_iso',
      sql`${table.currency} ~ '^[A-Z]{3}$'`
    ),
    check('stripe_balance_transaction_fee_details_type_safe', sql`char_length(${table.rawType}) > 0`),
    check(
      'stripe_balance_transaction_fee_details_fingerprint_sha256',
      sql`${table.fingerprintSha256} ~ '^[a-f0-9]{64}$'`
    )
  ]
);

export const financialClassificationVersions = pgTable(
  'financial_classification_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subjectType: financialClassificationSubjectTypeEnum('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    classifierVersion: integer('classifier_version').notNull(),
    classification: financialClassificationEnum('classification').notNull(),
    sourceFingerprintSha256: varchar('source_fingerprint_sha256', { length: 64 }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('financial_classification_versions_identity_unique').on(
      table.subjectType,
      table.subjectId,
      table.classifierVersion,
      table.sourceFingerprintSha256
    ),
    index('financial_classification_versions_current_idx').on(
      table.subjectType,
      table.subjectId,
      table.sourceFingerprintSha256,
      table.classifierVersion
    ),
    check(
      'financial_classification_versions_version_positive',
      sql`${table.classifierVersion} > 0`
    ),
    check(
      'financial_classification_versions_fingerprint_sha256',
      sql`${table.sourceFingerprintSha256} ~ '^[a-f0-9]{64}$'`
    )
  ]
);

export const stripePayouts = pgTable(
  'stripe_payouts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    liveMode: boolean('live_mode').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    automatic: boolean('automatic').notNull(),
    method: payoutMethodEnum('method').notNull(),
    status: payoutStatusEnum('status').notNull(),
    reconciliationStatus: payoutReconciliationStatusEnum('reconciliation_status').notNull(),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
    arrivalAt: timestamp('arrival_at', { withTimezone: true }).notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    balanceTransactionId: uuid('balance_transaction_id').references(
      () => stripeBalanceTransactions.id,
      { onDelete: 'restrict' }
    ),
    failureBalanceTransactionId: uuid('failure_balance_transaction_id').references(
      () => stripeBalanceTransactions.id,
      { onDelete: 'restrict' }
    ),
    originalProviderPayoutId: varchar('original_provider_payout_id', { length: 255 }),
    reversedByProviderPayoutId: varchar('reversed_by_provider_payout_id', { length: 255 }),
    safeFailureCode: varchar('safe_failure_code', { length: 100 }),
    financialGeneration: integer('financial_generation').default(0).notNull(),
    fingerprintSha256: varchar('fingerprint_sha256', { length: 64 }).notNull()
  },
  (table) => [
    uniqueIndex('stripe_payouts_provider_unique').on(table.providerId),
    index('stripe_payouts_status_created_idx').on(table.status, table.providerCreatedAt, table.id),
    index('stripe_payouts_reconciliation_created_idx').on(
      table.reconciliationStatus,
      table.providerCreatedAt,
      table.id
    ),
    index('stripe_payouts_balance_transaction_idx').on(table.balanceTransactionId),
    index('stripe_payouts_failure_balance_transaction_idx').on(table.failureBalanceTransactionId),
    check(
      'stripe_payouts_amount_bounded',
      sql`${table.amountMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL}`
    ),
    check('stripe_payouts_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'stripe_payouts_generation_bounded',
      sql`${table.financialGeneration} between 0 and ${GENERATION_MAX_SQL}`
    ),
    check(
      'stripe_payouts_failure_code_safe',
      sql`${table.safeFailureCode} is null or ${table.safeFailureCode} ~ '^[a-z0-9_]{1,100}$'`
    ),
    check(
      'stripe_payouts_fingerprint_sha256',
      sql`${table.fingerprintSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'stripe_payouts_linked_transactions_distinct',
      sql`${table.balanceTransactionId} is null or ${table.failureBalanceTransactionId} is null or ${table.balanceTransactionId} <> ${table.failureBalanceTransactionId}`
    ),
    check(
      'stripe_payouts_related_ids_safe',
      sql`(${table.originalProviderPayoutId} is null or (char_length(${table.originalProviderPayoutId}) > 0 and ${table.originalProviderPayoutId} <> ${table.providerId})) and (${table.reversedByProviderPayoutId} is null or (char_length(${table.reversedByProviderPayoutId}) > 0 and ${table.reversedByProviderPayoutId} <> ${table.providerId}))`
    ),
    check(
      'stripe_payouts_reconciliation_supported',
      sql`${table.reconciliationStatus} = 'not_applicable' or (${table.automatic} and ${table.method} = 'standard')`
    )
  ]
);

export const payoutImportRuns = pgTable(
  'payout_import_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => stripePayouts.id, { onDelete: 'restrict' }),
    generation: integer('generation').notNull(),
    state: payoutImportStateEnum('state').default('collecting').notNull(),
    nextStartingAfter: varchar('next_starting_after', { length: 255 }),
    candidateCount: integer('candidate_count').default(0).notNull(),
    pageCount: integer('page_count').default(0).notNull(),
    safeOutcome: varchar('safe_outcome', { length: 100 }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true })
  },
  (table) => [
    unique('payout_import_runs_graph_identity_unique').on(table.id, table.payoutId),
    uniqueIndex('payout_import_runs_generation_unique').on(table.payoutId, table.generation),
    uniqueIndex('payout_import_runs_active_payout_unique')
      .on(table.payoutId)
      .where(sql`${table.state} in ('collecting', 'publishable')`),
    index('payout_import_runs_recovery_idx').on(table.state, table.updatedAt, table.id),
    check(
      'payout_import_runs_generation_bounded',
      sql`${table.generation} between 0 and ${GENERATION_MAX_SQL}`
    ),
    check(
      'payout_import_runs_counts_nonnegative',
      sql`${table.candidateCount} >= 0 and ${table.pageCount} >= 0`
    ),
    check(
      'payout_import_runs_cursor_bounded',
      sql`${table.nextStartingAfter} is null or char_length(${table.nextStartingAfter}) between 1 and 255`
    ),
    check(
      'payout_import_runs_outcome_safe',
      sql`${table.safeOutcome} is null or ${table.safeOutcome} ~ '^[a-z0-9_]{1,100}$'`
    ),
    check(
      'payout_import_runs_lifecycle_consistent',
      sql`(${table.state} in ('published', 'abandoned', 'exception')) = (${table.completedAt} is not null)`
    )
  ]
);

export const payoutImportRunEntries = pgTable(
  'payout_import_run_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => payoutImportRuns.id, { onDelete: 'restrict' }),
    balanceTransactionId: uuid('balance_transaction_id')
      .notNull()
      .references(() => stripeBalanceTransactions.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('payout_import_run_entries_candidate_unique').on(
      table.runId,
      table.balanceTransactionId
    ),
    index('payout_import_run_entries_transaction_idx').on(table.balanceTransactionId, table.id)
  ]
);

export const stripePayoutBalanceTransactions = pgTable(
  'stripe_payout_balance_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => stripePayouts.id, { onDelete: 'restrict' }),
    balanceTransactionId: uuid('balance_transaction_id')
      .notNull()
      .references(() => stripeBalanceTransactions.id, { onDelete: 'restrict' }),
    publishedFromRunId: uuid('published_from_run_id').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('stripe_payout_balance_transactions_pair_unique').on(
      table.payoutId,
      table.balanceTransactionId
    ),
    uniqueIndex('stripe_payout_balance_transactions_transaction_unique').on(
      table.balanceTransactionId
    ),
    index('stripe_payout_balance_transactions_payout_idx').on(table.payoutId, table.id),
    foreignKey({
      name: 'stripe_payout_balance_transactions_run_payout_fk',
      columns: [table.publishedFromRunId, table.payoutId],
      foreignColumns: [payoutImportRuns.id, payoutImportRuns.payoutId]
    }).onDelete('restrict')
  ]
);

export const financialScanRuns = pgTable(
  'financial_scan_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rootKey: varchar('root_key', { length: 512 }).notNull(),
    kind: varchar('kind', { length: 50 }).notNull(),
    phase: varchar('phase', { length: 50 }).notNull(),
    state: financialScanStateEnum('state').default('running').notNull(),
    classifierVersion: integer('classifier_version'),
    allocationAlgorithmVersion: integer('allocation_algorithm_version'),
    replayId: varchar('replay_id', { length: 50 }),
    payoutDiscoveryCreatedGte: timestamp('payout_discovery_created_gte', { withTimezone: true }),
    payoutDiscoveryCreatedLt: timestamp('payout_discovery_created_lt', { withTimezone: true }),
    checkpoint: varchar('checkpoint', { length: 255 }),
    cursorDigestSha256: varchar('cursor_digest_sha256', { length: 64 }),
    processedCount: integer('processed_count').default(0).notNull(),
    enqueuedCount: integer('enqueued_count').default(0).notNull(),
    pageCount: integer('page_count').default(0).notNull(),
    safeOutcome: varchar('safe_outcome', { length: 100 }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true })
  },
  (table) => [
    uniqueIndex('financial_scan_runs_root_key_unique').on(table.rootKey),
    index('financial_scan_runs_state_phase_updated_idx').on(
      table.state,
      table.phase,
      table.updatedAt,
      table.id
    ),
    index('financial_scan_runs_kind_completed_idx').on(table.kind, table.completedAt, table.id),
    check(
      'financial_scan_runs_counts_nonnegative',
      sql`${table.processedCount} >= 0 and ${table.enqueuedCount} >= 0 and ${table.pageCount} >= 0`
    ),
    check(
      'financial_scan_runs_checkpoint_bounded',
      sql`${table.checkpoint} is null or char_length(${table.checkpoint}) between 1 and 255`
    ),
    check(
      'financial_scan_runs_cursor_digest_sha256',
      sql`${table.cursorDigestSha256} is null or ${table.cursorDigestSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'financial_scan_runs_vocabulary_safe',
      sql`${table.kind} ~ '^[a-z0-9_-]{1,50}$' and ${table.phase} ~ '^[a-z0-9_-]{1,50}$' and (${table.safeOutcome} is null or ${table.safeOutcome} ~ '^[a-z0-9_]{1,100}$')`
    ),
    check(
      'financial_scan_runs_replay_consistent',
      sql`(
        ${table.classifierVersion} is null and ${table.allocationAlgorithmVersion} is null and ${table.replayId} is null
      ) or (
        ${table.classifierVersion} is not null and
        ${table.allocationAlgorithmVersion} is not null and
        ${table.replayId} is not null and
        ${table.classifierVersion} > 0 and ${table.allocationAlgorithmVersion} > 0 and
        ${table.replayId} = 'c' || ${table.classifierVersion}::text || '-a' || ${table.allocationAlgorithmVersion}::text
      )`
    ),
    check(
      'financial_scan_runs_payout_discovery_window_consistent',
      sql`(
        ${table.payoutDiscoveryCreatedGte} is null and ${table.payoutDiscoveryCreatedLt} is null
      ) or (
        ${table.payoutDiscoveryCreatedGte} is not null and
        ${table.payoutDiscoveryCreatedLt} is not null and
        ${table.payoutDiscoveryCreatedGte} < ${table.payoutDiscoveryCreatedLt} and
        ${table.kind} in ('initial_backfill', 'hourly')
      )`
    ),
    check(
      'financial_scan_runs_lifecycle_consistent',
      sql`(${table.state} in ('completed', 'exception')) = (${table.completedAt} is not null)`
    )
  ]
);

export type FinancialProjectionVersionRow = typeof financialProjectionVersions.$inferSelect;
export type NewFinancialProjectionVersionRow = typeof financialProjectionVersions.$inferInsert;
export type FinancialPayoutDiscoveryStateRow = typeof financialPayoutDiscoveryState.$inferSelect;
export type NewFinancialPayoutDiscoveryStateRow = typeof financialPayoutDiscoveryState.$inferInsert;
export type StripeBalanceTransactionRow = typeof stripeBalanceTransactions.$inferSelect;
export type NewStripeBalanceTransactionRow = typeof stripeBalanceTransactions.$inferInsert;
export type StripeBalanceTransactionFeeDetailRow =
  typeof stripeBalanceTransactionFeeDetails.$inferSelect;
export type NewStripeBalanceTransactionFeeDetailRow =
  typeof stripeBalanceTransactionFeeDetails.$inferInsert;
export type FinancialClassificationVersionRow = typeof financialClassificationVersions.$inferSelect;
export type NewFinancialClassificationVersionRow = typeof financialClassificationVersions.$inferInsert;
export type StripePayoutRow = typeof stripePayouts.$inferSelect;
export type NewStripePayoutRow = typeof stripePayouts.$inferInsert;
export type PayoutImportRunRow = typeof payoutImportRuns.$inferSelect;
export type NewPayoutImportRunRow = typeof payoutImportRuns.$inferInsert;
export type PayoutImportRunEntryRow = typeof payoutImportRunEntries.$inferSelect;
export type NewPayoutImportRunEntryRow = typeof payoutImportRunEntries.$inferInsert;
export type StripePayoutBalanceTransactionRow =
  typeof stripePayoutBalanceTransactions.$inferSelect;
export type NewStripePayoutBalanceTransactionRow =
  typeof stripePayoutBalanceTransactions.$inferInsert;
export type FinancialScanRunRow = typeof financialScanRuns.$inferSelect;
export type NewFinancialScanRunRow = typeof financialScanRuns.$inferInsert;
