import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('project-owned credential authority schema', () => {
  it('survives Better Auth schema regeneration outside the generated module', () => {
    const generatedAuth = source('../src/lib/server/db/schema/auth.ts');
    const projectSecurity = source('../src/lib/server/db/schema/auth-security.ts');
    const schemaIndex = source('../src/lib/server/db/schema/index.ts');

    expect(generatedAuth).not.toMatch(/credentialAuthority|credential_authority/u);
    expect(projectSecurity).toContain("export const credentialAuthority = pgTable(");
    expect(schemaIndex).toContain("export * from './auth-security';");
  });

  it('backfills exact legacy credential hashes and rejects ambiguous legacy state', () => {
    const migration = source('../drizzle/0006_credential_authority.sql');

    expect(migration).toContain(
      "RAISE EXCEPTION 'credential authority backfill requires exactly one credential account per user'"
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'credential authority backfill requires every credential account to have a password hash'"
    );
    expect(migration).toMatch(
      /INSERT INTO "credential_authority"[\s\S]+SELECT[\s\S]+"user_id",[\s\S]+"password"[\s\S]+FROM "account"[\s\S]+WHERE "provider_id" = 'credential'/u
    );
    expect(migration).toContain('credential_authority_has_authorized_hash_or_active_reset');
  });
});
