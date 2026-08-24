import { sql, type SQL } from 'drizzle-orm';

/**
 * Requires the containing query to define a bounded `target_payouts(id)` CTE.
 * The resulting `certified_membership` CTE exposes exactly one latest published
 * certification per target payout using the canonical payout-generation rules.
 */
export function payoutMembershipCertificationCtes(): SQL {
  return sql`
    published_run_candidates as (
      select
        run.id,
        run.payout_id,
        run.generation,
        run.candidate_count,
        run.completed_at,
        case when
          exists (
            select 1
            from stripe_payout_balance_transactions original_membership
            where original_membership.published_from_run_id = run.id
              and original_membership.payout_id = run.payout_id
          ) or (
            run.candidate_count = 0 and not exists (
              select 1
              from payout_import_runs earlier_published
              where earlier_published.payout_id = run.payout_id
                and earlier_published.state = 'published'
                and earlier_published.generation < run.generation
            )
          )
          then run.generation + 1
          else run.generation
        end as certified_generation
      from payout_import_runs run
      join target_payouts target_payout on target_payout.id = run.payout_id
      where run.state = 'published' and run.completed_at is not null
    ), ranked_certifications as (
      select candidate.*,
        row_number() over (
          partition by candidate.payout_id
          order by candidate.certified_generation desc, candidate.completed_at desc, candidate.id desc
        ) as certification_rank
      from published_run_candidates candidate
    ), certified_membership as (
      select * from ranked_certifications where certification_rank = 1
    )
  `;
}
