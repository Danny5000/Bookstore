import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { jobs } from './operations';

function rendered(query: SQL): { readonly sql: string; readonly params: unknown[] } {
  const result = query.toQuery({
    casing: { getColumnCasing: (column: { name: string }) => column.name } as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
  return { sql: result.sql.replaceAll(/\s+/gu, ' '), params: result.params };
}

describe('operations schema declarations', () => {
  it('preserves the exact literal partial-index predicate without bound parameters', () => {
    const index = getTableConfig(jobs).indexes.find(
      ({ config }) => config.name === 'jobs_active_ingest_revision_identity_idx'
    );
    expect(index?.config.where).toBeDefined();
    expect(rendered(index!.config.where!)).toEqual({
      sql: '"jobs"."type" = \'catalog.ingest_revision\' and ' +
        '"jobs"."status" in (\'pending\', \'running\')',
      params: []
    });
  });
});
