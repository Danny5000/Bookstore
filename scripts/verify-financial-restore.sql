\set ON_ERROR_STOP on
\set QUIET on

create temporary table restore_financial_checks (
  check_name text primary key,
  violation_count bigint not null
);

begin;
set transaction read only;
set local search_path = pg_catalog, public, drizzle;

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_missing_or_mismatched', count(*)::bigint
from account credential
left join credential_authority authority on authority.user_id = credential.user_id
where credential.provider_id = 'credential'
  and (
    credential.password is null
    or authority.user_id is null
    or authority.authorized_password_hash is null
    or authority.authorized_password_hash is distinct from credential.password
  );

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_duplicate_account', count(*)::bigint
from (
  select user_id
  from account
  where provider_id = 'credential'
  group by user_id
  having count(*) <> 1
) duplicate_credentials;

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_orphan_hash', count(*)::bigint
from credential_authority authority
where authority.authorized_password_hash is not null
  and (
    select count(*)
    from account credential
    where credential.user_id = authority.user_id
      and credential.provider_id = 'credential'
      and credential.password = authority.authorized_password_hash
  ) <> 1;

insert into restore_financial_checks (check_name, violation_count)
select 'credential_authority_invalid_pending_reset', count(*)::bigint
from credential_authority authority
where authority.authorized_password_hash is null
  and (
    authority.reset_epoch_sha256 is null
    or authority.reset_epoch_sha256 !~ '^[0-9a-f]{64}$'
  );

insert into restore_financial_checks (check_name, violation_count)
select 'financial_projection_singleton',
  (abs(count(*) filter (where singleton is true) - 1)
    + count(*) filter (where singleton is distinct from true))::bigint
from financial_projection_versions;

insert into restore_financial_checks (check_name, violation_count)
select 'financial_payout_discovery_singleton',
  (abs(count(*) filter (where singleton is true) - 1)
    + count(*) filter (where singleton is distinct from true))::bigint
from financial_payout_discovery_state;

insert into restore_financial_checks (check_name, violation_count)
with active as (
  select classifier_version, allocation_algorithm_version
  from financial_projection_versions
  where singleton = true
), active_sets as (
  select s.*
  from financial_allocation_sets s
  cross join active a
  where s.classifier_version = a.classifier_version
    and s.algorithm_version = a.allocation_algorithm_version
), tips as (
  select s.balance_transaction_id, s.basis, count(*)::bigint as tip_count
  from active_sets s
  where not exists (
    select 1
    from active_sets successor
    where successor.supersedes_set_id = s.id
  )
  group by s.balance_transaction_id, s.basis
)
select 'financial_projection_tip_ambiguity', count(*)::bigint
from tips
where tip_count > 1;

insert into restore_financial_checks (check_name, violation_count)
select 'financial_classification_decision_ambiguity', count(*)::bigint
from (
  select subject_type, subject_id, classifier_version, source_fingerprint_sha256
  from financial_classification_versions
  group by subject_type, subject_id, classifier_version, source_fingerprint_sha256
  having count(*) > 1
) ambiguous_decisions;

insert into restore_financial_checks (check_name, violation_count)
with orphan_counts as (
  select 'fee_detail_balance_transaction' as check_name, count(*)::bigint as violation_count
  from stripe_balance_transaction_fee_details d
  left join stripe_balance_transactions bt on bt.id = d.balance_transaction_id
  where bt.id is null

  union all
  select 'classification_subject', count(*)::bigint
  from financial_classification_versions c
  left join stripe_balance_transactions bt
    on c.subject_type = 'balance_transaction' and bt.id = c.subject_id
  left join stripe_balance_transaction_fee_details fd
    on c.subject_type = 'fee_detail' and fd.id = c.subject_id
  left join stripe_balance_transactions fee_parent_bt
    on fee_parent_bt.id = fd.balance_transaction_id
  left join financial_classification_versions fee_parent_classification
    on fee_parent_classification.subject_type = 'balance_transaction'
   and fee_parent_classification.subject_id = fd.balance_transaction_id
   and fee_parent_classification.classifier_version = c.classifier_version
   and fee_parent_classification.source_fingerprint_sha256 =
     fee_parent_bt.fingerprint_sha256
  where (c.subject_type = 'balance_transaction' and (
       bt.id is null
       or c.source_fingerprint_sha256 is distinct from bt.fingerprint_sha256
     ))
     or (c.subject_type = 'fee_detail' and (
       fd.id is null
       or c.source_fingerprint_sha256 is distinct from fd.fingerprint_sha256
       or fee_parent_classification.id is null
     ))

  union all
  select 'payout_linked_balance_transaction', count(*)::bigint
  from stripe_payouts p
  left join stripe_balance_transactions bt on bt.id = p.balance_transaction_id
  left join stripe_balance_transactions failure_bt on failure_bt.id = p.failure_balance_transaction_id
  where (p.balance_transaction_id is not null and bt.id is null)
     or (p.failure_balance_transaction_id is not null and failure_bt.id is null)

  union all
  select 'payout_import_run_payout', count(*)::bigint
  from payout_import_runs r
  left join stripe_payouts p on p.id = r.payout_id
  where p.id is null

  union all
  select 'payout_import_entry_parent', count(*)::bigint
  from payout_import_run_entries e
  left join payout_import_runs r on r.id = e.run_id
  left join stripe_balance_transactions bt on bt.id = e.balance_transaction_id
  where r.id is null or bt.id is null

  union all
  select 'published_payout_membership_parent', count(*)::bigint
  from stripe_payout_balance_transactions m
  left join stripe_payouts p on p.id = m.payout_id
  left join stripe_balance_transactions bt on bt.id = m.balance_transaction_id
  left join payout_import_runs r
    on r.id = m.published_from_run_id and r.payout_id = m.payout_id
  where p.id is null or bt.id is null or r.id is null

  union all
  select 'allocation_set_parent_or_chain', count(*)::bigint
  from financial_allocation_sets s
  left join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  left join financial_allocation_sets predecessor on predecessor.id = s.supersedes_set_id
  left join financial_allocation_sets reversal on reversal.id = s.reversal_of_set_id
  left join financial_classification_versions parent_classification
    on parent_classification.subject_type = 'balance_transaction'
    and parent_classification.subject_id = s.balance_transaction_id
    and parent_classification.classifier_version = s.classifier_version
    and parent_classification.source_fingerprint_sha256 = s.source_fingerprint_sha256
  where bt.id is null
     or parent_classification.id is null
     or parent_classification.classification = 'unknown'
     or (s.supersedes_set_id is not null and predecessor.id is null)
     or (s.reversal_of_set_id is not null and reversal.id is null)
     or (s.reversal_of_set_id is not null and (
       reversal.source_kind <> s.source_kind
       or reversal.source_internal_id <> s.source_internal_id
       or reversal.basis <> s.basis
       or reversal.currency <> s.currency
       or reversal.reversal_of_set_id is not null
       or reversal.classifier_version <> s.classifier_version
       or reversal.algorithm_version <> s.algorithm_version
     ))
     or (s.supersedes_set_id is not null and (
       predecessor.balance_transaction_id <> s.balance_transaction_id
       or predecessor.basis <> s.basis
       or predecessor.currency <> s.currency
       or predecessor.expected_effect_minor <> s.expected_effect_minor
       or predecessor.source_fingerprint_sha256 <> s.source_fingerprint_sha256
       or predecessor.classifier_version > s.classifier_version
       or predecessor.algorithm_version > s.algorithm_version
       or not coalesce((
         (
           predecessor.source_kind = s.source_kind
           and predecessor.source_internal_id = s.source_internal_id
           and (
             predecessor.reversal_of_set_id is not distinct from s.reversal_of_set_id
             or (
               predecessor.reversal_of_set_id is not null
               and s.reversal_of_set_id is not null
               and reversal.supersedes_set_id = predecessor.reversal_of_set_id
             )
           )
         )
         or (
           predecessor.source_kind = 'adjustment'
           and predecessor.source_internal_id = s.balance_transaction_id
           and predecessor.scope = 'account'
           and predecessor.reversal_of_set_id is null
           and s.source_kind in ('payment', 'refund', 'dispute')
           and parent_classification.id is not null
           and (
             (s.reversal_of_set_id is null and (
               (s.source_kind = 'payment'
                 and parent_classification.classification = 'charge'
                 and bt.amount_minor > 0)
               or (s.source_kind = 'refund' and (
                 (parent_classification.classification = 'refund' and bt.amount_minor < 0)
                 or (parent_classification.classification = 'refund_failure'
                   and bt.amount_minor > 0)
               ))
               or (s.source_kind = 'dispute' and (
                 (parent_classification.classification = 'dispute_withdrawal'
                   and bt.amount_minor < 0)
                 or (parent_classification.classification in (
                   'dispute_reinstatement', 'fee_credit'
                 ) and bt.amount_minor > 0)
               ))
             ))
             or (s.reversal_of_set_id is not null
               and s.basis = 'gross_amount'
               and s.expected_effect_minor > 0
               and bt.amount_minor > 0
               and (
                 (s.source_kind = 'refund'
                   and parent_classification.classification = 'refund_failure')
                 or (s.source_kind = 'dispute'
                   and parent_classification.classification = 'dispute_reinstatement')
               ))
           )
         )
       ), false)
      ))

  union all
  select 'allocation_set_detail_classification', count(*)::bigint
  from financial_allocation_sets s
  where exists (
    select 1
    from stripe_balance_transaction_fee_details allocation_detail
    left join financial_classification_versions allocation_detail_classification
      on allocation_detail_classification.subject_type = 'fee_detail'
     and allocation_detail_classification.subject_id = allocation_detail.id
     and allocation_detail_classification.classifier_version = s.classifier_version
     and allocation_detail_classification.source_fingerprint_sha256 =
       allocation_detail.fingerprint_sha256
    where allocation_detail.balance_transaction_id = s.balance_transaction_id
      and (
        allocation_detail_classification.id is null
        or allocation_detail_classification.classification = 'unknown'
      )
  )

  union all
  select 'allocation_set_semantic_source', count(*)::bigint
  from financial_allocation_sets s
  left join stripe_balance_transactions source_bt on source_bt.id = s.balance_transaction_id
  left join payments payment_source
    on s.source_kind = 'payment' and payment_source.id = s.source_internal_id
  left join refunds refund_source
    on s.source_kind = 'refund' and refund_source.id = s.source_internal_id
  left join disputes dispute_source
    on s.source_kind = 'dispute' and dispute_source.id = s.source_internal_id
  left join financial_classification_versions source_classification
    on source_classification.subject_type = 'balance_transaction'
   and source_classification.subject_id = s.balance_transaction_id
   and source_classification.classifier_version = s.classifier_version
   and source_classification.source_fingerprint_sha256 =
     s.source_fingerprint_sha256
  left join stripe_payouts payout_source
    on s.source_kind = 'payout' and payout_source.id = s.source_internal_id
  left join stripe_balance_transactions adjustment_source
    on s.source_kind = 'adjustment' and adjustment_source.id = s.source_internal_id
  where source_bt.id is null
     or s.source_fingerprint_sha256 is distinct from source_bt.fingerprint_sha256
     or (s.source_kind = 'payment' and (
       payment_source.id is null
       or payment_source.stripe_latest_charge_id is null
       or source_bt.source_family is distinct from 'charge'
       or source_bt.source_id is distinct from payment_source.stripe_latest_charge_id
       or source_classification.classification is distinct from 'charge'
       or not coalesce((
         (payment_source.currency = source_bt.currency
           and source_bt.exchange_rate is null
           and source_bt.exchange_source_currency is null
           and source_bt.exchange_target_currency is null)
         or (payment_source.currency <> source_bt.currency
           and source_bt.exchange_rate is not null
           and source_bt.exchange_source_currency = payment_source.currency
           and source_bt.exchange_target_currency = source_bt.currency)
       ), false)
     ))
     or (s.source_kind = 'refund' and (
       refund_source.id is null
       or source_bt.source_family is distinct from 'refund'
       or source_bt.source_id is distinct from refund_source.stripe_refund_id
       or source_classification.classification not in ('refund', 'refund_failure')
       or not coalesce((
         (refund_source.currency = source_bt.currency
           and source_bt.exchange_rate is null
           and source_bt.exchange_source_currency is null
           and source_bt.exchange_target_currency is null)
         or (refund_source.currency <> source_bt.currency
           and source_bt.exchange_rate is not null
           and source_bt.exchange_source_currency = refund_source.currency
           and source_bt.exchange_target_currency = source_bt.currency)
       ), false)
     ))
     or (s.source_kind = 'dispute' and (
       dispute_source.id is null
       or source_bt.source_family is distinct from 'dispute'
       or source_bt.source_id is distinct from dispute_source.stripe_dispute_id
       or not coalesce((
         (source_classification.classification in (
           'dispute_withdrawal', 'dispute_reinstatement'
         ) and (
           (dispute_source.currency = source_bt.currency
             and source_bt.exchange_rate is null
             and source_bt.exchange_source_currency is null
             and source_bt.exchange_target_currency is null)
           or (dispute_source.currency <> source_bt.currency
             and source_bt.exchange_rate is not null
             and source_bt.exchange_source_currency = dispute_source.currency
             and source_bt.exchange_target_currency = source_bt.currency)
          ))
          or (source_classification.classification = 'fee_credit'
            and source_bt.reporting_category = 'fee'
            and source_bt.raw_type in ('stripe_fee', 'stripe_fx_fee')
            and source_bt.amount_minor > 0
            and (
              (source_bt.exchange_rate is null
                and source_bt.exchange_source_currency is null
                and source_bt.exchange_target_currency is null)
              or (dispute_source.currency <> source_bt.currency
                and source_bt.exchange_rate is not null
                and source_bt.exchange_source_currency = dispute_source.currency
                and source_bt.exchange_target_currency = source_bt.currency)
          ))
       ), false)
     ))
     or (s.source_kind = 'payout' and (
       payout_source.id is null
       or source_bt.source_family is distinct from 'payout'
       or source_bt.source_id is distinct from payout_source.provider_id
       or s.scope <> 'account'
     ))
     or (s.source_kind = 'adjustment' and (
       adjustment_source.id is null
       or s.source_internal_id <> s.balance_transaction_id
       or s.scope <> 'account'
     ))

  union all
  select 'financial_item_allocation_parent', count(*)::bigint
  from financial_item_allocations i
  left join financial_allocation_sets s on s.id = i.allocation_set_id
  left join order_items oi on oi.id = i.order_item_id
  left join payments payment_source
    on s.source_kind = 'payment' and payment_source.id = s.source_internal_id
  left join refunds refund_source
    on s.source_kind = 'refund' and refund_source.id = s.source_internal_id
  left join payments refund_payment on refund_payment.id = refund_source.payment_id
  left join disputes dispute_source
    on s.source_kind = 'dispute' and dispute_source.id = s.source_internal_id
  left join payments dispute_payment on dispute_payment.id = dispute_source.payment_id
  where s.id is null or oi.id is null
     or s.scope <> 'title'
     or i.currency <> s.currency
     or (s.source_kind = 'payment' and (
       payment_source.id is null or oi.order_id <> payment_source.order_id
     ))
     or (s.source_kind = 'refund' and (
       refund_source.id is null or refund_payment.id is null
       or oi.order_id <> refund_payment.order_id
     ))
     or (s.source_kind = 'dispute' and (
       dispute_source.id is null or dispute_payment.id is null
       or oi.order_id <> dispute_payment.order_id
     ))
     or s.source_kind in ('payout', 'adjustment')

  union all
  select 'financial_item_allocation_semantic_component', count(*)::bigint
  from financial_item_allocations i
  join financial_allocation_sets s on s.id = i.allocation_set_id
  left join financial_classification_versions component_parent_classification
    on component_parent_classification.subject_type = 'balance_transaction'
   and component_parent_classification.subject_id = s.balance_transaction_id
   and component_parent_classification.classifier_version = s.classifier_version
   and component_parent_classification.source_fingerprint_sha256 =
     s.source_fingerprint_sha256
  where not coalesce((
    s.scope = 'title' and (
      (s.basis = 'gross_amount' and (
        (s.source_kind = 'payment'
          and component_parent_classification.classification = 'charge'
          and s.reversal_of_set_id is null
          and i.component in ('sale_subtotal', 'sale_tax'))
        or (s.source_kind = 'refund'
          and i.component in ('refund_subtotal', 'refund_tax')
          and (
            (component_parent_classification.classification = 'refund'
              and s.reversal_of_set_id is null)
            or (component_parent_classification.classification = 'refund_failure'
              and s.reversal_of_set_id is not null)
          ))
        or (s.source_kind = 'dispute' and (
          (component_parent_classification.classification = 'dispute_withdrawal'
            and s.reversal_of_set_id is null
            and i.component in ('dispute_subtotal', 'dispute_tax'))
          or (component_parent_classification.classification = 'dispute_reinstatement'
            and s.reversal_of_set_id is not null
            and i.component = 'dispute_reinstatement')
          or (component_parent_classification.classification = 'fee_credit'
            and s.reversal_of_set_id is null
            and i.component = 'fee_credit')
        ))
      ))
      or (s.basis = 'fee'
        and s.reversal_of_set_id is null
        and (
          (s.source_kind = 'payment'
            and component_parent_classification.classification = 'charge'
            and i.component in (
              'processing_fee', 'provider_fee_tax', 'fee_credit', 'other'
            ))
          or (s.source_kind = 'refund'
            and component_parent_classification.classification in ('refund', 'refund_failure')
            and i.component in (
              'refund_fee', 'provider_fee_tax', 'fee_credit', 'other'
            ))
          or (s.source_kind = 'dispute'
            and component_parent_classification.classification = 'dispute_withdrawal'
            and i.component in (
              'dispute_fee', 'provider_fee_tax', 'fee_credit', 'other'
            ))
        )
        and exists (
          select 1
          from stripe_balance_transaction_fee_details component_detail
          join financial_classification_versions component_detail_classification
            on component_detail_classification.subject_type = 'fee_detail'
           and component_detail_classification.subject_id = component_detail.id
           and component_detail_classification.classifier_version = s.classifier_version
           and component_detail_classification.source_fingerprint_sha256 =
             component_detail.fingerprint_sha256
           and component_detail_classification.classification::text = i.component::text
          where component_detail.balance_transaction_id = s.balance_transaction_id
        ))
    )
  ), false)

  union all
  select 'financial_fee_detail_semantic_classification', count(*)::bigint
  from financial_allocation_sets fee_set
  join stripe_balance_transaction_fee_details fee_detail
    on fee_detail.balance_transaction_id = fee_set.balance_transaction_id
  left join financial_classification_versions fee_parent_classification
    on fee_parent_classification.subject_type = 'balance_transaction'
   and fee_parent_classification.subject_id = fee_set.balance_transaction_id
   and fee_parent_classification.classifier_version = fee_set.classifier_version
   and fee_parent_classification.source_fingerprint_sha256 =
     fee_set.source_fingerprint_sha256
  left join financial_classification_versions fee_detail_classification
    on fee_detail_classification.subject_type = 'fee_detail'
   and fee_detail_classification.subject_id = fee_detail.id
   and fee_detail_classification.classifier_version = fee_set.classifier_version
   and fee_detail_classification.source_fingerprint_sha256 = fee_detail.fingerprint_sha256
  where fee_set.basis = 'fee'
    and fee_set.reversal_of_set_id is null
    and (
      (fee_set.scope = 'title'
        and fee_set.source_kind in ('payment', 'refund', 'dispute'))
      or (fee_set.scope = 'unresolved'
        and fee_set.source_kind = 'refund')
    )
    and not coalesce((
      (fee_set.source_kind = 'payment'
        and fee_parent_classification.classification = 'charge'
        and fee_detail_classification.classification in (
          'processing_fee', 'provider_fee_tax', 'fee_credit', 'other'
        ))
      or (fee_set.source_kind = 'refund'
        and (
          (fee_set.scope = 'title'
            and fee_parent_classification.classification in ('refund', 'refund_failure'))
          or (fee_set.scope = 'unresolved'
            and fee_parent_classification.classification = 'refund')
        )
        and fee_detail_classification.classification in (
          'refund_fee', 'provider_fee_tax', 'fee_credit', 'other'
        ))
      or (fee_set.source_kind = 'dispute'
        and fee_parent_classification.classification in (
          'dispute_withdrawal', 'dispute_reinstatement'
        )
        and fee_detail_classification.classification in (
          'dispute_fee', 'provider_fee_tax', 'fee_credit', 'other'
        ))
    ), false)

  union all
  select 'financial_fee_component_conservation', count(*)::bigint
  from (
    with eligible_fee_sets as (
      select s.id, s.balance_transaction_id, s.classifier_version
      from financial_allocation_sets s
      join financial_classification_versions parent_classification
        on parent_classification.subject_type = 'balance_transaction'
       and parent_classification.subject_id = s.balance_transaction_id
       and parent_classification.classifier_version = s.classifier_version
       and parent_classification.source_fingerprint_sha256 = s.source_fingerprint_sha256
      where s.basis = 'fee'
        and s.scope = 'title'
        and s.reversal_of_set_id is null
        and (
          (s.source_kind = 'payment' and parent_classification.classification = 'charge')
          or (s.source_kind = 'refund'
            and parent_classification.classification in ('refund', 'refund_failure'))
          or (s.source_kind = 'dispute'
            and parent_classification.classification = 'dispute_withdrawal')
        )
    ), expected_components as (
      select eligible.id as allocation_set_id,
        detail_classification.classification::text as component,
        -sum(detail.amount_minor)::bigint as expected_component_minor
      from eligible_fee_sets eligible
      join stripe_balance_transaction_fee_details detail
        on detail.balance_transaction_id = eligible.balance_transaction_id
      join financial_classification_versions detail_classification
        on detail_classification.subject_type = 'fee_detail'
       and detail_classification.subject_id = detail.id
       and detail_classification.classifier_version = eligible.classifier_version
       and detail_classification.source_fingerprint_sha256 = detail.fingerprint_sha256
      where detail_classification.classification in (
        'processing_fee', 'refund_fee', 'dispute_fee',
        'provider_fee_tax', 'fee_credit', 'other'
      )
      group by eligible.id, detail_classification.classification
    ), actual_components as (
      select eligible.id as allocation_set_id, item.component::text as component,
        sum(item.effect_minor)::bigint as actual_component_minor
      from eligible_fee_sets eligible
      join financial_item_allocations item on item.allocation_set_id = eligible.id
      group by eligible.id, item.component
    ), component_keys as (
      select allocation_set_id, component from expected_components
      union
      select allocation_set_id, component from actual_components
    )
    select key.allocation_set_id, key.component
    from component_keys key
    left join expected_components expected
      on expected.allocation_set_id = key.allocation_set_id
     and expected.component = key.component
    left join actual_components actual
      on actual.allocation_set_id = key.allocation_set_id
     and actual.component = key.component
    where coalesce(actual.actual_component_minor, 0) is distinct from
      coalesce(expected.expected_component_minor, 0)
  ) mismatched_fee_component

  union all
  select 'financial_issue_vocabulary', count(*)::bigint
  from financial_reconciliation_issues i
  where i.resource_type not in (
    'payment', 'refund', 'dispute', 'payout', 'payout_import_run',
    'balance_transaction', 'fee_detail', 'allocation_set', 'correction_set',
    'financial_classification', 'financial_scan_run'
  ) or i.safe_code not in (
    'allocation_fork', 'allocation_incomplete', 'allocation_mismatch',
    'classification_fork', 'correction_rebase_required', 'currency_mismatch',
    'generation_exhausted', 'immutable_mismatch', 'missing_source',
    'payout_incomplete', 'payout_membership_conflict', 'payout_reversal_incomplete',
    'source_linkage_mismatch', 'unsupported_category'
  )

  union all
  select 'financial_issue_semantic_resource', count(*)::bigint
  from financial_reconciliation_issues i
  left join payments p on i.resource_type = 'payment' and p.id = i.resource_id
  left join refunds r on i.resource_type = 'refund' and r.id = i.resource_id
  left join disputes d on i.resource_type = 'dispute' and d.id = i.resource_id
  left join stripe_payouts po on i.resource_type = 'payout' and po.id = i.resource_id
  left join payout_import_runs pr
    on i.resource_type = 'payout_import_run' and pr.id = i.resource_id
  left join stripe_balance_transactions bt
    on i.resource_type = 'balance_transaction' and bt.id = i.resource_id
  left join stripe_balance_transaction_fee_details fd
    on i.resource_type = 'fee_detail' and fd.id = i.resource_id
  left join financial_allocation_sets fas
    on i.resource_type = 'allocation_set' and fas.id = i.resource_id
  left join refund_reporting_correction_sets cs
    on i.resource_type = 'correction_set' and cs.id = i.resource_id
  left join financial_classification_versions fc
    on i.resource_type = 'financial_classification' and fc.id = i.resource_id
  left join financial_scan_runs sr
    on i.resource_type = 'financial_scan_run' and sr.id = i.resource_id
  left join "user" resolver on resolver.id = i.resolved_by_admin_id
  where (i.resource_type = 'payment' and p.id is null)
     or (i.resource_type = 'refund' and r.id is null)
     or (i.resource_type = 'dispute' and d.id is null)
     or (i.resource_type = 'payout' and po.id is null)
     or (i.resource_type = 'payout_import_run' and pr.id is null)
     or (i.resource_type = 'balance_transaction' and bt.id is null)
     or (i.resource_type = 'fee_detail' and fd.id is null)
     or (i.resource_type = 'allocation_set' and fas.id is null)
     or (i.resource_type = 'correction_set' and cs.id is null)
     or (i.resource_type = 'financial_classification' and (
       fc.id is null
       or i.safe_code <> 'unsupported_category'
       or fc.classification <> 'unknown'
       or i.impact <> 'exception'
       or i.state <> 'open'
     ))
     or (i.resource_type in ('balance_transaction', 'fee_detail')
       and i.safe_code = 'unsupported_category')
     or (i.resource_type = 'financial_scan_run' and sr.id is null)
     or (i.resolved_by_admin_id is not null and resolver.id is null)

  union all
  select 'financial_unknown_classification_issue', count(*)::bigint
  from financial_classification_versions classification
  left join financial_reconciliation_issues issue
    on issue.resource_type = 'financial_classification'
   and issue.resource_id = classification.id
   and issue.safe_code = 'unsupported_category'
   and issue.state = 'open'
   and issue.impact = 'exception'
  where classification.classification = 'unknown'
    and issue.id is null

  union all
  select 'refund_allocation_component_graph', count(*)::bigint
  from refund_allocation_components c
  left join refund_allocations ra
    on ra.id = c.refund_allocation_id
   and ra.refund_id = c.refund_id
   and ra.order_item_id = c.order_item_id
  where ra.id is null

  union all
  select 'dispute_item_allocation_graph', count(*)::bigint
  from dispute_item_allocations a
  left join disputes d on d.id = a.dispute_id
  left join payments dispute_payment on dispute_payment.id = d.payment_id
  left join financial_allocation_sets s
    on s.id = a.gross_allocation_set_id and s.source_internal_id = a.dispute_id
  left join order_items oi on oi.id = a.order_item_id
  left join dispute_item_allocations reversal on reversal.id = a.reverses_allocation_id
  left join financial_allocation_sets reversed_set
    on reversed_set.id = s.reversal_of_set_id
  where d.id is null or dispute_payment.id is null or s.id is null or oi.id is null
     or s.source_kind <> 'dispute'
     or s.basis <> 'gross_amount'
     or s.scope <> 'title'
     or oi.order_id is distinct from dispute_payment.order_id
     or a.currency is distinct from d.currency
     or a.currency is distinct from dispute_payment.currency
     or a.currency is distinct from oi.currency
     or (s.currency = a.currency and coalesce((
       select sum(settlement.effect_minor)::bigint
       from financial_item_allocations settlement
       where settlement.allocation_set_id = s.id
         and settlement.order_item_id = a.order_item_id
     ), 0::bigint) <> a.total_effect_minor)
     or (s.currency <> a.currency and a.effect = 'withdrawal' and (
       select coalesce(sum(presentment.total_effect_minor), 0)::bigint
       from dispute_item_allocations presentment
       where presentment.gross_allocation_set_id = s.id
     ) <> -d.amount_minor)
     or (s.currency <> a.currency and a.effect = 'reinstatement' and (
       reversed_set.id is null
       or s.expected_effect_minor is distinct from -reversed_set.expected_effect_minor
       or (
         select coalesce(sum(reinstatement_presentment.total_effect_minor), 0)::bigint
         from dispute_item_allocations reinstatement_presentment
         where reinstatement_presentment.gross_allocation_set_id = s.id
       ) is distinct from -(
         select coalesce(sum(withdrawal_presentment.total_effect_minor), 0)::bigint
         from dispute_item_allocations withdrawal_presentment
         where withdrawal_presentment.gross_allocation_set_id = s.reversal_of_set_id
       )
     ))
     or (a.reverses_allocation_id is not null and (
       reversal.id is null
       or reversal.effect <> 'withdrawal'
       or reversal.reverses_allocation_id is not null
       or reversal.dispute_id <> a.dispute_id
       or reversal.order_item_id <> a.order_item_id
       or reversal.currency <> a.currency
       or a.subtotal_effect_minor > -reversal.subtotal_effect_minor
       or a.tax_effect_minor > -reversal.tax_effect_minor
       or s.reversal_of_set_id is distinct from reversal.gross_allocation_set_id
       or (
         select count(*)
         from dispute_item_allocations candidate_reversal
         where candidate_reversal.reverses_allocation_id = a.reverses_allocation_id
       ) <> 1
     ))

  union all
  select 'dispute_presentment_child_cardinality', count(distinct s.id)::bigint
  from financial_allocation_sets s
  join financial_classification_versions classification
    on classification.subject_type = 'balance_transaction'
   and classification.subject_id = s.balance_transaction_id
   and classification.classifier_version = s.classifier_version
   and classification.source_fingerprint_sha256 = s.source_fingerprint_sha256
  where s.source_kind = 'dispute'
    and s.basis = 'gross_amount'
    and classification.classification in (
      'dispute_withdrawal', 'dispute_reinstatement', 'fee_credit'
    )
    and (
      s.scope <> 'title'
      or (classification.classification in ('dispute_withdrawal', 'fee_credit')
        and s.reversal_of_set_id is not null)
      or (classification.classification = 'dispute_reinstatement'
        and s.reversal_of_set_id is null)
      or (classification.classification in (
          'dispute_withdrawal', 'dispute_reinstatement'
        ) and (
        not exists (
          select 1 from dispute_item_allocations presentment
          where presentment.gross_allocation_set_id = s.id
        )
        or exists (
          select 1 from dispute_item_allocations presentment
          where presentment.gross_allocation_set_id = s.id
            and (
              (classification.classification = 'dispute_withdrawal'
                and (
                  presentment.effect <> 'withdrawal'
                  or presentment.reverses_allocation_id is not null
                  or presentment.subtotal_effect_minor > 0
                  or presentment.tax_effect_minor > 0
                  or presentment.total_effect_minor >= 0
                ))
              or (classification.classification = 'dispute_reinstatement'
                and (
                  presentment.effect <> 'reinstatement'
                  or presentment.reverses_allocation_id is null
                  or presentment.subtotal_effect_minor < 0
                  or presentment.tax_effect_minor < 0
                  or presentment.total_effect_minor <= 0
                ))
            )
        )
        or exists (
          select 1
          from (
            select distinct settlement.order_item_id
            from financial_item_allocations settlement
            where settlement.allocation_set_id = s.id
          ) settlement_item
          where not exists (
            select 1 from dispute_item_allocations presentment
            where presentment.gross_allocation_set_id = s.id
              and presentment.order_item_id = settlement_item.order_item_id
          )
        )
        or exists (
          select 1
          from dispute_item_allocations presentment
          where presentment.gross_allocation_set_id = s.id
            and not exists (
              select 1 from financial_item_allocations settlement
              where settlement.allocation_set_id = s.id
                and settlement.order_item_id = presentment.order_item_id
            )
        )
        ))
      or (classification.classification = 'fee_credit' and exists (
        select 1 from dispute_item_allocations presentment
        where presentment.gross_allocation_set_id = s.id
      ))
    )

  union all
  select 'refund_allocation_draft_graph', count(*)::bigint
  from refund_allocation_drafts d
  left join refunds r on r.id = d.refund_id
  left join "user" creator on creator.id = d.created_by_admin_id
  left join "user" updater on updater.id = d.updated_by_admin_id
  where r.id is null or creator.id is null or updater.id is null

  union all
  select 'refund_allocation_draft_item_graph', count(*)::bigint
  from refund_allocation_draft_items i
  left join refund_allocation_drafts d on d.id = i.draft_id
  left join order_items oi on oi.id = i.order_item_id
  where d.id is null or oi.id is null

  union all
  select 'refund_reporting_correction_set_graph', count(*)::bigint
  from refund_reporting_correction_sets c
  left join refunds r on r.id = c.refund_id
  left join financial_allocation_sets base on base.id = c.base_allocation_set_id
  left join refund_reporting_correction_sets predecessor
    on predecessor.id = c.predecessor_correction_set_id
   and predecessor.refund_id = c.refund_id
  left join "user" approver on approver.id = c.approved_by_admin_id
  left join "user" creator on creator.id = c.created_by_admin_id
  where r.id is null or base.id is null or approver.id is null
     or (c.predecessor_correction_set_id is not null and predecessor.id is null)
     or (c.created_by_admin_id is not null and creator.id is null)

  union all
  select 'refund_reporting_correction_item_graph', count(*)::bigint
  from refund_reporting_correction_items i
  left join refund_reporting_correction_sets c on c.id = i.correction_set_id
  left join financial_allocation_sets s on s.id = i.source_allocation_set_id
  left join order_items oi on oi.id = i.order_item_id
  where c.id is null or oi.id is null
     or (i.source_allocation_set_id is not null and s.id is null)

  union all
  select 'refund_reporting_correction_item_semantics', count(*)::bigint
  from refund_reporting_correction_items i
  left join refund_reporting_correction_sets correction
    on correction.id = i.correction_set_id
  left join financial_allocation_sets source_set
    on source_set.id = i.source_allocation_set_id
  left join financial_classification_versions source_classification
    on source_classification.subject_type = 'balance_transaction'
   and source_classification.subject_id = source_set.balance_transaction_id
   and source_classification.classifier_version = source_set.classifier_version
   and source_classification.source_fingerprint_sha256 =
     source_set.source_fingerprint_sha256
  where not coalesce((
    (i.domain = 'presentment'
      and i.source_allocation_set_id is null
      and i.component in ('refund_subtotal', 'refund_tax'))
    or (i.domain = 'settlement'
      and correction.id is not null
      and source_set.source_kind = 'refund'
      and source_set.source_internal_id = correction.refund_id
      and source_set.scope = 'title'
      and source_set.reversal_of_set_id is null
      and source_classification.classification = 'refund'
      and (
        (source_set.basis = 'gross_amount'
          and i.component in ('refund_subtotal', 'refund_tax'))
        or (source_set.basis = 'fee' and i.component = 'refund_fee')
      ))
  ), false)

  union all
  select 'refund_reporting_correction_history_semantics', count(*)::bigint
  from (
    select correction.id,
      case when
        exists (
          select 1
          from refund_reporting_correction_items correction_item
          where correction_item.correction_set_id = correction.id
        )
        and correction_refund.status = 'succeeded'
        and correction_refund.currency = correction_payment.currency
        and anchor.id is not null
        and anchor.source_kind = 'refund'
        and anchor.source_internal_id = correction.refund_id
        and anchor.source_fingerprint_sha256 = correction.source_fingerprint_sha256
      then 0 else 1 end::bigint as invalid_context,
      (
        select count(*)
        from refund_reporting_correction_items correction_item
        left join order_items correction_order_item
          on correction_order_item.id = correction_item.order_item_id
        where correction_item.correction_set_id = correction.id
          and (
            correction_order_item.id is null
            or correction_order_item.order_id <> correction_payment.order_id
            or (correction_item.domain = 'presentment' and (
              correction_item.currency <> correction_refund.currency
              or correction_order_item.currency <> correction_item.currency
            ))
          )
      )::bigint as invalid_item_owner,
      (
        select count(*)
        from refund_reporting_correction_items correction_item
        left join financial_allocation_sets item_source
          on item_source.id = correction_item.source_allocation_set_id
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            item_source.id is null
            or item_source.source_kind <> 'refund'
            or item_source.source_internal_id <> correction.refund_id
            or item_source.source_fingerprint_sha256 <>
              correction.source_fingerprint_sha256
            or correction_item.currency <> item_source.currency
          )
      )::bigint as invalid_settlement_source,
      (
        select count(*)
        from refund_reporting_correction_items correction_item
        left join financial_item_allocations base_item
          on base_item.allocation_set_id = correction_item.source_allocation_set_id
         and base_item.order_item_id = correction_item.order_item_id
         and base_item.component = correction_item.component
        where correction_item.correction_set_id = correction.id
          and correction_item.domain = 'settlement'
          and (
            correction_item.approved_absolute_minor::bigint <>
              coalesce(base_item.effect_minor, 0)::bigint +
                correction_item.delta_minor::bigint
            or (base_item.id is not null
              and base_item.currency <> correction_item.currency)
          )
      )::bigint as invalid_settlement_arithmetic,
      (
        select count(*)
        from financial_item_allocations base_item
        where base_item.effect_minor <> 0
          and exists (
            select 1
            from refund_reporting_correction_items source_item
            where source_item.correction_set_id = correction.id
              and source_item.domain = 'settlement'
              and source_item.source_allocation_set_id = base_item.allocation_set_id
          )
          and not exists (
            select 1
            from refund_reporting_correction_items correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'settlement'
              and correction_item.source_allocation_set_id = base_item.allocation_set_id
              and correction_item.order_item_id = base_item.order_item_id
              and correction_item.component = base_item.component
              and correction_item.currency = base_item.currency
          )
      )::bigint as missing_settlement_base,
      (
        select count(*)
        from refund_allocation_components base_component
        cross join lateral (values
          ('refund_subtotal'::financial_component, base_component.subtotal_minor),
          ('refund_tax'::financial_component, base_component.tax_minor)
        ) base_value(component, amount_minor)
        where base_component.refund_id = correction.refund_id
          and base_value.amount_minor <> 0
          and exists (
            select 1
            from refund_reporting_correction_items presentment_item
            where presentment_item.correction_set_id = correction.id
              and presentment_item.domain = 'presentment'
          )
          and not exists (
            select 1
            from refund_reporting_correction_items correction_item
            where correction_item.correction_set_id = correction.id
              and correction_item.domain = 'presentment'
              and correction_item.order_item_id = base_component.order_item_id
              and correction_item.component = base_value.component
              and correction_item.currency = base_component.currency
          )
      )::bigint as missing_presentment_base,
      (
        select count(*)
        from (
          select correction_item.approved_absolute_minor,
            correction_item.delta_minor,
            correction_item.currency,
            base_component.currency as base_currency,
            case correction_item.component
              when 'refund_subtotal' then coalesce(base_component.subtotal_minor, 0)
              when 'refund_tax' then coalesce(base_component.tax_minor, 0)
              else 0
            end::bigint as base_minor,
            case correction_item.component
              when 'refund_subtotal' then correction_order_item.unit_subtotal_minor
              when 'refund_tax' then coalesce(correction_order_item.tax_minor, 0)
              else 0
            end::bigint as capacity_minor
          from refund_reporting_correction_items correction_item
          left join refund_allocation_components base_component
            on base_component.refund_id = correction.refund_id
           and base_component.order_item_id = correction_item.order_item_id
          left join order_items correction_order_item
            on correction_order_item.id = correction_item.order_item_id
          where correction_item.correction_set_id = correction.id
            and correction_item.domain = 'presentment'
        ) presentment
        where presentment.approved_absolute_minor < 0
           or presentment.approved_absolute_minor::bigint <>
             presentment.base_minor + presentment.delta_minor::bigint
           or (presentment.base_currency is not null
             and presentment.base_currency <> presentment.currency)
           or presentment.approved_absolute_minor::bigint > presentment.capacity_minor
      )::bigint as invalid_presentment_arithmetic
    from refund_reporting_correction_sets correction
    left join refunds correction_refund on correction_refund.id = correction.refund_id
    left join payments correction_payment
      on correction_payment.id = correction_refund.payment_id
    left join financial_allocation_sets anchor
      on anchor.id = correction.base_allocation_set_id
  ) correction_history
  where correction_history.invalid_context
      + correction_history.invalid_item_owner
      + correction_history.invalid_settlement_source
      + correction_history.invalid_settlement_arithmetic
      + correction_history.missing_settlement_base
      + correction_history.missing_presentment_base
      + correction_history.invalid_presentment_arithmetic <> 0

  union all
  select 'refund_finalization_effect_graph', count(*)::bigint
  from refund_allocation_finalization_effects e
  left join refund_allocations ra
    on ra.id = e.refund_allocation_id
   and ra.refund_id = e.refund_id
   and ra.order_item_id = e.order_item_id
  left join refund_allocation_drafts d
    on d.id = e.draft_id
   and d.refund_id = e.refund_id
   and d.version = e.draft_version
  left join refund_allocation_draft_items di
    on di.draft_id = e.draft_id and di.order_item_id = e.order_item_id
  left join entitlement_grants g
    on g.id = e.purchase_grant_id and g.order_item_id = e.order_item_id
  where ra.id is null or d.id is null or di.id is null or g.id is null
)
select check_name, violation_count
from orphan_counts
where violation_count <> 0
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
with fee_sums as (
  select bt.id, bt.fee_minor, coalesce(sum(fd.amount_minor), 0)::bigint as detail_minor,
    count(fd.id) filter (where fd.currency <> bt.currency)::bigint as currency_mismatch_count
  from stripe_balance_transactions bt
  left join stripe_balance_transaction_fee_details fd
    on fd.balance_transaction_id = bt.id
  group by bt.id, bt.fee_minor
), allocation_sums as (
  select s.id, s.scope, s.expected_effect_minor, s.currency,
    count(i.id)::bigint as item_count,
    coalesce(sum(i.effect_minor), 0)::bigint as item_minor,
    count(i.id) filter (where i.currency <> s.currency)::bigint as currency_mismatch_count
  from financial_allocation_sets s
  left join financial_item_allocations i on i.allocation_set_id = s.id
  group by s.id, s.scope, s.expected_effect_minor, s.currency
), correction_sums as (
  select correction_set_id, domain, source_allocation_set_id, currency,
    sum(delta_minor)::bigint as delta_minor
  from refund_reporting_correction_items
  group by correction_set_id, domain, source_allocation_set_id, currency
), refund_component_sequence as (
  select c.id as component_id, ra.id as allocation_id,
    ra.amount_minor::bigint as allocation_minor,
    r.id as refund_id, r.status as refund_status,
    r.allocation_status as refund_allocation_status, r.currency as refund_currency,
    r.provider_created_at, r.stripe_refund_id, p.order_id as payment_order_id,
    oi.id as order_item_id, oi.order_id as item_order_id,
    oi.unit_subtotal_minor::bigint as item_subtotal_minor,
    oi.tax_minor::bigint as item_tax_minor, oi.total_minor::bigint as item_total_minor,
    oi.currency as item_currency, c.subtotal_minor::bigint as stored_subtotal_minor,
    c.tax_minor::bigint as stored_tax_minor, c.total_minor::bigint as stored_total_minor,
    c.currency as component_currency,
    coalesce(sum(c.subtotal_minor::bigint) over (
      partition by ra.order_item_id
      order by r.provider_created_at, r.stripe_refund_id collate "C", r.id, ra.id
      rows between unbounded preceding and 1 preceding
    ), 0::bigint) as prior_subtotal_minor,
    coalesce(sum(c.tax_minor::bigint) over (
      partition by ra.order_item_id
      order by r.provider_created_at, r.stripe_refund_id collate "C", r.id, ra.id
      rows between unbounded preceding and 1 preceding
    ), 0::bigint) as prior_tax_minor
  from refund_allocation_components c
  join refund_allocations ra on ra.id = c.refund_allocation_id
  join refunds r on r.id = ra.refund_id
  join payments p on p.id = r.payment_id
  join order_items oi on oi.id = ra.order_item_id
), refund_component_capacity as (
  select *, item_subtotal_minor - prior_subtotal_minor as remaining_subtotal_minor,
    item_tax_minor - prior_tax_minor as remaining_tax_minor
  from refund_component_sequence
), refund_component_ratios as (
  select *, remaining_subtotal_minor + remaining_tax_minor as remaining_total_minor,
    (allocation_minor >= 0 and remaining_subtotal_minor >= 0 and remaining_tax_minor >= 0
      and allocation_minor <= remaining_subtotal_minor + remaining_tax_minor
      and (allocation_minor = 0 or remaining_subtotal_minor + remaining_tax_minor > 0)
    ) as capacity_valid
  from refund_component_capacity
), refund_component_bases as (
  select *,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then div(
        allocation_minor * remaining_subtotal_minor, remaining_total_minor
      )::bigint
    end as base_subtotal_minor,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then div(
        allocation_minor * remaining_tax_minor, remaining_total_minor
      )::bigint
    end as base_tax_minor,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then mod(
        allocation_minor * remaining_subtotal_minor, remaining_total_minor
      )
    end as subtotal_remainder,
    case when capacity_valid and allocation_minor = 0 then 0::bigint
      when capacity_valid then mod(
        allocation_minor * remaining_tax_minor, remaining_total_minor
      )
    end as tax_remainder
  from refund_component_ratios
), refund_component_expected as (
  select *, allocation_minor - base_subtotal_minor - base_tax_minor as leftover_minor,
    base_subtotal_minor + case
      when allocation_minor - base_subtotal_minor - base_tax_minor = 1 and (
        subtotal_remainder > tax_remainder or (
          subtotal_remainder = tax_remainder and
          (order_item_id::text || ':subtotal') collate "C" <
            (order_item_id::text || ':tax') collate "C"
        )
      ) then 1 else 0 end as expected_subtotal_minor,
    base_tax_minor + case
      when allocation_minor - base_subtotal_minor - base_tax_minor = 1 and not (
        subtotal_remainder > tax_remainder or (
          subtotal_remainder = tax_remainder and
          (order_item_id::text || ':subtotal') collate "C" <
            (order_item_id::text || ':tax') collate "C"
        )
      ) then 1 else 0 end as expected_tax_minor
  from refund_component_bases
  where capacity_valid
), combined_active_projection as (
  select classifier_version, allocation_algorithm_version
  from financial_projection_versions
  where singleton = true
), combined_capacity_seeds as (
  select p.id as payment_id, oi.id as order_item_id, oi.currency as presentment_currency,
    oi.unit_subtotal_minor::bigint as original_subtotal_minor,
    oi.tax_minor::bigint as original_tax_minor
  from payments p
  join order_items oi on oi.order_id = p.order_id
), combined_refund_events as (
  select r.payment_id, c.order_item_id, c.currency as presentment_currency,
    r.provider_created_at, r.stripe_refund_id as provider_id,
    r.id as source_internal_id, ra.id as local_event_id,
    -c.subtotal_minor::bigint as subtotal_delta_minor,
    -c.tax_minor::bigint as tax_delta_minor
  from refund_allocation_components c
  join refund_allocations ra
    on ra.id = c.refund_allocation_id
   and ra.refund_id = c.refund_id
   and ra.order_item_id = c.order_item_id
  join refunds r on r.id = c.refund_id
  where r.status = 'succeeded'
    and r.allocation_status in ('finalized', 'exception')
), combined_current_dispute_events as (
  select d.payment_id, a.order_item_id, a.currency as presentment_currency,
    bt.provider_created_at, bt.provider_id, d.id as source_internal_id,
    a.id as local_event_id, a.effect, a.reverses_allocation_id,
    a.subtotal_effect_minor::bigint as subtotal_delta_minor,
    a.tax_effect_minor::bigint as tax_delta_minor,
    a.total_effect_minor::bigint as total_delta_minor,
    s.id as allocation_set_id, s.reversal_of_set_id, s.scope,
    d.currency as dispute_currency, p.currency as payment_currency,
    p.order_id as payment_order_id, oi.order_id as item_order_id,
    oi.currency as item_currency,
    oi.unit_subtotal_minor::bigint as item_subtotal_minor,
    oi.tax_minor::bigint as item_tax_minor, oi.total_minor::bigint as item_total_minor
  from combined_active_projection active
  join financial_allocation_sets s
    on s.classifier_version = active.classifier_version
   and s.algorithm_version = active.allocation_algorithm_version
   and s.source_kind = 'dispute'
   and s.basis = 'gross_amount'
  join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  join disputes d on d.id = s.source_internal_id
  join dispute_item_allocations a
    on a.gross_allocation_set_id = s.id
   and a.dispute_id = d.id
  left join payments p on p.id = d.payment_id
  left join order_items oi on oi.id = a.order_item_id
  where not exists (
    select 1
    from financial_allocation_sets successor
    where successor.supersedes_set_id = s.id
      and successor.classifier_version = s.classifier_version
      and successor.algorithm_version = s.algorithm_version
  )
), combined_dispute_events as (
  select *, count(*) filter (where effect = 'reinstatement') over (
    partition by reverses_allocation_id
  )::bigint as current_reversal_count
  from combined_current_dispute_events
), combined_events as (
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id,
    subtotal_delta_minor, tax_delta_minor
  from combined_refund_events
  union all
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id,
    subtotal_delta_minor, tax_delta_minor
  from combined_dispute_events
), combined_duplicate_chronology as (
  select payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id
  from combined_events
  group by payment_id, order_item_id, presentment_currency, provider_created_at,
    provider_id, source_internal_id, local_event_id
  having count(*) > 1
), combined_ordered_events as (
  select event.*, seed.original_subtotal_minor, seed.original_tax_minor,
    seed.original_subtotal_minor + sum(event.subtotal_delta_minor) over (
      partition by event.payment_id, event.order_item_id, event.presentment_currency
      order by event.provider_created_at, event.provider_id collate "C",
        event.source_internal_id, event.local_event_id
      rows between unbounded preceding and current row
    ) as remaining_subtotal_minor,
    seed.original_tax_minor + sum(event.tax_delta_minor) over (
      partition by event.payment_id, event.order_item_id, event.presentment_currency
      order by event.provider_created_at, event.provider_id collate "C",
        event.source_internal_id, event.local_event_id
      rows between unbounded preceding and current row
    ) as remaining_tax_minor
  from combined_events event
  join combined_capacity_seeds seed
    on seed.payment_id = event.payment_id
   and seed.order_item_id = event.order_item_id
   and seed.presentment_currency = event.presentment_currency
), combined_refund_dispute_violations as (
  select 1 as violation
  from combined_dispute_events event
  where event.scope <> 'title'
     or event.payment_order_id is distinct from event.item_order_id
     or event.presentment_currency is distinct from event.item_currency
     or event.presentment_currency is distinct from event.dispute_currency
     or event.presentment_currency is distinct from event.payment_currency
     or event.item_tax_minor is null or event.item_total_minor is null
     or event.item_total_minor <> event.item_subtotal_minor + event.item_tax_minor
     or event.total_delta_minor <> event.subtotal_delta_minor + event.tax_delta_minor
     or (event.effect = 'withdrawal' and (
       event.reverses_allocation_id is not null
       or event.reversal_of_set_id is not null
       or event.subtotal_delta_minor > 0 or event.tax_delta_minor > 0
       or event.total_delta_minor >= 0
     ))
     or (event.effect = 'reinstatement' and (
       event.reverses_allocation_id is null
       or event.reversal_of_set_id is null
       or event.subtotal_delta_minor < 0 or event.tax_delta_minor < 0
       or event.total_delta_minor <= 0
     ))

  union all
  select 1
  from combined_dispute_events reinstatement
  left join combined_dispute_events withdrawal
    on withdrawal.local_event_id = reinstatement.reverses_allocation_id
  where reinstatement.effect = 'reinstatement'
    and (
      withdrawal.local_event_id is null
      or withdrawal.effect <> 'withdrawal'
      or withdrawal.reverses_allocation_id is not null
      or withdrawal.reversal_of_set_id is not null
      or reinstatement.source_internal_id <> withdrawal.source_internal_id
      or reinstatement.reversal_of_set_id <> withdrawal.allocation_set_id
      or reinstatement.order_item_id <> withdrawal.order_item_id
      or reinstatement.presentment_currency <> withdrawal.presentment_currency
      or reinstatement.subtotal_delta_minor > -withdrawal.subtotal_delta_minor
      or reinstatement.tax_delta_minor > -withdrawal.tax_delta_minor
      or reinstatement.current_reversal_count <> 1
      or row(
        withdrawal.provider_created_at,
        withdrawal.provider_id collate "C",
        withdrawal.source_internal_id,
        withdrawal.local_event_id
      ) >= row(
        reinstatement.provider_created_at,
        reinstatement.provider_id collate "C",
        reinstatement.source_internal_id,
        reinstatement.local_event_id
      )
    )

  union all
  select 1
  from combined_duplicate_chronology

  union all
  select 1
  from combined_ordered_events
  where remaining_subtotal_minor not between 0 and original_subtotal_minor
     or remaining_tax_minor not between 0 and original_tax_minor
), conservation_counts as (
  select 'balance_transaction_net_equation' as check_name, count(*)::bigint as violation_count
  from stripe_balance_transactions
  where net_minor <> amount_minor - fee_minor

  union all
  select 'fee_detail_sum', count(*)::bigint
  from fee_sums
  where detail_minor <> fee_minor or currency_mismatch_count <> 0

  union all
  select 'allocation_set_provider_target', count(*)::bigint
  from financial_allocation_sets s
  join stripe_balance_transactions bt on bt.id = s.balance_transaction_id
  where s.currency <> bt.currency
     or s.expected_effect_minor <>
       case s.basis when 'gross_amount' then bt.amount_minor else -bt.fee_minor end

  union all
  select 'allocation_item_conservation', count(*)::bigint
  from allocation_sums
  where currency_mismatch_count <> 0
     or (scope = 'title' and item_minor <> expected_effect_minor)
     or (scope = 'title' and expected_effect_minor <> 0 and item_count = 0)
     or (scope in ('account', 'unresolved') and item_count <> 0)

  union all
  select 'refund_component_equation', count(*)::bigint
  from refund_allocation_components c
  join refund_allocations ra on ra.id = c.refund_allocation_id
  join refunds r on r.id = c.refund_id
  where c.total_minor <> c.subtotal_minor + c.tax_minor
     or c.total_minor <> ra.amount_minor
     or c.currency <> r.currency

  union all
  select 'refund_component_chronology_capacity', count(*)::bigint
  from refund_component_ratios
  where refund_status <> 'succeeded'
     or refund_allocation_status not in ('finalized', 'exception')
     or item_tax_minor is null or item_total_minor is null
     or item_total_minor <> item_subtotal_minor + item_tax_minor
     or payment_order_id <> item_order_id
     or refund_currency <> item_currency
     or refund_currency <> component_currency
     or stored_subtotal_minor > remaining_subtotal_minor
     or stored_tax_minor > remaining_tax_minor
     or capacity_valid is distinct from true

  union all
  select 'refund_component_deterministic_split', count(*)::bigint
  from refund_component_expected
  where leftover_minor not between 0 and 1
     or stored_subtotal_minor is distinct from expected_subtotal_minor
     or stored_tax_minor is distinct from expected_tax_minor

  union all
  select 'combined_refund_dispute_chronology_capacity', count(*)::bigint
  from combined_refund_dispute_violations

  union all
  select 'finalized_refund_allocation_shape', count(*)::bigint
  from refunds r
  left join lateral (
    select count(ra.id)::bigint as allocation_count,
      count(c.id)::bigint as component_count,
      coalesce(sum(ra.amount_minor), 0)::bigint as allocation_minor,
      coalesce(sum(c.total_minor), 0)::bigint as component_minor
    from refund_allocations ra
    left join refund_allocation_components c on c.refund_allocation_id = ra.id
    where ra.refund_id = r.id
  ) totals on true
  where r.allocation_status = 'finalized'
    and (totals.allocation_count = 0
      or totals.component_count <> totals.allocation_count
      or totals.allocation_minor <> r.amount_minor
      or totals.component_minor <> r.amount_minor)

  union all
  select 'dispute_component_equation', count(*)::bigint
  from dispute_item_allocations
  where total_effect_minor <> subtotal_effect_minor + tax_effect_minor

  union all
  select 'reporting_correction_zero_sum', count(*)::bigint
  from correction_sums
  where delta_minor <> 0
)
select check_name, violation_count
from conservation_counts
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
with entry_counts as (
  select r.id, r.payout_id, r.generation, r.state, r.candidate_count,
    count(e.id)::bigint as entry_count
  from payout_import_runs r
  left join payout_import_run_entries e on e.run_id = r.id
  group by r.id, r.payout_id, r.generation, r.state, r.candidate_count
), payout_membership_counts as (
  select r.id, count(m.id)::bigint as membership_count
  from payout_import_runs r
  left join stripe_payout_balance_transactions m on m.payout_id = r.payout_id
  group by r.id
), payout_checks as (
  select 'run_candidate_count' as check_name, count(*)::bigint as violation_count
  from entry_counts
  where entry_count <> candidate_count

  union all
  select 'run_generation_order', count(*)::bigint
  from payout_import_runs r
  join stripe_payouts p on p.id = r.payout_id
  where r.generation > p.financial_generation
     or (r.state in ('collecting', 'publishable') and r.generation <> p.financial_generation)
     or (r.state = 'published' and r.generation = p.financial_generation and not exists (
       select 1
       from payout_import_runs history
       where history.payout_id = r.payout_id
         and history.id <> r.id
         and history.state = 'published'
         and history.generation::bigint + 1 < r.generation::bigint
     ))

  union all
  select 'published_membership_count', count(*)::bigint
  from entry_counts e
  join payout_membership_counts m on m.id = e.id
  where e.state = 'published' and e.entry_count <> m.membership_count

  union all
  select 'membership_nonpublished_run', count(*)::bigint
  from stripe_payout_balance_transactions m
  join payout_import_runs r on r.id = m.published_from_run_id
  where r.state <> 'published'

  union all
  select 'published_entry_missing_membership', count(*)::bigint
  from payout_import_run_entries e
  join payout_import_runs r on r.id = e.run_id and r.state = 'published'
  where not exists (
    select 1
    from stripe_payout_balance_transactions m
    where m.payout_id = r.payout_id
      and m.balance_transaction_id = e.balance_transaction_id
  )

  union all
  select 'published_membership_missing_entry', count(*)::bigint
  from stripe_payout_balance_transactions m
  join payout_import_runs r on r.id = m.published_from_run_id
  where r.state = 'published'
    and not exists (
      select 1
      from payout_import_run_entries e
      where e.run_id = m.published_from_run_id
        and e.balance_transaction_id = m.balance_transaction_id
    )

  union all
  select 'unsupported_authoritative_membership', count(*)::bigint
  from stripe_payout_balance_transactions m
  join stripe_payouts p on p.id = m.payout_id
  where not p.automatic or p.method <> 'standard' or p.reconciliation_status <> 'completed'

  union all
  select 'missing_current_generation_impact_job', count(*)::bigint
  from stripe_payouts p
  where p.financial_generation > 0
    and not exists (
      select 1
      from jobs j
      where j.deduplication_key =
        'financial:payout-impact:' || p.id::text || ':' || p.financial_generation::text
        and j.type = 'commerce.financial-scan'
        and j.max_attempts = 8
        and j.payload = jsonb_build_object(
          'kind', 'payout_impact',
          'payoutId', p.id,
          'payoutGeneration', p.financial_generation
        )
    )
)
select check_name, violation_count
from payout_checks
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
with pending_replay_children as (
  select version.pending_scan_run_id, version.pending_classifier_version,
    version.pending_allocation_algorithm_version, version.pending_replay_id,
    replay.id as replay_run_id, replay.enqueued_count,
    children.child_count, children.invalid_count, children.incomplete_count,
    children.exhausted_count, children.permanent_count
  from financial_projection_versions version
  left join financial_scan_runs replay on replay.id = version.pending_scan_run_id
  left join lateral (
    select count(*)::bigint as child_count,
      count(*) filter (where
        child.payload ->> 'classifierVersion' is distinct from
          version.pending_classifier_version::text
        or child.payload ->> 'allocationAlgorithmVersion' is distinct from
          version.pending_allocation_algorithm_version::text
        or child.payload ->> 'replayId' is distinct from version.pending_replay_id
      )::bigint as invalid_count,
      count(*) filter (where child.status <> 'succeeded')::bigint as incomplete_count,
      count(*) filter (where
        child.status = 'failed' and child.attempts >= child.max_attempts
      )::bigint as exhausted_count,
      count(*) filter (where
        child.status = 'failed' and child.attempts < child.max_attempts
      )::bigint as permanent_count
    from jobs child
    where child.type = 'commerce.financial-classification'
      and child.payload ->> 'scanRunId' = version.pending_scan_run_id::text
  ) children on true
  where version.singleton = true and version.pending_scan_run_id is not null
), scan_checks as (
  select 'scan_root_job_missing' as check_name, count(*)::bigint as violation_count
  from financial_scan_runs r
  where not exists (
    select 1 from jobs j
    where j.deduplication_key = r.root_key
      and j.type = 'commerce.financial-scan'
      and j.max_attempts = 8
      and case r.kind
        when 'initial_backfill' then r.root_key = 'commerce.financial-scan:initial:v1'
          and j.payload = '{"kind":"initial","version":1}'::jsonb
        when 'hourly' then r.root_key ~ '^commerce\.financial-scan:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):00:00\.000Z$'
          and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4) <> '0000'
          and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 10) =
            to_char(
              make_date(
                substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4)::int,
                substring(r.root_key from char_length('commerce.financial-scan:') + 6 for 2)::int,
                1
              ) + (
                substring(r.root_key from char_length('commerce.financial-scan:') + 9 for 2)::int - 1
              ),
              'YYYY-MM-DD'
            )
          and j.payload = jsonb_build_object(
          'kind', 'hourly', 'scanGenerationHour',
          substring(r.root_key from char_length('commerce.financial-scan:') + 1)
        )
        when 'payout_impact' then r.root_key =
          'financial:payout-impact:' || (j.payload ->> 'payoutId') || ':' ||
          (j.payload ->> 'payoutGeneration')
          and (j.payload ->> 'payoutId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and jsonb_typeof(j.payload -> 'payoutGeneration') = 'number'
          and (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
          and case when (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
            then (j.payload ->> 'payoutGeneration')::bigint <= 2147483647 else false end
          and j.payload = jsonb_build_object(
          'kind', 'payout_impact',
          'payoutId', j.payload ->> 'payoutId',
          'payoutGeneration', j.payload -> 'payoutGeneration'
        )
        when 'classification_replay' then r.root_key =
          'commerce.financial-classification:scan:' || r.classifier_version::text || ':' ||
          r.allocation_algorithm_version::text
          and j.payload = jsonb_build_object(
          'kind', 'composite_replay',
          'classifierVersion', r.classifier_version,
          'allocationAlgorithmVersion', r.allocation_algorithm_version,
          'replayId', r.replay_id
        )
        else false
      end
  )

  union all
  select 'running_scan_resume_job_missing', count(*)::bigint
  from financial_scan_runs r
  where r.state = 'running'
    and not exists (
      select 1
      from jobs j
      where j.deduplication_key = (case
        when r.cursor_digest_sha256 is null then r.root_key
        else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
      end)
        and j.type = 'commerce.financial-scan'
        and j.max_attempts = 8
        and j.status in ('pending', 'running', 'failed')
        and (j.status <> 'pending' or j.attempts < j.max_attempts)
        and case
          when r.cursor_digest_sha256 is not null then j.payload = jsonb_build_object(
            'kind', 'continuation',
            'scanRunId', r.id,
            'phase', r.phase,
            'cursorDigestSha256', r.cursor_digest_sha256,
            'limit', 100
          )
          when r.kind = 'initial_backfill' then
            r.root_key = 'commerce.financial-scan:initial:v1'
            and j.payload = '{"kind":"initial","version":1}'::jsonb
          when r.kind = 'hourly' then
            r.root_key ~ '^commerce\.financial-scan:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):00:00\.000Z$'
            and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4) <> '0000'
            and substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 10) =
              to_char(
                make_date(
                  substring(r.root_key from char_length('commerce.financial-scan:') + 1 for 4)::int,
                  substring(r.root_key from char_length('commerce.financial-scan:') + 6 for 2)::int,
                  1
                ) + (
                  substring(r.root_key from char_length('commerce.financial-scan:') + 9 for 2)::int - 1
                ),
                'YYYY-MM-DD'
              )
            and j.payload = jsonb_build_object(
            'kind', 'hourly', 'scanGenerationHour',
            substring(r.root_key from char_length('commerce.financial-scan:') + 1)
          )
          when r.kind = 'payout_impact' then
            r.root_key = 'financial:payout-impact:' || (j.payload ->> 'payoutId') || ':' ||
              (j.payload ->> 'payoutGeneration')
            and (j.payload ->> 'payoutId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and jsonb_typeof(j.payload -> 'payoutGeneration') = 'number'
            and (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
            and case when (j.payload ->> 'payoutGeneration') ~ '^[1-9][0-9]{0,9}$'
              then (j.payload ->> 'payoutGeneration')::bigint <= 2147483647 else false end
            and j.payload = jsonb_build_object(
            'kind', 'payout_impact',
            'payoutId', j.payload ->> 'payoutId',
            'payoutGeneration', j.payload -> 'payoutGeneration'
          )
          when r.kind = 'classification_replay' then
            r.root_key = 'commerce.financial-classification:scan:' ||
              r.classifier_version::text || ':' || r.allocation_algorithm_version::text
            and j.payload = jsonb_build_object(
            'kind', 'composite_replay',
            'classifierVersion', r.classifier_version,
            'allocationAlgorithmVersion', r.allocation_algorithm_version,
            'replayId', r.replay_id
          )
          else false
        end
    )

  union all
  select 'running_scan_cursor_integrity', count(*)::bigint
  from financial_scan_runs r
  where r.state = 'running'
    and r.checkpoint is not null and r.cursor_digest_sha256 is null
    or (r.state = 'running' and r.cursor_digest_sha256 is not null and
      r.cursor_digest_sha256 <> encode(sha256(
        convert_to(r.phase, 'UTF8') || decode('00', 'hex') ||
        convert_to(coalesce(r.checkpoint, ''), 'UTF8')
      ), 'hex'))

  union all
  select 'scan_phase_checkpoint_shape', count(*)::bigint
  from financial_scan_runs r
  where r.phase not in (
      'source_page', 'payout_discovery_page', 'incomplete_payout_run_page',
      'payout_impact_page', 'classification_replay_page',
      'classification_replay_finalize'
    )
    or (r.kind = 'classification_replay' and
      r.phase not in ('classification_replay_page', 'classification_replay_finalize'))
    or (r.kind = 'classification_replay' and r.state = 'completed' and
      r.phase <> 'classification_replay_finalize')
    or (r.kind = 'payout_impact' and r.phase <> 'payout_impact_page')
    or (r.kind in ('initial_backfill', 'hourly') and
      r.phase not in ('source_page', 'payout_discovery_page', 'incomplete_payout_run_page'))
    or (r.phase in ('source_page', 'payout_impact_page') and r.checkpoint is not null and
      r.checkpoint !~ '^(payment|refund|dispute):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'incomplete_payout_run_page' and r.checkpoint is not null and
      r.checkpoint !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'classification_replay_page' and r.checkpoint is not null and
      r.checkpoint !~ '^(balance_transaction|fee_detail):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (r.phase = 'classification_replay_finalize' and r.checkpoint is not null)

  union all
  select 'scan_lifecycle_shape', count(*)::bigint
  from financial_scan_runs
  where ((state in ('completed', 'exception')) <> (completed_at is not null))
     or processed_count < 0 or enqueued_count < 0 or page_count < 0

  union all
  select 'completed_scan_retains_cursor', count(*)::bigint
  from financial_scan_runs
  where state = 'completed'
    and (checkpoint is not null or cursor_digest_sha256 is not null
      or safe_outcome is distinct from 'completed')

  union all
  select 'replay_identity_mismatch', count(*)::bigint
  from financial_scan_runs
  where (classifier_version is null) <> (allocation_algorithm_version is null)
     or (classifier_version is null) <> (replay_id is null)
     or ((kind = 'classification_replay') <> (classifier_version is not null))
     or (replay_id is not null and replay_id <>
       'c' || classifier_version::text || '-a' || allocation_algorithm_version::text)

  union all
  select 'pending_replay_authority_mismatch', count(*)::bigint
  from financial_projection_versions version
  left join financial_scan_runs replay on replay.id = version.pending_scan_run_id
  where version.singleton = true and version.pending_scan_run_id is not null
    and (replay.id is null
      or replay.kind is distinct from 'classification_replay'
      or replay.state is distinct from 'running'
      or replay.phase not in ('classification_replay_page', 'classification_replay_finalize')
      or replay.classifier_version is distinct from version.pending_classifier_version
      or replay.allocation_algorithm_version is distinct from
        version.pending_allocation_algorithm_version
      or replay.replay_id is distinct from version.pending_replay_id)

  union all
  select 'pending_replay_child_count_mismatch', count(*)::bigint
  from pending_replay_children pending
  where pending.replay_run_id is not null
    and pending.child_count < pending.enqueued_count

  union all
  select 'pending_replay_child_version_mismatch',
    coalesce(sum(invalid_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_incomplete',
    coalesce(sum(incomplete_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_retry_exhausted',
    coalesce(sum(exhausted_count), 0)::bigint
  from pending_replay_children

  union all
  select 'pending_replay_child_permanent',
    coalesce(sum(permanent_count), 0)::bigint
  from pending_replay_children

  union all
  select 'failed_running_scan_retry_exhausted', count(*)::bigint
  from financial_scan_runs r
  join jobs j on j.deduplication_key = (case
    when r.cursor_digest_sha256 is null then r.root_key
    else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
  end)
  where r.state = 'running' and j.status = 'failed' and j.attempts >= j.max_attempts

  union all
  select 'failed_running_scan_permanent', count(*)::bigint
  from financial_scan_runs r
  join jobs j on j.deduplication_key = (case
    when r.cursor_digest_sha256 is null then r.root_key
    else 'commerce.financial-scan:' || r.id::text || ':' || r.phase || ':' || r.cursor_digest_sha256
  end)
  where r.state = 'running' and j.status = 'failed' and j.attempts < j.max_attempts
)
select check_name, violation_count
from scan_checks
order by check_name;

insert into restore_financial_checks (check_name, violation_count)
select 'classification_replay_completed_phase', count(*)::bigint
from financial_scan_runs replay
where replay.kind = 'classification_replay'
  and replay.state = 'completed'
  and (
    replay.phase is distinct from 'classification_replay_finalize'
    or replay.checkpoint is not null
    or replay.cursor_digest_sha256 is not null
  );

do $restore_verifier$
declare
  total_violations bigint;
  failed_checks text;
begin
  select coalesce(sum(violation_count), 0),
    string_agg(check_name || '=' || violation_count::text, ', ' order by check_name collate "C")
  into total_violations, failed_checks
  from restore_financial_checks
  where violation_count <> 0
    and check_name not in (
      'failed_running_scan_retry_exhausted',
      'failed_running_scan_permanent',
      'pending_replay_child_incomplete',
      'pending_replay_child_retry_exhausted',
      'pending_replay_child_permanent'
    );

  if total_violations <> 0 then
    raise exception 'restore financial/credential invariant violation: %', failed_checks;
  end if;
end
$restore_verifier$;

select check_name, violation_count
from restore_financial_checks
where check_name in (
  'failed_running_scan_permanent',
  'failed_running_scan_retry_exhausted',
  'pending_replay_child_incomplete',
  'pending_replay_child_permanent',
  'pending_replay_child_retry_exhausted'
)
order by check_name collate "C";

rollback;
