import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  pgView,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { FINANCIAL_CLASSIFICATION_JOB } from '$lib/server/jobs/catalog';
import { user } from './auth';
import {
  disputes,
  entitlementGrantStatus,
  entitlementGrants,
  orderItems,
  payments,
  refundAllocations,
  refunds
} from './commerce';
import {
  financialClassificationVersions,
  financialProjectionVersions,
  stripeBalanceTransactionFeeDetails,
  stripeBalanceTransactions
} from './financial-provider';
import { jobs } from './operations';

const FINANCIAL_CLASSIFICATION_JOB_SQL = sql.raw(`'${FINANCIAL_CLASSIFICATION_JOB}'`);

export const allocationBasisValues = ['gross_amount', 'fee'] as const;
export const allocationScopeValues = ['title', 'account', 'unresolved'] as const;
export const financialAllocationSourceKindValues = [
  'payment',
  'refund',
  'dispute',
  'payout',
  'adjustment'
] as const;
export const financialComponentValues = [
  'sale_subtotal',
  'sale_tax',
  'processing_fee',
  'refund_subtotal',
  'refund_tax',
  'refund_fee',
  'refund_failure_reversal',
  'dispute_subtotal',
  'dispute_tax',
  'dispute_fee',
  'dispute_reinstatement',
  'provider_fee_tax',
  'fee_credit',
  'other'
] as const;
export const financialIssueStateValues = ['open', 'resolved'] as const;
export const financialIssueImpactValues = ['pending', 'exception', 'informational'] as const;
export const refundAllocationDraftStateValues = ['active', 'finalized', 'discarded'] as const;
export const disputeAllocationEffectValues = ['withdrawal', 'reinstatement'] as const;
export const refundCorrectionKindValues = [
  'allocation_attribution_correction',
  'classifier_rebase'
] as const;
export const refundCorrectionDomainValues = ['presentment', 'settlement'] as const;
export const financialFinalizationTransitionValues = [
  'unchanged',
  'revoked_by_finalization'
] as const;

export const allocationBasisEnum = pgEnum('financial_allocation_basis', allocationBasisValues);
export const allocationScopeEnum = pgEnum('financial_allocation_scope', allocationScopeValues);
export const financialAllocationSourceKindEnum = pgEnum(
  'financial_allocation_source_kind',
  financialAllocationSourceKindValues
);
export const financialComponentEnum = pgEnum('financial_component', financialComponentValues);
export const financialIssueStateEnum = pgEnum('financial_issue_state', financialIssueStateValues);
export const financialIssueImpactEnum = pgEnum('financial_issue_impact', financialIssueImpactValues);
export const refundAllocationDraftStateEnum = pgEnum(
  'refund_allocation_draft_state',
  refundAllocationDraftStateValues
);
export const disputeAllocationEffectEnum = pgEnum(
  'dispute_allocation_effect',
  disputeAllocationEffectValues
);
export const refundCorrectionKindEnum = pgEnum(
  'refund_correction_kind',
  refundCorrectionKindValues
);
export const refundCorrectionDomainEnum = pgEnum(
  'refund_correction_domain',
  refundCorrectionDomainValues
);
export const financialFinalizationTransitionEnum = pgEnum(
  'financial_finalization_transition',
  financialFinalizationTransitionValues
);

const SAFE_MONEY_MAX = 99_999_999;
const SAFE_MONEY_MAX_SQL = sql.raw(String(SAFE_MONEY_MAX));
const SAFE_MONEY_MIN_SQL = sql.raw(String(-SAFE_MONEY_MAX));

export const financialAllocationSets = pgTable(
  'financial_allocation_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    allocationIdentity: varchar('allocation_identity', { length: 255 }).notNull(),
    balanceTransactionId: uuid('balance_transaction_id')
      .notNull()
      .references(() => stripeBalanceTransactions.id, { onDelete: 'restrict' }),
    sourceKind: financialAllocationSourceKindEnum('source_kind').notNull(),
    sourceInternalId: uuid('source_internal_id').notNull(),
    basis: allocationBasisEnum('basis').notNull(),
    scope: allocationScopeEnum('scope').notNull(),
    expectedEffectMinor: integer('expected_effect_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    algorithmVersion: integer('algorithm_version').notNull(),
    classifierVersion: integer('classifier_version').notNull(),
    sourceFingerprintSha256: varchar('source_fingerprint_sha256', { length: 64 }).notNull(),
    supersedesSetId: uuid('supersedes_set_id').references(
      (): AnyPgColumn => financialAllocationSets.id,
      { onDelete: 'restrict' }
    ),
    reversalOfSetId: uuid('reversal_of_set_id').references(
      (): AnyPgColumn => financialAllocationSets.id,
      { onDelete: 'restrict' }
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('financial_allocation_sets_supersession_identity_unique').on(
      table.id,
      table.balanceTransactionId,
      table.basis,
      table.currency,
      table.expectedEffectMinor,
      table.sourceFingerprintSha256
    ),
    unique('financial_allocation_sets_reversal_identity_unique').on(
      table.id,
      table.sourceKind,
      table.sourceInternalId,
      table.basis,
      table.currency
    ),
    unique('financial_allocation_sets_source_identity_unique').on(
      table.id,
      table.sourceInternalId
    ),
    uniqueIndex('financial_allocation_sets_identity_unique').on(table.allocationIdentity),
    uniqueIndex('financial_allocation_sets_root_unique')
      .on(table.balanceTransactionId, table.basis, table.sourceFingerprintSha256)
      .where(sql`${table.supersedesSetId} is null`),
    uniqueIndex('financial_allocation_sets_successor_unique')
      .on(table.supersedesSetId)
      .where(sql`${table.supersedesSetId} is not null`),
    uniqueIndex('financial_allocation_sets_reversal_root_unique')
      .on(table.reversalOfSetId)
      .where(sql`${table.reversalOfSetId} is not null and ${table.supersedesSetId} is null`),
    index('financial_allocation_sets_transaction_basis_idx').on(
      table.balanceTransactionId,
      table.basis,
      table.createdAt,
      table.id
    ),
    index('financial_allocation_sets_source_idx').on(
      table.sourceKind,
      table.sourceInternalId,
      table.id
    ),
    index('financial_allocation_sets_reversal_idx').on(table.reversalOfSetId),
    foreignKey({
      name: 'financial_allocation_sets_supersedes_graph_fk',
      columns: [
        table.supersedesSetId,
        table.balanceTransactionId,
        table.basis,
        table.currency,
        table.expectedEffectMinor,
        table.sourceFingerprintSha256
      ],
      foreignColumns: [
        table.id,
        table.balanceTransactionId,
        table.basis,
        table.currency,
        table.expectedEffectMinor,
        table.sourceFingerprintSha256
      ]
    }).onDelete('restrict'),
    foreignKey({
      name: 'financial_allocation_sets_reversal_graph_fk',
      columns: [
        table.reversalOfSetId,
        table.sourceKind,
        table.sourceInternalId,
        table.basis,
        table.currency
      ],
      foreignColumns: [
        table.id,
        table.sourceKind,
        table.sourceInternalId,
        table.basis,
        table.currency
      ]
    }).onDelete('restrict'),
    check(
      'financial_allocation_sets_effect_bounded',
      sql`${table.expectedEffectMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL}`
    ),
    check('financial_allocation_sets_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'financial_allocation_sets_versions_positive',
      sql`${table.algorithmVersion} > 0 and ${table.classifierVersion} > 0`
    ),
    check(
      'financial_allocation_sets_fingerprint_sha256',
      sql`${table.sourceFingerprintSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'financial_allocation_sets_identity_safe',
      sql`char_length(${table.allocationIdentity}) > 0`
    ),
    check(
      'financial_allocation_sets_chain_consistent',
      sql`(${table.supersedesSetId} is null or ${table.supersedesSetId} <> ${table.id}) and (${table.reversalOfSetId} is null or ${table.reversalOfSetId} <> ${table.id}) and (${table.supersedesSetId} is null or ${table.reversalOfSetId} is null or ${table.supersedesSetId} <> ${table.reversalOfSetId})`
    )
  ]
);

export const financialItemAllocations = pgTable(
  'financial_item_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    allocationSetId: uuid('allocation_set_id')
      .notNull()
      .references(() => financialAllocationSets.id, { onDelete: 'restrict' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    component: financialComponentEnum('component').notNull(),
    effectMinor: integer('effect_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    tieBreakKey: varchar('tie_break_key', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('financial_item_allocations_set_item_component_unique').on(
      table.allocationSetId,
      table.orderItemId,
      table.component
    ),
    uniqueIndex('financial_item_allocations_set_tie_key_unique').on(
      table.allocationSetId,
      table.tieBreakKey
    ),
    index('financial_item_allocations_item_idx').on(table.orderItemId, table.createdAt),
    check(
      'financial_item_allocations_effect_bounded',
      sql`${table.effectMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL}`
    ),
    check('financial_item_allocations_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'financial_item_allocations_tie_key_safe',
      sql`char_length(${table.tieBreakKey}) between 1 and 255`
    )
  ]
);

export const financialReconciliationIssues = pgTable(
  'financial_reconciliation_issues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    resourceType: varchar('resource_type', { length: 50 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    safeCode: varchar('safe_code', { length: 100 }).notNull(),
    state: financialIssueStateEnum('state').default('open').notNull(),
    impact: financialIssueImpactEnum('impact').notNull(),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true }).defaultNow().notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).defaultNow().notNull(),
    occurrenceCount: integer('occurrence_count').default(1).notNull(),
    correlationId: varchar('correlation_id', { length: 100 }).notNull(),
    resolvedByAdminId: uuid('resolved_by_admin_id').references(() => user.id, {
      onDelete: 'restrict'
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true })
  },
  (table) => [
    uniqueIndex('financial_reconciliation_issues_open_unique')
      .on(table.resourceType, table.resourceId, table.safeCode)
      .where(sql`${table.state} = 'open'`),
    index('financial_reconciliation_issues_state_observed_idx').on(
      table.state,
      table.lastObservedAt,
      table.id
    ),
    check(
      'financial_reconciliation_issues_occurrence_positive',
      sql`${table.occurrenceCount} > 0`
    ),
    check(
      'financial_reconciliation_issues_resolution_consistent',
      sql`(${table.state} = 'resolved') = (${table.resolvedAt} is not null) and (${table.resolvedByAdminId} is null or ${table.state} = 'resolved')`
    ),
    check(
      'financial_reconciliation_issues_immutable_classification_open',
      sql`${table.resourceType} <> 'financial_classification' or ${table.safeCode} <> 'unsupported_category' or ${table.state} = 'open'`
    ),
    check(
      'financial_reconciliation_issues_safe_vocabulary',
      sql`${table.resourceType} ~ '^[a-z0-9_]{1,50}$' and ${table.safeCode} ~ '^[a-z0-9_]{1,100}$' and char_length(${table.correlationId}) between 1 and 100`
    ),
    check(
      'financial_reconciliation_issues_semantic_identity',
      sql`(
        (${table.resourceType} in ('payment', 'refund', 'dispute', 'allocation_set') and
          ${table.safeCode} in (
            'allocation_fork', 'allocation_incomplete', 'allocation_mismatch',
            'classification_fork', 'correction_rebase_required', 'currency_mismatch',
            'immutable_mismatch', 'missing_source', 'source_linkage_mismatch',
            'unsupported_category'
          ))
        or (${table.resourceType} = 'payout' and ${table.safeCode} in (
          'currency_mismatch', 'generation_exhausted', 'immutable_mismatch',
          'payout_membership_conflict', 'payout_reversal_incomplete'
        ))
        or (${table.resourceType} = 'balance_transaction' and
          ${table.safeCode} in ('classification_fork', 'immutable_mismatch'))
        or (${table.resourceType} = 'financial_classification' and
          ${table.safeCode} = 'unsupported_category')
      )`
    ),
    check(
      'financial_reconciliation_issues_semantic_impact',
      sql`(
        (${table.safeCode} in ('allocation_incomplete', 'missing_source') and ${table.impact} = 'pending')
        or (${table.safeCode} not in ('allocation_incomplete', 'missing_source') and ${table.impact} = 'exception')
      )`
    ),
    check(
      'financial_reconciliation_issues_observation_order',
      sql`${table.lastObservedAt} >= ${table.firstObservedAt}`
    )
  ]
);

export const refundAllocationComponents = pgTable(
  'refund_allocation_components',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundAllocationId: uuid('refund_allocation_id').notNull(),
    refundId: uuid('refund_id').notNull(),
    orderItemId: uuid('order_item_id').notNull(),
    subtotalMinor: integer('subtotal_minor').notNull(),
    taxMinor: integer('tax_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('refund_allocation_components_allocation_unique').on(table.refundAllocationId),
    index('refund_allocation_components_refund_item_idx').on(table.refundId, table.orderItemId),
    foreignKey({
      name: 'refund_allocation_components_graph_fk',
      columns: [table.refundAllocationId, table.refundId, table.orderItemId],
      foreignColumns: [
        refundAllocations.id,
        refundAllocations.refundId,
        refundAllocations.orderItemId
      ]
    }).onDelete('restrict'),
    check(
      'refund_allocation_components_money_nonnegative',
      sql`${table.subtotalMinor} between 0 and ${SAFE_MONEY_MAX_SQL} and ${table.taxMinor} between 0 and ${SAFE_MONEY_MAX_SQL} and ${table.totalMinor} between 0 and ${SAFE_MONEY_MAX_SQL}`
    ),
    check(
      'refund_allocation_components_total_consistent',
      sql`${table.totalMinor} = ${table.subtotalMinor} + ${table.taxMinor}`
    ),
    check('refund_allocation_components_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`)
  ]
);

export const disputeItemAllocations = pgTable(
  'dispute_item_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    allocationIdentity: varchar('allocation_identity', { length: 255 }).notNull(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    grossAllocationSetId: uuid('gross_allocation_set_id').notNull(),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    effect: disputeAllocationEffectEnum('effect').notNull(),
    reversesAllocationId: uuid('reverses_allocation_id').references(
      (): AnyPgColumn => disputeItemAllocations.id,
      { onDelete: 'restrict' }
    ),
    subtotalEffectMinor: integer('subtotal_effect_minor').notNull(),
    taxEffectMinor: integer('tax_effect_minor').notNull(),
    totalEffectMinor: integer('total_effect_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('dispute_item_allocations_identity_unique').on(table.allocationIdentity),
    uniqueIndex('dispute_item_allocations_gross_set_item_unique').on(
      table.grossAllocationSetId,
      table.orderItemId
    ),
    foreignKey({
      name: 'dispute_item_allocations_gross_set_graph_fk',
      columns: [table.grossAllocationSetId, table.disputeId],
      foreignColumns: [financialAllocationSets.id, financialAllocationSets.sourceInternalId]
    }).onDelete('restrict'),
    index('dispute_item_allocations_dispute_item_idx').on(
      table.disputeId,
      table.orderItemId,
      table.createdAt
    ),
    check(
      'dispute_item_allocations_money_bounded',
      sql`${table.subtotalEffectMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL} and ${table.taxEffectMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL} and ${table.totalEffectMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL}`
    ),
    check(
      'dispute_item_allocations_total_consistent',
      sql`${table.totalEffectMinor} = ${table.subtotalEffectMinor} + ${table.taxEffectMinor}`
    ),
    check('dispute_item_allocations_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'dispute_item_allocations_reversal_consistent',
      sql`(${table.effect} = 'reinstatement') = (${table.reversesAllocationId} is not null)`
    )
  ]
);

export const refundAllocationDrafts = pgTable(
  'refund_allocation_drafts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
    state: refundAllocationDraftStateEnum('state').default('active').notNull(),
    version: integer('version').default(1).notNull(),
    createdByAdminId: uuid('created_by_admin_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    updatedByAdminId: uuid('updated_by_admin_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdCorrelationId: varchar('created_correlation_id', { length: 100 }).notNull(),
    updatedCorrelationId: varchar('updated_correlation_id', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    discardedAt: timestamp('discarded_at', { withTimezone: true })
  },
  (table) => [
    uniqueIndex('refund_allocation_drafts_active_unique')
      .on(table.refundId)
      .where(sql`${table.state} = 'active'`),
    unique('refund_allocation_drafts_refund_version_unique').on(
      table.id,
      table.refundId,
      table.version
    ),
    check('refund_allocation_drafts_version_positive', sql`${table.version} > 0`),
    check(
      'refund_allocation_drafts_correlation_safe',
      sql`char_length(${table.createdCorrelationId}) between 1 and 100 and char_length(${table.updatedCorrelationId}) between 1 and 100`
    ),
    check(
      'refund_allocation_drafts_lifecycle_consistent',
      sql`(
        ${table.state} = 'active' and ${table.finalizedAt} is null and ${table.discardedAt} is null
      ) or (
        ${table.state} = 'finalized' and ${table.finalizedAt} is not null and ${table.discardedAt} is null
      ) or (
        ${table.state} = 'discarded' and ${table.finalizedAt} is null and ${table.discardedAt} is not null
      )`
    )
  ]
);

export const refundAllocationDraftItems = pgTable(
  'refund_allocation_draft_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => refundAllocationDrafts.id, { onDelete: 'restrict' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    proposedTotalPresentmentMinor: integer('proposed_total_presentment_minor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('refund_allocation_draft_items_draft_item_unique').on(
      table.draftId,
      table.orderItemId
    ),
    check(
      'refund_allocation_draft_items_amount_bounded',
      sql`${table.proposedTotalPresentmentMinor} between 0 and ${SAFE_MONEY_MAX_SQL}`
    )
  ]
);

export const refundReportingCorrectionSets = pgTable(
  'refund_reporting_correction_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
    correctionVersion: integer('correction_version').notNull(),
    kind: refundCorrectionKindEnum('kind').notNull(),
    baseAllocationSetId: uuid('base_allocation_set_id')
      .notNull()
      .references(() => financialAllocationSets.id, { onDelete: 'restrict' }),
    predecessorCorrectionSetId: uuid('predecessor_correction_set_id'),
    sourceFingerprintSha256: varchar('source_fingerprint_sha256', { length: 64 }).notNull(),
    approvedByAdminId: uuid('approved_by_admin_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdByAdminId: uuid('created_by_admin_id').references(() => user.id, {
      onDelete: 'restrict'
    }),
    correlationId: varchar('correlation_id', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    unique('refund_reporting_correction_sets_graph_identity_unique').on(
      table.id,
      table.refundId
    ),
    uniqueIndex('refund_reporting_correction_sets_identity_unique').on(
      table.refundId,
      table.correctionVersion
    ),
    uniqueIndex('refund_reporting_correction_sets_successor_unique')
      .on(table.predecessorCorrectionSetId)
      .where(sql`${table.predecessorCorrectionSetId} is not null`),
    uniqueIndex('refund_reporting_correction_sets_root_unique')
      .on(table.refundId)
      .where(sql`${table.predecessorCorrectionSetId} is null`),
    index('refund_reporting_correction_sets_base_idx').on(table.baseAllocationSetId, table.id),
    foreignKey({
      name: 'refund_reporting_correction_sets_predecessor_graph_fk',
      columns: [table.predecessorCorrectionSetId, table.refundId],
      foreignColumns: [table.id, table.refundId]
    }).onDelete('restrict'),
    check(
      'refund_reporting_correction_sets_version_positive',
      sql`${table.correctionVersion} > 0`
    ),
    check(
      'refund_reporting_correction_sets_fingerprint_sha256',
      sql`${table.sourceFingerprintSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'refund_reporting_correction_sets_creator_consistent',
      sql`(${table.kind} = 'allocation_attribution_correction' and ${table.createdByAdminId} is not null) or (${table.kind} = 'classifier_rebase' and ${table.createdByAdminId} is null)`
    ),
    check(
      'refund_reporting_correction_sets_correlation_safe',
      sql`char_length(${table.correlationId}) between 1 and 100`
    )
  ]
);

export const refundReportingCorrectionItems = pgTable(
  'refund_reporting_correction_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    correctionSetId: uuid('correction_set_id')
      .notNull()
      .references(() => refundReportingCorrectionSets.id, { onDelete: 'restrict' }),
    domain: refundCorrectionDomainEnum('domain').notNull(),
    sourceAllocationSetId: uuid('source_allocation_set_id').references(
      () => financialAllocationSets.id,
      { onDelete: 'restrict' }
    ),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    component: financialComponentEnum('component').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    approvedAbsoluteMinor: integer('approved_absolute_minor').notNull(),
    deltaMinor: integer('delta_minor').notNull(),
    stableTieBreakKey: varchar('stable_tie_break_key', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('refund_reporting_correction_items_set_item_component_unique').on(
      table.correctionSetId,
      table.domain,
      sql`coalesce(${table.sourceAllocationSetId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.currency,
      table.orderItemId,
      table.component
    ),
    uniqueIndex('refund_reporting_correction_items_set_tie_key_unique').on(
      table.correctionSetId,
      table.stableTieBreakKey
    ),
    check(
      'refund_reporting_correction_items_domain_source_consistent',
      sql`(${table.domain} = 'presentment') = (${table.sourceAllocationSetId} is null)`
    ),
    check(
      'refund_reporting_correction_items_component_consistent',
      sql`(
        ${table.domain} = 'presentment' and
        ${table.component} in ('refund_subtotal', 'refund_tax')
      ) or (
        ${table.domain} = 'settlement' and
        ${table.component} in ('refund_subtotal', 'refund_tax', 'refund_fee')
      )`
    ),
    check(
      'refund_reporting_correction_items_money_bounded',
      sql`${table.approvedAbsoluteMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL} and ${table.deltaMinor} between ${SAFE_MONEY_MIN_SQL} and ${SAFE_MONEY_MAX_SQL}`
    ),
    check(
      'refund_reporting_correction_items_currency_iso',
      sql`${table.currency} ~ '^[A-Z]{3}$'`
    ),
    check(
      'refund_reporting_correction_items_tie_key_safe',
      sql`char_length(${table.stableTieBreakKey}) between 1 and 255`
    )
  ]
);

export const refundAllocationFinalizationEffects = pgTable(
  'refund_allocation_finalization_effects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundId: uuid('refund_id').notNull(),
    refundAllocationId: uuid('refund_allocation_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    draftVersion: integer('draft_version').notNull(),
    orderItemId: uuid('order_item_id').notNull(),
    purchaseGrantId: uuid('purchase_grant_id').notNull(),
    beforePurchaseGrantState: entitlementGrantStatus('before_purchase_grant_state').notNull(),
    afterPurchaseGrantState: entitlementGrantStatus('after_purchase_grant_state').notNull(),
    beforeEffectiveAccess: boolean('before_effective_access').notNull(),
    afterEffectiveAccess: boolean('after_effective_access').notNull(),
    transition: financialFinalizationTransitionEnum('transition').notNull(),
    correlationId: varchar('correlation_id', { length: 100 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('refund_allocation_finalization_effects_causal_unique').on(
      table.refundAllocationId,
      table.purchaseGrantId
    ),
    index('refund_allocation_finalization_effects_refund_item_idx').on(
      table.refundId,
      table.orderItemId,
      table.id
    ),
    foreignKey({
      name: 'refund_allocation_finalization_effects_allocation_graph_fk',
      columns: [table.refundAllocationId, table.refundId, table.orderItemId],
      foreignColumns: [refundAllocations.id, refundAllocations.refundId, refundAllocations.orderItemId]
    }).onDelete('restrict'),
    foreignKey({
      name: 'refund_allocation_finalization_effects_draft_version_fk',
      columns: [table.draftId, table.refundId, table.draftVersion],
      foreignColumns: [refundAllocationDrafts.id, refundAllocationDrafts.refundId, refundAllocationDrafts.version]
    }).onDelete('restrict'),
    foreignKey({
      name: 'refund_allocation_finalization_effects_draft_item_fk',
      columns: [table.draftId, table.orderItemId],
      foreignColumns: [refundAllocationDraftItems.draftId, refundAllocationDraftItems.orderItemId]
    }).onDelete('restrict'),
    foreignKey({
      name: 'refund_allocation_finalization_effects_purchase_grant_fk',
      columns: [table.purchaseGrantId, table.orderItemId],
      foreignColumns: [entitlementGrants.id, entitlementGrants.orderItemId]
    }).onDelete('restrict'),
    check(
      'refund_allocation_finalization_effects_draft_version_positive',
      sql`${table.draftVersion} > 0`
    ),
    check(
      'refund_allocation_finalization_effects_transition_consistent',
      sql`(
        ${table.transition} = 'unchanged' and
        ${table.beforePurchaseGrantState} = ${table.afterPurchaseGrantState} and
        ${table.beforeEffectiveAccess} = ${table.afterEffectiveAccess}
      ) or (
        ${table.transition} = 'revoked_by_finalization' and ${table.beforePurchaseGrantState} <> 'revoked' and ${table.afterPurchaseGrantState} = 'revoked'
      )`
    ),
    check(
      'refund_allocation_finalization_effects_correlation_safe',
      sql`char_length(${table.correlationId}) between 1 and 100`
    )
  ]
);

export const currentFinancialProjectionHeads = pgView('current_financial_projection_heads', {
  balanceTransactionId: uuid('balance_transaction_id').notNull(),
  basis: allocationBasisEnum('basis').notNull(),
  baseSetId: uuid('base_set_id'),
  compatibleCorrectionTipId: uuid('compatible_correction_tip_id'),
  scope: allocationScopeEnum('scope'),
  currency: varchar('currency', { length: 3 }),
  expectedEffectMinor: integer('expected_effect_minor'),
  isComplete: boolean('is_complete').notNull(),
  missingSourceCount: integer('missing_source_count').notNull(),
  proposedIssueCode: varchar('proposed_issue_code', { length: 100 })
}).as(sql`
  with active_projection_version as (
    select classifier_version, allocation_algorithm_version
    from ${financialProjectionVersions}
    where singleton = true
  ), active_classification_job_markers as (
    select bt.id as balance_transaction_id,
      count(classification_job.id)::integer as marker_count
    from ${stripeBalanceTransactions} bt
    cross join active_projection_version
    left join ${jobs} classification_job
      on classification_job.type = ${FINANCIAL_CLASSIFICATION_JOB_SQL}
      and classification_job.deduplication_key =
        'financial:classification:' || active_projection_version.classifier_version::text ||
        ':' || active_projection_version.allocation_algorithm_version::text ||
        ':balance_transaction:' || bt.id::text || ':' || bt.fingerprint_sha256
      and classification_job.status <> 'succeeded'
    group by bt.id, active_projection_version.classifier_version,
      active_projection_version.allocation_algorithm_version
  ), current_parent_classification_candidates as (
    select
      bt.id as balance_transaction_id,
      count(classification.id)::integer as decision_count,
      count(*) filter (where classification.classification = 'unknown')::integer as unknown_count
    from ${stripeBalanceTransactions} bt
    cross join active_projection_version
    left join ${financialClassificationVersions} classification
      on classification.subject_type = 'balance_transaction'
      and classification.subject_id = bt.id
      and classification.source_fingerprint_sha256 = bt.fingerprint_sha256
      and classification.classifier_version = active_projection_version.classifier_version
    group by bt.id, active_projection_version.classifier_version
  ), current_fee_detail_classification_candidates as (
    select
      detail.balance_transaction_id,
      detail.id as fee_detail_id,
      detail.amount_minor,
      detail.currency,
      count(classification.id)::integer as decision_count,
      count(*) filter (where classification.classification = 'unknown')::integer as unknown_count
    from ${stripeBalanceTransactionFeeDetails} detail
    cross join active_projection_version
    left join ${financialClassificationVersions} classification
      on classification.subject_type = 'fee_detail'
      and classification.subject_id = detail.id
      and classification.source_fingerprint_sha256 = detail.fingerprint_sha256
      and classification.classifier_version = active_projection_version.classifier_version
    group by detail.balance_transaction_id, detail.id, detail.amount_minor, detail.currency,
      active_projection_version.classifier_version
  ), current_fee_classification_candidates as (
    select
      bt.id as balance_transaction_id,
      count(detail.fee_detail_id)::integer as detail_count,
      coalesce(sum(detail.amount_minor), 0::bigint) as detail_amount_sum,
      count(detail.fee_detail_id) filter (where detail.currency <> bt.currency)::integer as currency_mismatch_count,
      coalesce(sum(detail.decision_count), 0::bigint)::integer as decision_count,
      coalesce(sum(detail.unknown_count), 0::bigint)::integer as unknown_count
    from ${stripeBalanceTransactions} bt
    left join current_fee_detail_classification_candidates detail
      on detail.balance_transaction_id = bt.id
    group by bt.id
  ), current_classification_status as (
    select
      parent.balance_transaction_id,
      parent.decision_count as parent_decision_count,
      parent.unknown_count as parent_unknown_count,
      fee.detail_count as fee_detail_count,
      fee.detail_amount_sum as fee_detail_amount_sum,
      fee.currency_mismatch_count as fee_currency_mismatch_count,
      fee.decision_count as fee_decision_count,
      fee.unknown_count as fee_unknown_count
    from current_parent_classification_candidates parent
    join current_fee_classification_candidates fee
      on fee.balance_transaction_id = parent.balance_transaction_id
  ), eligible_allocation_sets as (
    select s.*
    from ${financialAllocationSets} s
    cross join active_projection_version
    where s.classifier_version = active_projection_version.classifier_version
      and s.algorithm_version = active_projection_version.allocation_algorithm_version
  ), eligible_base_tips_unranked as (
    select s.*
    from eligible_allocation_sets s
    where not exists (
      select 1 from eligible_allocation_sets successor
      where successor.supersedes_set_id = s.id
    )
  ), eligible_base_tips as (
    select
      tip.*,
      count(*) over (
        partition by tip.balance_transaction_id, tip.basis
      ) as tip_count
    from eligible_base_tips_unranked tip
  ), base_rollup as (
    select
      bt.id as balance_transaction_id,
      basis.value as basis,
      count(base.id)::integer as base_count,
      (array_agg(base.id order by base.id) filter (where base.id is not null))[1] as base_set_id,
      (array_agg(base.scope order by base.id) filter (where base.id is not null))[1] as scope,
      (array_agg(base.currency order by base.id) filter (where base.id is not null))[1] as currency,
      (array_agg(base.expected_effect_minor order by base.id) filter (where base.id is not null))[1] as expected_effect_minor,
      (array_agg(base.source_kind order by base.id) filter (where base.id is not null))[1] as source_kind,
      (array_agg(base.source_internal_id order by base.id) filter (where base.id is not null))[1] as source_internal_id,
      (array_agg(base.source_fingerprint_sha256 order by base.id) filter (where base.id is not null))[1] as source_fingerprint_sha256,
      bt.fingerprint_sha256 as provider_fingerprint,
      classification.parent_decision_count,
      classification.parent_unknown_count,
      classification.fee_detail_count,
      classification.fee_detail_amount_sum,
      classification.fee_currency_mismatch_count,
      classification.fee_decision_count,
      classification.fee_unknown_count,
      case when basis.value = 'gross_amount'::financial_allocation_basis then bt.amount_minor else -bt.fee_minor end as provider_expected_effect,
      bt.fee_minor as provider_fee_minor,
      bt.currency as provider_currency
    from ${stripeBalanceTransactions} bt
    cross join (values
      ('gross_amount'::financial_allocation_basis),
      ('fee'::financial_allocation_basis)
    ) basis(value)
    join current_classification_status classification
      on classification.balance_transaction_id = bt.id
    left join eligible_base_tips base
      on base.balance_transaction_id = bt.id and base.basis = basis.value
    group by bt.id, basis.value, bt.amount_minor, bt.fee_minor, bt.currency, bt.fingerprint_sha256,
      classification.parent_decision_count, classification.parent_unknown_count,
      classification.fee_detail_count, classification.fee_detail_amount_sum,
      classification.fee_currency_mismatch_count, classification.fee_decision_count,
      classification.fee_unknown_count
  ), base_item_rollup as (
    select
      s.id as base_set_id,
      count(item.id)::integer as item_count,
      coalesce(sum(item.effect_minor), 0::bigint) as item_effect_sum,
      count(item.id) filter (where item.currency <> s.currency)::integer as currency_mismatch_count
    from eligible_base_tips s
    left join ${financialItemAllocations} item on item.allocation_set_id = s.id
    group by s.id
  ), refund_presentment_components as (
    select
      allocation.refund_id,
      allocation.order_item_id,
      allocation.currency,
      component.component,
      component.amount_minor
    from ${refundAllocationComponents} allocation
    cross join lateral (values
      ('refund_subtotal'::financial_component, allocation.subtotal_minor),
      ('refund_tax'::financial_component, allocation.tax_minor)
    ) component(component, amount_minor)
  ), correction_tip_candidates as (
    select correction.*
    from ${refundReportingCorrectionSets} correction
    where exists (
      select 1 from eligible_allocation_sets anchor
      where anchor.id = correction.base_allocation_set_id
    )
    and not exists (
      select 1
      from ${refundReportingCorrectionSets} successor
      join eligible_allocation_sets successor_anchor
        on successor_anchor.id = successor.base_allocation_set_id
      where successor.predecessor_correction_set_id = correction.id
    )
  ), correction_prevalidation as (
    select
      correction.*,
      correction_refund.payment_id as refund_payment_id,
      correction_refund.currency as refund_currency,
      correction_payment.order_id as refund_order_id,
      case when
        exists (
          select 1
          from ${refundReportingCorrectionItems} correction_item
          where correction_item.correction_set_id = correction.id
        ) and
        correction_refund.status = 'succeeded' and
        correction_refund.currency = correction_payment.currency and
        anchor.id is not null and
        anchor.tip_count = 1 and
        anchor.source_kind = 'refund'::financial_allocation_source_kind and
        anchor.source_internal_id = correction.refund_id and
        anchor.source_fingerprint_sha256 = correction.source_fingerprint_sha256
      then 0 else 1 end::bigint as invalid_refund_context_count,
      (
        select count(*)
        from ${refundReportingCorrectionItems} correction_item
        left join eligible_base_tips item_source
          on item_source.id = correction_item.source_allocation_set_id
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            item_source.id is null or
            item_source.tip_count <> 1 or
            item_source.source_kind <> 'refund'::financial_allocation_source_kind or
            item_source.source_internal_id <> correction.refund_id or
            item_source.source_fingerprint_sha256 <> correction.source_fingerprint_sha256 or
            correction_item.currency <> item_source.currency
          )
      ) as invalid_settlement_source_count,
      (
        select count(*)
        from (
          select
            correction_item.domain,
            correction_item.source_allocation_set_id,
            correction_item.currency
          from ${refundReportingCorrectionItems} correction_item
          where correction_item.correction_set_id = correction.id
          group by correction_item.domain,
            correction_item.source_allocation_set_id,
            correction_item.currency
          having sum(correction_item.delta_minor::bigint) <> 0
        ) invalid_delta_group
      ) as invalid_delta_group_count,
      (
        select count(*)
        from ${refundReportingCorrectionItems} correction_item
        where correction_item.correction_set_id = correction.id
          and (
            not exists (
              select 1
              from ${orderItems} order_item
              where order_item.id = correction_item.order_item_id
                and order_item.order_id = correction_payment.order_id
                and (
                  correction_item.domain <> 'presentment' or
                  order_item.currency = correction_item.currency
                )
            ) or (
              correction_item.domain = 'presentment' and
              correction_item.currency <> correction_refund.currency
            )
          )
      ) as invalid_order_item_count,
      (
        select count(*)
        from ${refundReportingCorrectionItems} correction_item
        left join ${financialItemAllocations} base_item
          on base_item.allocation_set_id = correction_item.source_allocation_set_id
          and base_item.order_item_id = correction_item.order_item_id
          and base_item.component = correction_item.component
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            correction_item.approved_absolute_minor::bigint <>
              coalesce(base_item.effect_minor, 0)::bigint + correction_item.delta_minor::bigint or
            (base_item.id is not null and base_item.currency <> correction_item.currency)
          )
      ) as invalid_settlement_arithmetic_count,
      (
        select count(*)
        from ${financialItemAllocations} base_item
        where base_item.effect_minor <> 0
          and exists (
            select 1
            from ${refundReportingCorrectionItems} source_item
            where source_item.correction_set_id = correction.id
              and source_item.domain = 'settlement'
              and source_item.source_allocation_set_id = base_item.allocation_set_id
          )
          and not exists (
            select 1
            from ${refundReportingCorrectionItems} correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'settlement'
              and correction_item.source_allocation_set_id = base_item.allocation_set_id
              and correction_item.order_item_id = base_item.order_item_id
              and correction_item.component = base_item.component
              and correction_item.currency = base_item.currency
          )
      ) as missing_settlement_base_count,
      (
        select count(*)
        from ${refundReportingCorrectionItems} correction_item
        left join refund_presentment_components base_component
          on base_component.refund_id = correction.refund_id
          and base_component.order_item_id = correction_item.order_item_id
          and base_component.component = correction_item.component
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'presentment'
          and (
            correction_item.approved_absolute_minor < 0 or
            correction_item.approved_absolute_minor::bigint <>
              coalesce(base_component.amount_minor, 0)::bigint + correction_item.delta_minor::bigint or
            (base_component.refund_id is not null and
              base_component.currency <> correction_item.currency)
          )
      ) as invalid_presentment_arithmetic_count,
      (
        select count(*)
        from refund_presentment_components base_component
        where base_component.refund_id = correction.refund_id
          and base_component.amount_minor <> 0
          and exists (
            select 1
            from ${refundReportingCorrectionItems} presentment_item
            where presentment_item.correction_set_id = correction.id
              and presentment_item.domain = 'presentment'
          )
          and not exists (
            select 1
            from ${refundReportingCorrectionItems} correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'presentment'
              and correction_item.order_item_id = base_component.order_item_id
              and correction_item.component = base_component.component
              and correction_item.currency = base_component.currency
          )
      ) as missing_presentment_base_count
    from correction_tip_candidates correction
    join ${refunds} correction_refund on correction_refund.id = correction.refund_id
    join ${payments} correction_payment on correction_payment.id = correction_refund.payment_id
    left join eligible_base_tips anchor on anchor.id = correction.base_allocation_set_id
  ), prevalidated_correction_tips as (
    select
      correction.*,
      (
        correction.invalid_refund_context_count +
        correction.invalid_settlement_source_count +
        correction.invalid_delta_group_count +
        correction.invalid_order_item_count +
        correction.invalid_settlement_arithmetic_count +
        correction.missing_settlement_base_count +
        correction.invalid_presentment_arithmetic_count +
        correction.missing_presentment_base_count
      )::bigint as invalid_noncapacity_count
    from correction_prevalidation correction
  ), effective_presentment_components as (
    select
      effective_refund.payment_id,
      base_component.refund_id,
      base_component.order_item_id,
      base_component.component,
      base_component.currency,
      base_component.amount_minor::bigint as effect_minor
    from refund_presentment_components base_component
    join ${refunds} effective_refund on effective_refund.id = base_component.refund_id
    where effective_refund.status = 'succeeded'
      and not exists (
        select 1
        from prevalidated_correction_tips correction
        where correction.refund_id = base_component.refund_id
          and correction.invalid_noncapacity_count = 0
          and exists (
            select 1
            from ${refundReportingCorrectionItems} correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'presentment'
          )
      )
    union all
    select
      correction.refund_payment_id as payment_id,
      correction.refund_id,
      correction_item.order_item_id,
      correction_item.component,
      correction_item.currency,
      correction_item.approved_absolute_minor::bigint as effect_minor
    from prevalidated_correction_tips correction
    join ${refundReportingCorrectionItems} correction_item
      on correction_item.correction_set_id = correction.id
      and correction_item.domain = 'presentment'
    where correction.invalid_noncapacity_count = 0
  ), presentment_capacity_status as (
    select
      effect.payment_id,
      effect.order_item_id,
      effect.component,
      effect.currency,
      sum(effect.effect_minor)::bigint as cumulative_effect_minor,
      case effect.component
        when 'refund_subtotal'::financial_component then order_item.unit_subtotal_minor
        when 'refund_tax'::financial_component then coalesce(order_item.tax_minor, 0)
        else 0
      end::bigint as capacity_minor
    from effective_presentment_components effect
    join ${orderItems} order_item on order_item.id = effect.order_item_id
    group by effect.payment_id, effect.order_item_id, effect.component, effect.currency,
      order_item.unit_subtotal_minor, order_item.tax_minor
  ), current_correction_tips as (
    select
      correction.*,
      (
        correction.invalid_noncapacity_count + (
          select count(*)
          from ${refundReportingCorrectionItems} correction_item
          left join presentment_capacity_status capacity
            on capacity.payment_id = correction.refund_payment_id
            and capacity.order_item_id = correction_item.order_item_id
            and capacity.component = correction_item.component
            and capacity.currency = correction_item.currency
          where correction_item.correction_set_id = correction.id
            and correction_item.domain = 'presentment'
            and (
              capacity.order_item_id is null or
              capacity.cumulative_effect_minor < 0 or
              capacity.cumulative_effect_minor > capacity.capacity_minor
            )
        )
      )::bigint as invalid_correction_count
    from prevalidated_correction_tips correction
  ), correction_rollup as (
    select
      correction.refund_id,
      count(correction.id)::integer as correction_count,
      (array_agg(correction.id order by correction.id))[1] as correction_tip_id,
      (array_agg(correction.base_allocation_set_id order by correction.id))[1] as anchor_base_set_id,
      (array_agg(correction.source_fingerprint_sha256 order by correction.id))[1] as correction_fingerprint,
      coalesce(sum(correction.invalid_correction_count), 0::bigint) as invalid_correction_count
    from current_correction_tips correction
    group by correction.refund_id
  ), correction_status as (
    select
      correction.*,
      (
        correction.correction_count = 1 and
        correction.invalid_correction_count = 0 and
        anchor.id is not null and
        anchor.tip_count = 1 and
        anchor.source_kind = 'refund'::financial_allocation_source_kind and
        anchor.source_internal_id = correction.refund_id and
        anchor.source_fingerprint_sha256 = correction.correction_fingerprint
      )::boolean as is_compatible
    from correction_rollup correction
    left join eligible_base_tips anchor on anchor.id = correction.anchor_base_set_id
  ), correction_item_rollup as (
    select
      item.source_allocation_set_id as base_set_id,
      item.correction_set_id,
      count(*)::integer as item_count,
      coalesce(sum(item.approved_absolute_minor), 0::bigint) as item_effect_sum,
      count(*) filter (where item.currency <> source.currency)::integer as currency_mismatch_count
    from ${refundReportingCorrectionItems} item
    join ${financialAllocationSets} source on source.id = item.source_allocation_set_id
    where item.domain = 'settlement'
    group by item.source_allocation_set_id, item.correction_set_id
  ), open_classification_fork_issues as (
    select issue.resource_id as balance_transaction_id, count(*)::integer as issue_count
    from ${financialReconciliationIssues} issue
    where issue.safe_code = 'classification_fork'
      and issue.resource_type = 'balance_transaction'
      and issue.state = 'open'
      and issue.impact = 'exception'
    group by issue.resource_id
  ), open_allocation_set_issues as (
    select issue.resource_id as allocation_set_id,
      count(*)::integer as issue_count,
      (array_agg(issue.safe_code order by
        case when issue.impact = 'exception' then 0 else 1 end,
        issue.safe_code collate "C", issue.id))[1]::varchar(100)
        as issue_code
    from ${financialReconciliationIssues} issue
    where issue.resource_type = 'allocation_set'
      and issue.state = 'open'
      and issue.impact <> 'informational'
    group by issue.resource_id
  ), resolved as (
    select
      base.*,
      coalesce(items.item_count, 0) as base_item_count,
      coalesce(items.item_effect_sum, 0::bigint) as base_item_effect_sum,
      coalesce(items.currency_mismatch_count, 0) as base_item_currency_mismatch_count,
      coalesce(correction.correction_count, 0) as correction_count,
      correction.correction_tip_id,
      correction.correction_fingerprint,
      coalesce(correction.is_compatible, false) as correction_is_compatible,
      coalesce(correction_items.item_count, 0) as correction_item_count,
      coalesce(correction_items.item_effect_sum, 0::bigint) as correction_item_effect_sum,
      coalesce(correction_items.currency_mismatch_count, 0) as correction_item_currency_mismatch_count,
      coalesce(classification_issue.issue_count, 0) as classification_fork_issue_count,
      coalesce(selected_set_issue.issue_count, 0) as selected_set_issue_count,
      selected_set_issue.issue_code as selected_set_issue_code,
      coalesce(active_job.marker_count, 0) as active_job_marker_count
    from base_rollup base
    left join base_item_rollup items on items.base_set_id = base.base_set_id
    left join correction_status correction
      on base.source_kind = 'refund'::financial_allocation_source_kind
      and correction.refund_id = base.source_internal_id
    left join correction_item_rollup correction_items
      on correction_items.base_set_id = base.base_set_id
      and correction_items.correction_set_id = correction.correction_tip_id
    left join open_classification_fork_issues classification_issue
      on classification_issue.balance_transaction_id = base.balance_transaction_id
    left join open_allocation_set_issues selected_set_issue
      on selected_set_issue.allocation_set_id = base.base_set_id
    left join active_classification_job_markers active_job
      on active_job.balance_transaction_id = base.balance_transaction_id
  )
  select
    balance_transaction_id,
    basis,
    case when base_count = 1 and classification_fork_issue_count = 0 and
      selected_set_issue_count = 0 and
      active_job_marker_count = 0
      then base_set_id else null::uuid end as base_set_id,
    case when base_count = 1 and classification_fork_issue_count = 0 and
      selected_set_issue_count = 0 and
      active_job_marker_count = 0 and
      correction_count = 1 and correction_is_compatible
      then correction_tip_id else null::uuid end as compatible_correction_tip_id,
    case when base_count = 1 and classification_fork_issue_count = 0 and
      selected_set_issue_count = 0 and
      active_job_marker_count = 0
      then scope else null::financial_allocation_scope end as scope,
    case when base_count = 1 and classification_fork_issue_count = 0 and
      selected_set_issue_count = 0 and
      active_job_marker_count = 0
      then currency else null::varchar(3) end as currency,
    case when base_count = 1 and classification_fork_issue_count = 0 and
      selected_set_issue_count = 0 and
      active_job_marker_count = 0
      then expected_effect_minor else null::integer end as expected_effect_minor,
    (
      classification_fork_issue_count = 0 and selected_set_issue_count = 0 and
      active_job_marker_count = 0 and
      base_count = 1 and
      scope <> 'unresolved'::financial_allocation_scope and
      parent_decision_count = 1 and parent_unknown_count = 0 and
      (basis <> 'fee'::financial_allocation_basis or
        (fee_decision_count = fee_detail_count and fee_unknown_count = 0 and
          fee_detail_amount_sum = provider_fee_minor and fee_currency_mismatch_count = 0)) and
      source_fingerprint_sha256 = provider_fingerprint and
      currency = provider_currency and expected_effect_minor = provider_expected_effect and
      (
        (
          correction_count = 0 and
          ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0))
        ) or (
          correction_count = 1 and correction_is_compatible and
          (
            (correction_item_count > 0 and scope = 'title' and correction_item_currency_mismatch_count = 0 and correction_item_effect_sum = expected_effect_minor) or
            (correction_item_count = 0 and ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0)))
          )
        )
      )
    )::boolean as is_complete,
    case when selected_set_issue_count > 0 then 1
    when classification_fork_issue_count > 0 then 1
    when active_job_marker_count > 0 then 1
    when
      base_count = 1 and scope <> 'unresolved'::financial_allocation_scope and
      parent_decision_count = 1 and parent_unknown_count = 0 and
      (basis <> 'fee'::financial_allocation_basis or
        (fee_decision_count = fee_detail_count and fee_unknown_count = 0 and
          fee_detail_amount_sum = provider_fee_minor and fee_currency_mismatch_count = 0)) and
      source_fingerprint_sha256 = provider_fingerprint and
      currency = provider_currency and expected_effect_minor = provider_expected_effect and
      (
        (
          correction_count = 0 and
          ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0))
        ) or (
          correction_count = 1 and correction_is_compatible and
          (
            (correction_item_count > 0 and scope = 'title' and correction_item_currency_mismatch_count = 0 and correction_item_effect_sum = expected_effect_minor) or
            (correction_item_count = 0 and ((scope = 'title' and (base_item_count > 0 or expected_effect_minor = 0) and base_item_currency_mismatch_count = 0 and base_item_effect_sum = expected_effect_minor) or (scope = 'account' and base_item_count = 0)))
          )
        )
      ) then 0 else 1 end::integer as missing_source_count,
    case
      when selected_set_issue_count > 0 then selected_set_issue_code
      when classification_fork_issue_count > 0 then 'classification_fork'::varchar(100)
      when parent_decision_count = 0 then 'missing_source'::varchar(100)
      when parent_decision_count > 1 then 'classification_fork'::varchar(100)
      when parent_unknown_count > 0 then 'unsupported_category'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_currency_mismatch_count > 0 then 'currency_mismatch'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_detail_amount_sum <> provider_fee_minor then 'allocation_mismatch'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_decision_count > fee_detail_count then 'classification_fork'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_unknown_count > 0 then 'unsupported_category'::varchar(100)
      when basis = 'fee'::financial_allocation_basis and fee_decision_count < fee_detail_count then 'missing_source'::varchar(100)
      when active_job_marker_count > 0 then 'missing_source'::varchar(100)
      when base_count = 0 then 'missing_source'::varchar(100)
      when base_count > 1 then 'allocation_fork'::varchar(100)
      when source_fingerprint_sha256 <> provider_fingerprint then 'immutable_mismatch'::varchar(100)
      when currency <> provider_currency then 'currency_mismatch'::varchar(100)
      when expected_effect_minor <> provider_expected_effect then 'allocation_mismatch'::varchar(100)
      when scope = 'unresolved' then 'allocation_incomplete'::varchar(100)
      when correction_count > 1 then 'correction_rebase_required'::varchar(100)
      when correction_count = 1 and not correction_is_compatible then 'correction_rebase_required'::varchar(100)
      when correction_count = 1 and correction_item_count > 0 and correction_item_currency_mismatch_count > 0 then 'currency_mismatch'::varchar(100)
      when correction_count = 1 and correction_item_count > 0 and (scope <> 'title' or correction_item_effect_sum <> expected_effect_minor) then 'allocation_mismatch'::varchar(100)
      when (correction_count = 0 or correction_item_count = 0) and base_item_currency_mismatch_count > 0 then 'currency_mismatch'::varchar(100)
      when (correction_count = 0 or correction_item_count = 0) and ((scope = 'title' and ((base_item_count = 0 and expected_effect_minor <> 0) or base_item_effect_sum <> expected_effect_minor)) or (scope = 'account' and base_item_count <> 0)) then 'allocation_mismatch'::varchar(100)
      else null::varchar(100)
    end as proposed_issue_code
  from resolved
`);

export const currentFinancialProjectionItems = pgView('current_financial_projection_items', {
  balanceTransactionId: uuid('balance_transaction_id').notNull(),
  basis: allocationBasisEnum('basis').notNull(),
  baseSetId: uuid('base_set_id').notNull(),
  compatibleCorrectionTipId: uuid('compatible_correction_tip_id'),
  orderItemId: uuid('order_item_id').notNull(),
  component: financialComponentEnum('component').notNull(),
  effectMinor: integer('effect_minor').notNull(),
  currency: varchar('currency', { length: 3 }).notNull()
}).as(sql`
  select
    head.balance_transaction_id,
    head.basis,
    head.base_set_id,
    head.compatible_correction_tip_id,
    base.order_item_id,
    base.component,
    base.effect_minor,
    base.currency
  from ${currentFinancialProjectionHeads} head
  join ${financialItemAllocations} base on base.allocation_set_id = head.base_set_id
  where head.is_complete
    and head.scope = 'title'
    and not exists (
      select 1
      from ${refundReportingCorrectionItems} correction
      where correction.correction_set_id = head.compatible_correction_tip_id
        and correction.source_allocation_set_id = head.base_set_id
        and correction.domain = 'settlement'
    )
  union all
  select
    head.balance_transaction_id,
    head.basis,
    head.base_set_id,
    head.compatible_correction_tip_id,
    correction.order_item_id,
    correction.component,
    correction.approved_absolute_minor as effect_minor,
    correction.currency
  from ${currentFinancialProjectionHeads} head
  join ${refundReportingCorrectionItems} correction
    on correction.correction_set_id = head.compatible_correction_tip_id
    and correction.source_allocation_set_id = head.base_set_id
    and correction.domain = 'settlement'
  where head.is_complete
    and head.scope = 'title'
`);

export type FinancialAllocationSetRow = typeof financialAllocationSets.$inferSelect;
export type NewFinancialAllocationSetRow = typeof financialAllocationSets.$inferInsert;
export type FinancialItemAllocationRow = typeof financialItemAllocations.$inferSelect;
export type NewFinancialItemAllocationRow = typeof financialItemAllocations.$inferInsert;
export type FinancialIssueRow = typeof financialReconciliationIssues.$inferSelect;
export type NewFinancialIssueRow = typeof financialReconciliationIssues.$inferInsert;
export type RefundAllocationComponentRow = typeof refundAllocationComponents.$inferSelect;
export type NewRefundAllocationComponentRow = typeof refundAllocationComponents.$inferInsert;
export type DisputeItemAllocationRow = typeof disputeItemAllocations.$inferSelect;
export type NewDisputeItemAllocationRow = typeof disputeItemAllocations.$inferInsert;
export type RefundAllocationDraftRow = typeof refundAllocationDrafts.$inferSelect;
export type NewRefundAllocationDraftRow = typeof refundAllocationDrafts.$inferInsert;
export type RefundAllocationDraftItemRow = typeof refundAllocationDraftItems.$inferSelect;
export type NewRefundAllocationDraftItemRow = typeof refundAllocationDraftItems.$inferInsert;
export type RefundReportingCorrectionSetRow = typeof refundReportingCorrectionSets.$inferSelect;
export type NewRefundReportingCorrectionSetRow = typeof refundReportingCorrectionSets.$inferInsert;
export type RefundReportingCorrectionItemRow = typeof refundReportingCorrectionItems.$inferSelect;
export type NewRefundReportingCorrectionItemRow = typeof refundReportingCorrectionItems.$inferInsert;
export type RefundAllocationFinalizationEffectRow =
  typeof refundAllocationFinalizationEffects.$inferSelect;
export type NewRefundAllocationFinalizationEffectRow =
  typeof refundAllocationFinalizationEffects.$inferInsert;
export type CurrentFinancialProjectionHeadsView = typeof currentFinancialProjectionHeads;
export type CurrentFinancialProjectionItemsView = typeof currentFinancialProjectionItems;
export type CurrentFinancialProjectionHeadRow = typeof currentFinancialProjectionHeads.$inferSelect;
export type CurrentFinancialProjectionItemRow = typeof currentFinancialProjectionItems.$inferSelect;
