import { sql, type SQL } from 'drizzle-orm';
import {
  financialAllocationSets,
  financialClassificationVersions,
  financialProjectionVersions,
  financialReconciliationIssues,
  stripeBalanceTransactionFeeDetails,
  stripeBalanceTransactions
} from '$lib/server/db/schema';

export function currentOperationalFinancialIssuePredicate(): SQL {
  return sql`
    ${financialReconciliationIssues.state} = 'open'
    and (
      ${financialReconciliationIssues.resourceType} not in (
        'financial_classification', 'allocation_set'
      )
      or (
        ${financialReconciliationIssues.resourceType} = 'financial_classification'
        and exists (
          select 1
          from ${financialProjectionVersions} active
          where active.singleton = true
            and exists (
              select 1
              from ${financialClassificationVersions} classification
              where classification.id = ${financialReconciliationIssues.resourceId}
                and classification.classifier_version = active.classifier_version
                and (
                  (
                    classification.subject_type = 'balance_transaction'
                    and exists (
                      select 1
                      from ${stripeBalanceTransactions} balance
                      where balance.id = classification.subject_id
                        and balance.fingerprint_sha256 =
                          classification.source_fingerprint_sha256
                    )
                  )
                  or (
                    classification.subject_type = 'fee_detail'
                    and exists (
                      select 1
                      from ${stripeBalanceTransactionFeeDetails} detail
                      where detail.id = classification.subject_id
                        and detail.fingerprint_sha256 =
                          classification.source_fingerprint_sha256
                    )
                  )
                )
            )
        )
      )
      or (
        ${financialReconciliationIssues.resourceType} = 'allocation_set'
        and exists (
          select 1
          from ${financialProjectionVersions} active
          where active.singleton = true
            and exists (
              select 1
              from ${financialAllocationSets} allocation
              where allocation.id = ${financialReconciliationIssues.resourceId}
                and allocation.classifier_version = active.classifier_version
                and allocation.algorithm_version = active.allocation_algorithm_version
                and not exists (
                  select 1
                  from ${financialAllocationSets} successor
                  where successor.supersedes_set_id = allocation.id
                    and successor.classifier_version = allocation.classifier_version
                    and successor.algorithm_version = allocation.algorithm_version
                )
            )
        )
      )
    )
  `;
}
