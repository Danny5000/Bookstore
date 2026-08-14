import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  balanceTransactionSourceFamilyEnum,
  balanceTransactionStatusEnum,
  financialClassificationEnum,
  financialClassificationSubjectTypeEnum,
  financialClassificationVersions,
  financialProjectionVersions,
  financialPayoutDiscoveryState,
  financialScanRuns,
  financialScanStateEnum,
  payoutImportRunEntries,
  payoutImportRuns,
  payoutImportStateEnum,
  payoutMethodEnum,
  payoutReconciliationStatusEnum,
  payoutStatusEnum,
  stripeBalanceTransactionFeeDetails,
  stripeBalanceTransactions,
  stripePayoutBalanceTransactions,
  stripePayouts
} from './financial-provider';

const TABLES = [
  financialProjectionVersions,
  financialPayoutDiscoveryState,
  stripeBalanceTransactions,
  stripeBalanceTransactionFeeDetails,
  financialClassificationVersions,
  stripePayouts,
  payoutImportRuns,
  payoutImportRunEntries,
  stripePayoutBalanceTransactions,
  financialScanRuns
] as const;

const configFor = (table: PgTable) => getTableConfig(table);
const indexNames = (table: PgTable) => configFor(table).indexes.map((item) => item.config.name);
const checkNames = (table: PgTable) => configFor(table).checks.map((item) => item.name);
const tableName = (table: PgTable) => configFor(table).name;
const foreignKeySignatures = () =>
  TABLES.flatMap((table) =>
    configFor(table).foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return `${tableName(table)}(${reference.columns.map((column) => column.name).join(',')}) -> ${tableName(reference.foreignTable)}(${reference.foreignColumns.map((column) => column.name).join(',')}) [${foreignKey.onDelete}]`;
    })
  ).sort();

describe('financial provider schema declarations', () => {
  it('declares the exact provider table and enum vocabulary', () => {
    expect(TABLES.map((table) => configFor(table).name)).toEqual([
      'financial_projection_versions',
      'financial_payout_discovery_state',
      'stripe_balance_transactions',
      'stripe_balance_transaction_fee_details',
      'financial_classification_versions',
      'stripe_payouts',
      'payout_import_runs',
      'payout_import_run_entries',
      'stripe_payout_balance_transactions',
      'financial_scan_runs'
    ]);
    expect(balanceTransactionStatusEnum.enumValues).toEqual(['pending', 'available']);
    expect(balanceTransactionSourceFamilyEnum.enumValues).toEqual([
      'charge',
      'refund',
      'dispute',
      'payout',
      'adjustment',
      'unknown'
    ]);
    expect(financialClassificationSubjectTypeEnum.enumValues).toEqual([
      'balance_transaction',
      'fee_detail'
    ]);
    expect(financialClassificationEnum.enumValues).toEqual([
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
    ]);
    expect(payoutMethodEnum.enumValues).toEqual(['standard', 'instant', 'unknown']);
    expect(payoutStatusEnum.enumValues).toEqual([
      'pending',
      'in_transit',
      'paid',
      'failed',
      'canceled'
    ]);
    expect(payoutReconciliationStatusEnum.enumValues).toEqual([
      'completed',
      'in_progress',
      'not_applicable'
    ]);
    expect(payoutImportStateEnum.enumValues).toEqual([
      'collecting',
      'publishable',
      'published',
      'abandoned',
      'exception'
    ]);
    expect(financialScanStateEnum.enumValues).toEqual(['running', 'completed', 'exception']);
  });

  it('declares the exact minimized provider columns', () => {
    expect(
      Object.fromEntries(
        TABLES.map((table) => [
          configFor(table).name,
          configFor(table).columns.map((column) => column.name)
        ])
      )
    ).toEqual({
      financial_projection_versions: [
        'singleton', 'classifier_version', 'allocation_algorithm_version',
        'pending_classifier_version', 'pending_allocation_algorithm_version',
        'pending_replay_id', 'pending_scan_run_id', 'activated_at',
        'activation_correlation_id'
      ],
      financial_payout_discovery_state: ['singleton', 'covered_through', 'updated_at'],
      stripe_balance_transactions: [
        'id', 'provider_id', 'live_mode', 'source_family', 'source_id', 'raw_type',
        'reporting_category', 'balance_type', 'amount_minor', 'fee_minor', 'net_minor',
        'currency', 'status', 'provider_created_at', 'available_at', 'exchange_rate',
        'exchange_source_currency', 'exchange_target_currency', 'fingerprint_sha256',
        'first_imported_at', 'last_imported_at'
      ],
      stripe_balance_transaction_fee_details: [
        'id', 'balance_transaction_id', 'ordinal', 'raw_type', 'amount_minor', 'currency',
        'fingerprint_sha256'
      ],
      financial_classification_versions: [
        'id', 'subject_type', 'subject_id', 'classifier_version', 'classification',
        'source_fingerprint_sha256', 'decided_at'
      ],
      stripe_payouts: [
        'id', 'provider_id', 'live_mode', 'amount_minor', 'currency', 'automatic', 'method',
        'status', 'reconciliation_status', 'provider_created_at', 'arrival_at', 'retrieved_at',
        'balance_transaction_id', 'failure_balance_transaction_id',
        'original_provider_payout_id', 'reversed_by_provider_payout_id', 'safe_failure_code',
        'financial_generation', 'fingerprint_sha256'
      ],
      payout_import_runs: [
        'id', 'payout_id', 'generation', 'state', 'next_starting_after', 'candidate_count',
        'page_count', 'safe_outcome', 'started_at', 'updated_at', 'completed_at'
      ],
      payout_import_run_entries: [
        'id', 'run_id', 'balance_transaction_id', 'created_at'
      ],
      stripe_payout_balance_transactions: [
        'id', 'payout_id', 'balance_transaction_id', 'published_from_run_id', 'published_at'
      ],
      financial_scan_runs: [
        'id', 'root_key', 'kind', 'phase', 'state', 'classifier_version',
        'allocation_algorithm_version', 'replay_id', 'payout_discovery_created_gte',
        'payout_discovery_created_lt', 'checkpoint', 'cursor_digest_sha256',
        'processed_count', 'enqueued_count', 'page_count', 'safe_outcome', 'started_at',
        'updated_at', 'completed_at'
      ]
    });
  });

  it('declares provider identity, scan, and publication indexes', () => {
    expect(configFor(financialProjectionVersions).columns[0]?.primary).toBe(true);
    expect(indexNames(stripeBalanceTransactions)).toEqual(
      expect.arrayContaining([
        'stripe_balance_transactions_provider_unique',
        'stripe_balance_transactions_source_idx',
        'stripe_balance_transactions_status_available_idx',
        'stripe_balance_transactions_currency_created_idx'
      ])
    );
    expect(indexNames(stripeBalanceTransactionFeeDetails)).toContain(
      'stripe_balance_transaction_fee_details_parent_ordinal_unique'
    );
    expect(indexNames(financialClassificationVersions)).toContain(
      'financial_classification_versions_identity_unique'
    );
    expect(indexNames(stripePayouts)).toEqual(
      expect.arrayContaining([
        'stripe_payouts_provider_unique',
        'stripe_payouts_status_created_idx',
        'stripe_payouts_reconciliation_created_idx'
      ])
    );
    expect(indexNames(payoutImportRuns)).toContain('payout_import_runs_generation_unique');
    expect(indexNames(payoutImportRunEntries)).toContain(
      'payout_import_run_entries_candidate_unique'
    );
    expect(indexNames(stripePayoutBalanceTransactions)).toEqual(
      expect.arrayContaining([
        'stripe_payout_balance_transactions_pair_unique',
        'stripe_payout_balance_transactions_transaction_unique'
      ])
    );
    expect(indexNames(financialScanRuns)).toContain('financial_scan_runs_root_key_unique');
  });

  it('declares exact money, digest, currency, generation, and lifecycle checks', () => {
    expect(checkNames(stripeBalanceTransactions)).toEqual(
      expect.arrayContaining([
        'stripe_balance_transactions_net_consistent',
        'stripe_balance_transactions_fee_nonnegative',
        'stripe_balance_transactions_currency_iso',
        'stripe_balance_transactions_exchange_evidence_consistent',
        'stripe_balance_transactions_fingerprint_sha256'
      ])
    );
    expect(checkNames(stripePayouts)).toEqual(
      expect.arrayContaining([
        'stripe_payouts_currency_iso',
        'stripe_payouts_generation_bounded',
        'stripe_payouts_failure_code_safe',
        'stripe_payouts_fingerprint_sha256'
      ])
    );
    expect(checkNames(payoutImportRuns)).toEqual(
      expect.arrayContaining([
        'payout_import_runs_counts_nonnegative',
        'payout_import_runs_cursor_bounded'
      ])
    );
    expect(checkNames(financialScanRuns)).toEqual(
      expect.arrayContaining([
        'financial_scan_runs_counts_nonnegative',
        'financial_scan_runs_checkpoint_bounded',
        'financial_scan_runs_payout_discovery_window_consistent'
      ])
    );
    expect(checkNames(financialPayoutDiscoveryState)).toContain(
      'financial_payout_discovery_state_singleton_true'
    );
  });

  it('pins every provider index, candidate key, and check name', () => {
    expect(
      Object.fromEntries(
        TABLES.map((table) => {
          const config = configFor(table);
          return [config.name, {
            indexes: config.indexes.map((item) => item.config.name).sort(),
            unique: config.uniqueConstraints.map((item) => item.name).sort(),
            checks: config.checks.map((item) => item.name).sort()
          }];
        })
      )
    ).toEqual({
      financial_projection_versions: {
        indexes: [], unique: [],
        checks: [
          'financial_projection_versions_correlation_safe',
          'financial_projection_versions_pending_consistent',
          'financial_projection_versions_singleton_true',
          'financial_projection_versions_versions_positive'
        ]
      },
      financial_payout_discovery_state: {
        indexes: [], unique: [],
        checks: ['financial_payout_discovery_state_singleton_true']
      },
      stripe_balance_transactions: {
        indexes: ['stripe_balance_transactions_currency_created_idx', 'stripe_balance_transactions_provider_unique', 'stripe_balance_transactions_source_idx', 'stripe_balance_transactions_status_available_idx'],
        unique: [],
        checks: ['stripe_balance_transactions_currency_iso', 'stripe_balance_transactions_exchange_evidence_consistent', 'stripe_balance_transactions_fee_nonnegative', 'stripe_balance_transactions_fingerprint_sha256', 'stripe_balance_transactions_import_timestamp_order', 'stripe_balance_transactions_money_bounded', 'stripe_balance_transactions_net_consistent', 'stripe_balance_transactions_provider_fields_safe', 'stripe_balance_transactions_source_consistent']
      },
      stripe_balance_transaction_fee_details: {
        indexes: ['stripe_balance_transaction_fee_details_parent_ordinal_unique'], unique: [],
        checks: ['stripe_balance_transaction_fee_details_amount_bounded', 'stripe_balance_transaction_fee_details_currency_iso', 'stripe_balance_transaction_fee_details_fingerprint_sha256', 'stripe_balance_transaction_fee_details_ordinal_nonnegative', 'stripe_balance_transaction_fee_details_type_safe']
      },
      financial_classification_versions: {
        indexes: ['financial_classification_versions_current_idx', 'financial_classification_versions_identity_unique'], unique: [],
        checks: ['financial_classification_versions_fingerprint_sha256', 'financial_classification_versions_version_positive']
      },
      stripe_payouts: {
        indexes: ['stripe_payouts_balance_transaction_idx', 'stripe_payouts_failure_balance_transaction_idx', 'stripe_payouts_provider_unique', 'stripe_payouts_reconciliation_created_idx', 'stripe_payouts_status_created_idx'], unique: [],
        checks: ['stripe_payouts_amount_bounded', 'stripe_payouts_currency_iso', 'stripe_payouts_failure_code_safe', 'stripe_payouts_fingerprint_sha256', 'stripe_payouts_generation_bounded', 'stripe_payouts_linked_transactions_distinct', 'stripe_payouts_reconciliation_supported', 'stripe_payouts_related_ids_safe']
      },
      payout_import_runs: {
        indexes: ['payout_import_runs_active_payout_unique', 'payout_import_runs_generation_unique', 'payout_import_runs_recovery_idx'], unique: ['payout_import_runs_graph_identity_unique'],
        checks: ['payout_import_runs_counts_nonnegative', 'payout_import_runs_cursor_bounded', 'payout_import_runs_generation_bounded', 'payout_import_runs_lifecycle_consistent', 'payout_import_runs_outcome_safe']
      },
      payout_import_run_entries: { indexes: ['payout_import_run_entries_candidate_unique', 'payout_import_run_entries_transaction_idx'], unique: [], checks: [] },
      stripe_payout_balance_transactions: { indexes: ['stripe_payout_balance_transactions_pair_unique', 'stripe_payout_balance_transactions_payout_idx', 'stripe_payout_balance_transactions_transaction_unique'], unique: [], checks: [] },
      financial_scan_runs: {
        indexes: ['financial_scan_runs_kind_completed_idx', 'financial_scan_runs_root_key_unique', 'financial_scan_runs_state_phase_updated_idx'], unique: [],
        checks: ['financial_scan_runs_checkpoint_bounded', 'financial_scan_runs_counts_nonnegative', 'financial_scan_runs_cursor_digest_sha256', 'financial_scan_runs_lifecycle_consistent', 'financial_scan_runs_payout_discovery_window_consistent', 'financial_scan_runs_replay_consistent', 'financial_scan_runs_vocabulary_safe']
      }
    });
  });

  it('keeps every provider-history foreign key restrictive', () => {
    expect(foreignKeySignatures()).toEqual([
      'payout_import_run_entries(balance_transaction_id) -> stripe_balance_transactions(id) [restrict]',
      'payout_import_run_entries(run_id) -> payout_import_runs(id) [restrict]',
      'payout_import_runs(payout_id) -> stripe_payouts(id) [restrict]',
      'stripe_balance_transaction_fee_details(balance_transaction_id) -> stripe_balance_transactions(id) [restrict]',
      'stripe_payout_balance_transactions(balance_transaction_id) -> stripe_balance_transactions(id) [restrict]',
      'stripe_payout_balance_transactions(payout_id) -> stripe_payouts(id) [restrict]',
      'stripe_payout_balance_transactions(published_from_run_id,payout_id) -> payout_import_runs(id,payout_id) [restrict]',
      'stripe_payouts(balance_transaction_id) -> stripe_balance_transactions(id) [restrict]',
      'stripe_payouts(failure_balance_transaction_id) -> stripe_balance_transactions(id) [restrict]'
    ]);
    const balanceTransactionColumns = Object.fromEntries(
      configFor(stripeBalanceTransactions).columns.map((column) => [
        column.name,
        { type: column.getSQLType(), notNull: column.notNull, hasDefault: column.hasDefault }
      ])
    );
    expect(balanceTransactionColumns.source_family).toEqual({
      type: 'stripe_balance_transaction_source_family',
      notNull: false,
      hasDefault: false
    });
    expect(balanceTransactionColumns.source_id).toEqual({
      type: 'varchar(255)',
      notNull: false,
      hasDefault: false
    });
    expect(balanceTransactionColumns.exchange_rate).toEqual({
      type: 'numeric(38, 18)',
      notNull: false,
      hasDefault: false
    });
  });

  it('cannot persist raw provider, customer, payment-method, or secret material', () => {
    const columnNames = TABLES.flatMap((table) =>
      configFor(table).columns.map((column) => column.name)
    );
    expect(columnNames.some((name) => /(description|destination|metadata|message)/u.test(name))).toBe(false);
    expect(columnNames.some((name) => /(customer|billing|card|payment_method)/u.test(name))).toBe(false);
    expect(columnNames.some((name) => /(raw_payload|provider_payload|secret|receipt_url)/u.test(name))).toBe(false);
  });
});
