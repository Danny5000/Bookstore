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
  where (c.subject_type = 'balance_transaction' and bt.id is null)
     or (c.subject_type = 'fee_detail' and fd.id is null)

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
  select 'allocation_set_semantic_source', count(*)::bigint
  from financial_allocation_sets s
  left join payments p on s.source_kind = 'payment' and p.id = s.source_internal_id
  left join refunds r on s.source_kind = 'refund' and r.id = s.source_internal_id
  left join disputes d on s.source_kind = 'dispute' and d.id = s.source_internal_id
  left join stripe_payouts po on s.source_kind = 'payout' and po.id = s.source_internal_id
  left join stripe_balance_transactions bt
    on s.source_kind = 'adjustment' and bt.id = s.source_internal_id
  where (s.source_kind = 'payment' and p.id is null)
     or (s.source_kind = 'refund' and r.id is null)
     or (s.source_kind = 'dispute' and d.id is null)
     or (s.source_kind = 'payout' and po.id is null)
     or (s.source_kind = 'adjustment' and bt.id is null)

  union all
  select 'financial_item_allocation_parent', count(*)::bigint
  from financial_item_allocations i
  left join financial_allocation_sets s on s.id = i.allocation_set_id
  left join order_items oi on oi.id = i.order_item_id
  where s.id is null or oi.id is null

  union all
  select 'financial_issue_vocabulary', count(*)::bigint
  from financial_reconciliation_issues i
  where i.resource_type not in (
    'payment', 'refund', 'dispute', 'payout', 'payout_import_run',
    'balance_transaction', 'fee_detail', 'allocation_set', 'correction_set',
    'financial_scan_run'
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
     or (i.resource_type = 'financial_scan_run' and sr.id is null)
     or (i.resolved_by_admin_id is not null and resolver.id is null)

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
  left join financial_allocation_sets s
    on s.id = a.gross_allocation_set_id and s.source_internal_id = a.dispute_id
  left join order_items oi on oi.id = a.order_item_id
  left join dispute_item_allocations reversal on reversal.id = a.reverses_allocation_id
  where d.id is null or s.id is null or oi.id is null
     or (a.reverses_allocation_id is not null and reversal.id is null)

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
     or (r.state = 'published' and r.generation >= p.financial_generation)

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
with scan_checks as (
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
      'failed_running_scan_permanent'
    );

  if total_violations <> 0 then
    raise exception 'restore financial/credential invariant violation: %', failed_checks;
  end if;
end
$restore_verifier$;

rollback;
