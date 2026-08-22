import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { financialReconciliationIssues } from '$lib/server/db/schema';
import { currentOperationalFinancialIssuePredicate } from './review-authority';

const dialect = new PgDialect();

function rendered(query: SQL): { readonly sql: string; readonly params: unknown[] } {
  return dialect.sqlToQuery(query);
}

function normalized(query: SQL): string {
  return rendered(query).sql.replaceAll('"', '').replace(/\s+/gu, ' ').trim();
}

describe('current operational financial issue authority', () => {
  it('requires open state while retaining current nonversioned source and payout issues', () => {
    const statement = normalized(currentOperationalFinancialIssuePredicate());

    expect(statement).toMatch(
      /financial_reconciliation_issues\.state = 'open'/u
    );
    expect(statement).toMatch(
      /financial_reconciliation_issues\.resource_type not in \( 'financial_classification', 'allocation_set' \)/u
    );
  });

  it('admits a classification issue only for the active classifier and exact current raw fingerprint', () => {
    const statement = normalized(currentOperationalFinancialIssuePredicate());

    expect(statement).toMatch(
      /from financial_projection_versions active where active\.singleton = true/u
    );
    expect(statement).toMatch(
      /from financial_classification_versions classification/u
    );
    expect(statement).toMatch(
      /classification\.id = financial_reconciliation_issues\.resource_id/u
    );
    expect(statement).toMatch(
      /classification\.classifier_version = active\.classifier_version/u
    );
    expect(statement).toMatch(
      /classification\.subject_type = 'balance_transaction'[\s\S]*balance\.id = classification\.subject_id[\s\S]*balance\.fingerprint_sha256 = classification\.source_fingerprint_sha256/u
    );
    expect(statement).toMatch(
      /classification\.subject_type = 'fee_detail'[\s\S]*detail\.id = classification\.subject_id[\s\S]*detail\.fingerprint_sha256 = classification\.source_fingerprint_sha256/u
    );
  });

  it('admits an allocation issue only for a raw active-pair tip selected by successor exclusion', () => {
    const statement = normalized(currentOperationalFinancialIssuePredicate());

    expect(statement).toMatch(
      /from financial_allocation_sets allocation/u
    );
    expect(statement).toMatch(
      /allocation\.id = financial_reconciliation_issues\.resource_id/u
    );
    expect(statement).toMatch(
      /allocation\.classifier_version = active\.classifier_version/u
    );
    expect(statement).toMatch(
      /allocation\.algorithm_version = active\.allocation_algorithm_version/u
    );
    expect(statement).toMatch(
      /not exists \( select 1 from financial_allocation_sets successor where successor\.supersedes_set_id = allocation\.id and successor\.classifier_version = allocation\.classifier_version and successor\.algorithm_version = allocation\.algorithm_version \)/u
    );
    expect(statement).not.toContain('current_financial_projection_heads');
    expect(statement).not.toContain('base_set_id');
  });

  it('is one argument-free read-only fragment composable by both list and count queries', () => {
    expect(currentOperationalFinancialIssuePredicate).toHaveLength(0);

    const list = rendered(sql`
      select ${financialReconciliationIssues.id}
      from ${financialReconciliationIssues}
      where ${currentOperationalFinancialIssuePredicate()}
      order by ${financialReconciliationIssues.id}
      limit ${51}
    `);
    const count = rendered(sql`
      select count(*)::integer
      from ${financialReconciliationIssues}
      where ${currentOperationalFinancialIssuePredicate()}
    `);

    expect(list.sql).toContain('select "financial_reconciliation_issues"."id"');
    expect(list.params).toEqual([51]);
    expect(count.sql).toContain('select count(*)::integer');
    expect(count.params).toEqual([]);
    for (const statement of [list.sql, count.sql]) {
      expect(statement).not.toMatch(/\b(?:insert|update|delete|truncate|alter|drop)\b/iu);
    }
  });
});
