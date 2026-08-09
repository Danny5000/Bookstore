import { describe, expect, it } from 'vitest';
import { normalizeGeneratedAuthSchema } from './normalize-schema';

describe('normalizeGeneratedAuthSchema', () => {
  it('makes every generated PostgreSQL timestamp timezone-aware', () => {
    const source = [
      'createdAt: timestamp("created_at").defaultNow().notNull(),',
      'expiresAt: timestamp("expires_at").notNull(),'
    ].join('\n');

    expect(normalizeGeneratedAuthSchema(source)).toBe(
      [
        'createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),',
        'expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),'
      ].join('\n')
    );
  });

  it('is idempotent', () => {
    const source = 'createdAt: timestamp("created_at", { withTimezone: true }).notNull(),';
    expect(normalizeGeneratedAuthSchema(normalizeGeneratedAuthSchema(source))).toBe(source);
  });
});
