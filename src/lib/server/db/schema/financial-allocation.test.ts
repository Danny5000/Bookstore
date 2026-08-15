import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, getViewConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  allocationBasisEnum,
  allocationScopeEnum,
  currentFinancialProjectionHeads,
  currentFinancialProjectionItems,
  disputeItemAllocations,
  disputeAllocationEffectEnum,
  financialAllocationSourceKindEnum,
  financialAllocationSets,
  financialFinalizationTransitionEnum,
  financialIssueImpactEnum,
  financialIssueStateEnum,
  financialItemAllocations,
  financialComponentEnum,
  financialReconciliationIssues,
  refundAllocationComponents,
  refundAllocationDraftItems,
  refundAllocationDraftStateEnum,
  refundAllocationDrafts,
  refundAllocationFinalizationEffects,
  refundReportingCorrectionItems,
  refundReportingCorrectionSets,
  refundCorrectionDomainEnum,
  refundCorrectionKindEnum
} from './financial-allocation';

const TABLES = [
  financialAllocationSets,
  financialItemAllocations,
  financialReconciliationIssues,
  refundAllocationComponents,
  disputeItemAllocations,
  refundAllocationDrafts,
  refundAllocationDraftItems,
  refundReportingCorrectionSets,
  refundReportingCorrectionItems,
  refundAllocationFinalizationEffects
] as const;

const configFor = (table: PgTable) => getTableConfig(table);
const indexNames = (table: PgTable) => configFor(table).indexes.map((item) => item.config.name);
const checkNames = (table: PgTable) => configFor(table).checks.map((item) => item.name);
const uniqueNames = (table: PgTable) =>
  configFor(table).uniqueConstraints.map((item) => item.name);
const tableName = (table: PgTable) => configFor(table).name;
const renderedSql = (query: SQL) =>
  query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  }).sql.replaceAll(/\s+/gu, ' ');
const foreignKeySignatures = () =>
  TABLES.flatMap((table) =>
    configFor(table).foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return `${tableName(table)}(${reference.columns.map((column) => column.name).join(',')}) -> ${tableName(reference.foreignTable)}(${reference.foreignColumns.map((column) => column.name).join(',')}) [${foreignKey.onDelete}]`;
    })
  ).sort();

describe('financial allocation schema declarations', () => {
  it('declares the exact allocation table, view, and enum vocabulary', () => {
    expect(TABLES.map((table) => configFor(table).name)).toEqual([
      'financial_allocation_sets',
      'financial_item_allocations',
      'financial_reconciliation_issues',
      'refund_allocation_components',
      'dispute_item_allocations',
      'refund_allocation_drafts',
      'refund_allocation_draft_items',
      'refund_reporting_correction_sets',
      'refund_reporting_correction_items',
      'refund_allocation_finalization_effects'
    ]);
    expect(getViewConfig(currentFinancialProjectionHeads).name).toBe(
      'current_financial_projection_heads'
    );
    expect(getViewConfig(currentFinancialProjectionItems).name).toBe(
      'current_financial_projection_items'
    );
    expect(allocationBasisEnum.enumValues).toEqual(['gross_amount', 'fee']);
    expect(allocationScopeEnum.enumValues).toEqual(['title', 'account', 'unresolved']);
    expect(financialAllocationSourceKindEnum.enumValues).toEqual([
      'payment',
      'refund',
      'dispute',
      'payout',
      'adjustment'
    ]);
    expect(financialComponentEnum.enumValues).toEqual([
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
    ]);
    expect(financialIssueStateEnum.enumValues).toEqual(['open', 'resolved']);
    expect(financialIssueImpactEnum.enumValues).toEqual([
      'pending',
      'exception',
      'informational'
    ]);
    expect(refundAllocationDraftStateEnum.enumValues).toEqual([
      'active',
      'finalized',
      'discarded'
    ]);
    expect(disputeAllocationEffectEnum.enumValues).toEqual(['withdrawal', 'reinstatement']);
    expect(refundCorrectionKindEnum.enumValues).toEqual([
      'allocation_attribution_correction',
      'classifier_rebase'
    ]);
    expect(refundCorrectionDomainEnum.enumValues).toEqual(['presentment', 'settlement']);
    expect(financialFinalizationTransitionEnum.enumValues).toEqual([
      'unchanged',
      'revoked_by_finalization'
    ]);
  });

  it('declares immutable chain, issue, draft, correction, and provenance identities', () => {
    expect(indexNames(financialAllocationSets)).toEqual(
      expect.arrayContaining([
        'financial_allocation_sets_identity_unique',
        'financial_allocation_sets_reversal_root_unique',
        'financial_allocation_sets_successor_unique',
        'financial_allocation_sets_transaction_basis_idx'
      ])
    );
    expect(uniqueNames(financialAllocationSets)).toContain(
      'financial_allocation_sets_source_identity_unique'
    );
    expect(indexNames(financialItemAllocations)).toContain(
      'financial_item_allocations_set_item_component_unique'
    );
    expect(indexNames(financialReconciliationIssues)).toEqual(
      expect.arrayContaining([
        'financial_reconciliation_issues_open_unique',
        'financial_reconciliation_issues_state_observed_idx'
      ])
    );
    expect(indexNames(refundAllocationComponents)).toContain(
      'refund_allocation_components_allocation_unique'
    );
    expect(indexNames(refundAllocationDrafts)).toContain('refund_allocation_drafts_active_unique');
    expect(uniqueNames(refundAllocationDrafts)).toContain(
      'refund_allocation_drafts_refund_version_unique'
    );
    expect(uniqueNames(refundAllocationDraftItems)).toContain(
      'refund_allocation_draft_items_draft_item_unique'
    );
    expect(indexNames(refundReportingCorrectionSets)).toEqual(
      expect.arrayContaining([
        'refund_reporting_correction_sets_identity_unique',
        'refund_reporting_correction_sets_successor_unique'
      ])
    );
    expect(indexNames(refundReportingCorrectionItems)).toContain(
      'refund_reporting_correction_items_set_item_component_unique'
    );
    expect(indexNames(refundAllocationFinalizationEffects)).toContain(
      'refund_allocation_finalization_effects_causal_unique'
    );
  });

  it('declares conservation-adjacent, money, digest, and lifecycle checks', () => {
    expect(checkNames(financialAllocationSets)).toEqual(
      expect.arrayContaining([
        'financial_allocation_sets_currency_iso',
        'financial_allocation_sets_versions_positive',
        'financial_allocation_sets_fingerprint_sha256',
        'financial_allocation_sets_chain_consistent'
      ])
    );
    expect(checkNames(financialItemAllocations)).toEqual(
      expect.arrayContaining([
        'financial_item_allocations_currency_iso',
        'financial_item_allocations_tie_key_safe'
      ])
    );
    expect(checkNames(financialReconciliationIssues)).toEqual(
      expect.arrayContaining([
        'financial_reconciliation_issues_occurrence_positive',
        'financial_reconciliation_issues_resolution_consistent',
        'financial_reconciliation_issues_safe_vocabulary'
      ])
    );
    expect(checkNames(refundAllocationComponents)).toContain(
      'refund_allocation_components_total_consistent'
    );
    expect(checkNames(disputeItemAllocations)).toContain(
      'dispute_item_allocations_total_consistent'
    );
    expect(getTableConfig(disputeItemAllocations).columns.map((column) => column.name)).toContain(
      'gross_allocation_set_id'
    );
    expect(checkNames(refundAllocationDrafts)).toEqual(
      expect.arrayContaining([
        'refund_allocation_drafts_version_positive',
        'refund_allocation_drafts_lifecycle_consistent'
      ])
    );
    expect(checkNames(refundReportingCorrectionSets)).toContain(
      'refund_reporting_correction_sets_fingerprint_sha256'
    );
    expect(checkNames(refundAllocationFinalizationEffects)).toEqual(
      expect.arrayContaining([
        'refund_allocation_finalization_effects_draft_version_positive',
        'refund_allocation_finalization_effects_transition_consistent'
      ])
    );
  });

  it('selects only the exact current classification/allocation versions and counts fee subjects once', () => {
    const query = renderedSql(getViewConfig(currentFinancialProjectionHeads).query);

    expect(query).toContain('from "financial_projection_versions"');
    expect(query).toMatch(
      /where s\.classifier_version = active_projection_version\.classifier_version/u
    );
    expect(query).toMatch(
      /s\.algorithm_version = active_projection_version\.allocation_algorithm_version/u
    );
    expect(query).not.toMatch(/s\.(?:classifier|algorithm)_version = 1/u);
    expect(query).toContain('current_fee_detail_classification_candidates');
    expect(query).toMatch(
      /group by detail\.balance_transaction_id, detail\.id, detail\.amount_minor, detail\.currency/u
    );
    expect(query).toMatch(
      /when parent_decision_count = 0[\s\S]+?parent_unknown_count > 0[\s\S]+?base_count = 0/u
    );
    expect(query).not.toContain('open_correction_rebase_issues');
    expect(query).not.toContain('correction_rebase_issue_count');
    const classificationForkIssues = query.slice(
      query.indexOf('open_classification_fork_issues'),
      query.indexOf('open_allocation_set_issues')
    );
    expect(classificationForkIssues).toContain("issue.resource_type = 'balance_transaction'");
    expect(classificationForkIssues).not.toContain("issue.resource_type = 'fee_detail'");
    expect(query).toMatch(
      /when classification_fork_issue_count > 0 then 'classification_fork'/u
    );
    expect(query).toMatch(
      /when selected_set_issue_count > 0 then selected_set_issue_code[\s\S]+?when classification_fork_issue_count > 0 then 'classification_fork'/u
    );
    expect(query).toMatch(
      /open_allocation_set_issues[\s\S]+?issue\.resource_type = 'allocation_set'[\s\S]+?issue\.state = 'open'[\s\S]+?issue\.impact <> 'informational'/u
    );
    expect(query).toMatch(
      /array_agg\(issue\.safe_code order by[\s\S]+?issue\.impact = 'exception' then 0 else 1 end[\s\S]+?issue\.safe_code collate "C", issue\.id/u
    );
    expect(query).toMatch(
      /selected_set_issue\.allocation_set_id = base\.base_set_id/u
    );
    expect(query).toMatch(
      /selected_set_issue_count = 0[\s\S]+?as is_complete/u
    );
    expect(query).toMatch(
      /when selected_set_issue_count > 0 then selected_set_issue_code/u
    );
    expect(query).toMatch(
      /active_classification_job_markers[\s\S]+?classification_job\.deduplication_key\s*=\s*'financial:classification:'[\s\S]+?classification_job\.status <> 'succeeded'/u
    );
    expect(query).toMatch(
      /selected_set_issue_count = 0 and active_job_marker_count = 0[\s\S]+?as is_complete/u
    );
    expect(query).toMatch(
      /when selected_set_issue_count > 0 then selected_set_issue_code[\s\S]+?when active_job_marker_count > 0 then 'missing_source'/u
    );
  });

  it('keeps every allocation-history foreign key restrictive', () => {
    expect(foreignKeySignatures()).toEqual([
      'dispute_item_allocations(dispute_id) -> disputes(id) [restrict]',
      'dispute_item_allocations(gross_allocation_set_id,dispute_id) -> financial_allocation_sets(id,source_internal_id) [restrict]',
      'dispute_item_allocations(order_item_id) -> order_items(id) [restrict]',
      'dispute_item_allocations(reverses_allocation_id) -> dispute_item_allocations(id) [restrict]',
      'financial_allocation_sets(balance_transaction_id) -> stripe_balance_transactions(id) [restrict]',
      'financial_allocation_sets(reversal_of_set_id) -> financial_allocation_sets(id) [restrict]',
      'financial_allocation_sets(reversal_of_set_id,source_kind,source_internal_id,basis,currency) -> financial_allocation_sets(id,source_kind,source_internal_id,basis,currency) [restrict]',
      'financial_allocation_sets(supersedes_set_id) -> financial_allocation_sets(id) [restrict]',
      'financial_allocation_sets(supersedes_set_id,balance_transaction_id,basis,currency,expected_effect_minor,source_fingerprint_sha256) -> financial_allocation_sets(id,balance_transaction_id,basis,currency,expected_effect_minor,source_fingerprint_sha256) [restrict]',
      'financial_item_allocations(allocation_set_id) -> financial_allocation_sets(id) [restrict]',
      'financial_item_allocations(order_item_id) -> order_items(id) [restrict]',
      'financial_reconciliation_issues(resolved_by_admin_id) -> user(id) [restrict]',
      'refund_allocation_components(refund_allocation_id,refund_id,order_item_id) -> refund_allocations(id,refund_id,order_item_id) [restrict]',
      'refund_allocation_draft_items(draft_id) -> refund_allocation_drafts(id) [restrict]',
      'refund_allocation_draft_items(order_item_id) -> order_items(id) [restrict]',
      'refund_allocation_drafts(created_by_admin_id) -> user(id) [restrict]',
      'refund_allocation_drafts(refund_id) -> refunds(id) [restrict]',
      'refund_allocation_drafts(updated_by_admin_id) -> user(id) [restrict]',
      'refund_allocation_finalization_effects(draft_id,order_item_id) -> refund_allocation_draft_items(draft_id,order_item_id) [restrict]',
      'refund_allocation_finalization_effects(draft_id,refund_id,draft_version) -> refund_allocation_drafts(id,refund_id,version) [restrict]',
      'refund_allocation_finalization_effects(purchase_grant_id,order_item_id) -> entitlement_grants(id,order_item_id) [restrict]',
      'refund_allocation_finalization_effects(refund_allocation_id,refund_id,order_item_id) -> refund_allocations(id,refund_id,order_item_id) [restrict]',
      'refund_reporting_correction_items(correction_set_id) -> refund_reporting_correction_sets(id) [restrict]',
      'refund_reporting_correction_items(order_item_id) -> order_items(id) [restrict]',
      'refund_reporting_correction_items(source_allocation_set_id) -> financial_allocation_sets(id) [restrict]',
      'refund_reporting_correction_sets(approved_by_admin_id) -> user(id) [restrict]',
      'refund_reporting_correction_sets(base_allocation_set_id) -> financial_allocation_sets(id) [restrict]',
      'refund_reporting_correction_sets(created_by_admin_id) -> user(id) [restrict]',
      'refund_reporting_correction_sets(predecessor_correction_set_id,refund_id) -> refund_reporting_correction_sets(id,refund_id) [restrict]',
      'refund_reporting_correction_sets(refund_id) -> refunds(id) [restrict]'
    ]);
  });

  it('stores only bounded internal financial and administrator attribution fields', () => {
    const columnNames = TABLES.flatMap((table) =>
      configFor(table).columns.map((column) => column.name)
    );
    expect(
      columnNames.some((name) =>
        /(^|_)(customer|purchase_email|billing|card)($|_)/u.test(name)
      )
    ).toBe(false);
    expect(columnNames.some((name) => /(raw_payload|provider_payload|message|description)/u.test(name))).toBe(false);
    expect(columnNames.some((name) => /(secret|receipt_url|action_url)/u.test(name))).toBe(false);
  });
});
