import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function functionDefinition(migration: string, name: string): string {
  return migration.match(new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION "public"\\."${name}"[\\s\\S]*?\\$\\$;`,
    'u'
  ))?.[0] ?? '';
}

describe('database-enforced guest-claim authority', () => {
  it('preflights both account and guest purchase-grant provenance without stranding claims', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');
    const preflight = migration.match(/DO \$\$[\s\S]*?END;\r?\n\$\$;/u)?.[0] ?? '';

    expect(preflight).toContain(
      'grant_row.user_id IS DISTINCT FROM purchase_order.initiating_user_id'
    );
    expect(preflight).toContain(
      'identity.claimed_by_user_id IS DISTINCT FROM grant_row.user_id'
    );
    expect(preflight).not.toMatch(
      /WHERE grant_row\.source = 'purchase'\s+AND grant_row\.user_id IS NOT NULL/u
    );
    expect(preflight).toMatch(
      /JOIN "public"\."order_items" item[\s\S]+LEFT JOIN "public"\."entitlement_grants" purchase_grant[\s\S]+purchase_grant\.id IS NULL/u
    );
  });

  it('defines one protected issued-authorized-consumed lifecycle in append-only 0010', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');
    const schema = source('../src/lib/server/db/schema/auth-security.ts');

    expect(migration).toContain('CREATE TABLE "public"."commerce_claim_issuances"');
    for (const column of [
      'claim_proof_sha256',
      'auth_token_sha256',
      'normalized_email',
      'anchor_order_id',
      'kind',
      'state',
      'authorized_user_id',
      'issued_at',
      'expires_at',
      'authorized_at',
      'consumed_at',
      'result_disposition',
      'result_changed',
      'result_order_count',
      'result_title_count'
    ]) expect(migration).toContain(`"${column}"`);
    for (const state of ['issued', 'authorized', 'consumed']) {
      expect(migration).toContain(`'${state}'`);
    }
    expect(migration).toContain('commerce_claim_issuances_claim_proof_sha256_valid');
    expect(migration).toContain('commerce_claim_issuances_auth_token_sha256_valid');
    expect(migration).toContain('commerce_claim_issuances_email_normalized');
    expect(migration).toContain('commerce_claim_issuances_lifecycle_consistent');
    expect(migration).toContain('commerce_claim_issuances_timestamp_order');
    expect(migration).toContain('commerce_claim_issuances_result_valid');
    expect(migration).toMatch(
      /state = 'consumed'[\s\S]+auth_token_sha256 is null[\s\S]+normalized_email is null[\s\S]+anchor_order_id is null[\s\S]+authorized_user_id is null/iu
    );
    expect(schema).toContain('export const commerceClaimIssuances = pgTable(');
    expect(schema).toContain("'commerce_claim_issuances'");
  });

  it('pins worker-only registration/purge and runtime promotion/claim routines', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');
    const register = functionDefinition(migration, 'register_commerce_claim_issuance');
    const authorize = functionDefinition(migration, 'authorize_commerce_claim_issuance');
    const claim = functionDefinition(migration, 'claim_guest_purchases_after_authorization');
    const purge = functionDefinition(migration, 'purge_commerce_claim_issuances');

    for (const definition of [register, authorize, claim, purge]) {
      expect(definition).toContain('SECURITY DEFINER');
      expect(definition).toContain("SET search_path = 'pg_catalog'");
    }
    expect(register).toContain('p_claim_proof_sha256');
    expect(register).toContain('p_auth_token_sha256');
    expect(register).not.toContain('p_raw_claim_proof');
    expect(register).not.toContain('p_raw_auth_token');
    expect(register).toMatch(
      /ORDER BY[\s\S]+claim_proof_sha256[\s\S]+FOR UPDATE/u
    );
    expect(register).toMatch(
      /DELETE FROM "public"\."commerce_claim_issuances"[\s\S]+normalized_email[\s\S]+state IN \('issued', 'authorized'\)/u
    );

    for (const definition of [authorize, claim]) {
      expect(definition).toContain('pg_catalog.sha256');
      expect(definition).toContain('pg_catalog.convert_to');
      expect(definition).toContain('credential_authority');
      expect(definition).toMatch(/FOR UPDATE/u);
    }
    expect(authorize).toContain('p_raw_claim_proof');
    expect(authorize).toContain('p_raw_auth_token');
    expect(authorize).toMatch(/state[\s\S]+issued[\s\S]+authorized/u);
    expect(claim).toContain('p_raw_claim_proof');
    expect(claim).toContain('p_correlation_id');
    expect(claim).not.toMatch(/p_user_id|p_email|p_kind|p_now/u);
    expect(claim).toMatch(/state[\s\S]+authorized[\s\S]+consumed/u);
    expect(claim).toMatch(
      /auth_token_sha256[\s\S]*=[\s\S]*NULL[\s\S]+normalized_email[\s\S]*=[\s\S]*NULL[\s\S]+anchor_order_id[\s\S]*=[\s\S]*NULL[\s\S]+authorized_user_id[\s\S]*=[\s\S]*NULL/u
    );
    expect(claim).toMatch(
      /candidate\.state = 'consumed'[\s\S]+candidate\.result_disposition/u
    );
    expect(claim).toMatch(
      /locked_issuance\.state = 'consumed'[\s\S]+locked_issuance\.result_disposition/u
    );
    for (const disposition of [
      'claimed',
      'not_eligible',
      'definitive_invalid',
      'identity_conflict'
    ]) expect(claim).toContain(`'${disposition}'`);
    expect(purge).toMatch(/INTERVAL '24 hours'/u);

    expect(migration).toMatch(
      /REVOKE ALL ON TABLE "public"\."commerce_claim_issuances" FROM PUBLIC/u
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE "public"\."commerce_claim_issuances" FROM "pale_orbit_runtime", "pale_orbit_financial_worker"/u
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION "public"\."register_commerce_claim_issuance"[\s\S]+TO "pale_orbit_financial_worker"/u
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION "public"\."purge_commerce_claim_issuances"[\s\S]+TO "pale_orbit_financial_worker"/u
    );
    for (const name of [
      'authorize_commerce_claim_issuance',
      'claim_guest_purchases_after_authorization'
    ]) {
      expect(migration).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION "public"\\."${name}"[\\s\\S]+TO "pale_orbit_runtime"`,
        'u'
      ));
    }
    expect(migration).not.toMatch(/pale_orbit_claim_executor|DATABASE_CLAIM_/u);
  });

  it('captures one wall-clock instant per issuance lifecycle routine', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');
    for (const [name, instant] of [
      ['purge_commerce_claim_issuances', 'purged_at'],
      ['register_commerce_claim_issuance', 'registered_at'],
      ['authorize_commerce_claim_issuance', 'promotion_at'],
      ['claim_guest_purchases_after_authorization', 'claim_at']
    ] as const) {
      const definition = functionDefinition(migration, name);
      expect(definition).toContain(
        `${instant} timestamp with time zone := pg_catalog.clock_timestamp()`
      );
      expect(definition).not.toContain('pg_catalog.transaction_timestamp()');
      expect(definition.match(/pg_catalog\.clock_timestamp\(\)/gu)).toHaveLength(1);
    }
  });

  it('uses SQL special expressions without schema qualification', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');

    expect(migration).not.toMatch(/pg_catalog\.(?:coalesce|greatest|least|nullif)\(/iu);
    expect(migration.match(/\bcoalesce\(/giu)).toHaveLength(10);
    expect(migration.match(/\bgreatest\(/giu)).toHaveLength(3);
  });

  it('keeps entitlement projection loop variables distinct from title_id columns', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');

    expect(migration).toContain('current_title_id uuid;');
    expect(migration.match(/FOR current_title_id IN/gu)).toHaveLength(2);
    expect(migration).not.toMatch(/\btitle_id uuid;/u);
    expect(migration).not.toMatch(/FOR title_id IN/u);
    expect(migration).not.toMatch(/\.title_id\s*=\s*title_id\b/u);
  });

  it('cancels inherited column ACLs on protected claim and outbox data', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');
    const outboxMetadata = functionDefinition(
      migration,
      'outbox_message_deduplication_metadata'
    );
    const guestIdentityUpdateGuard = functionDefinition(
      migration,
      'plan6b_guard_guest_identity_update'
    );

    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE "public"\."guest_identities"\s+FROM "pale_orbit_runtime", "pale_orbit_financial_worker"/u
    );
    expect(migration).toMatch(
      /GRANT INSERT \("email"\) ON TABLE "public"\."guest_identities"\s+TO "pale_orbit_runtime"/u
    );
    expect(migration).toMatch(
      /GRANT UPDATE \("updated_at"\) ON TABLE "public"\."guest_identities"\s+TO "pale_orbit_runtime"/u
    );
    expect(migration).not.toMatch(
      /GRANT INSERT ON TABLE "public"\."guest_identities" TO "pale_orbit_financial_worker"/u
    );
    for (const table of [
      'refund_allocation_drafts',
      'refund_allocation_draft_items',
      'refund_allocations',
      'refund_allocation_components',
      'refund_reporting_correction_sets',
      'refund_reporting_correction_items',
      'dispute_item_allocations',
      'stripe_payout_balance_transactions',
      'stripe_balance_transaction_fee_details',
      'financial_classification_versions',
      'financial_allocation_sets',
      'financial_item_allocations',
      'payout_import_run_entries'
    ]) {
      expect(migration).toMatch(new RegExp(
        `GRANT UPDATE \\("id"\\) ON TABLE "public"\\."${table}"\\s+TO "pale_orbit_financial_worker"`,
        'u'
      ));
    }
    expect(guestIdentityUpdateGuard).toContain("SET search_path = 'pg_catalog'");
    expect(guestIdentityUpdateGuard).toContain(
      "'public.claim_guest_purchases_after_authorization(text,text)'"
    );
    expect(guestIdentityUpdateGuard).toMatch(
      /pg_catalog\.pg_get_userbyid[\s\S]+current_user = claim_owner/u
    );
    expect(guestIdentityUpdateGuard).toContain(
      "pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')"
    );
    expect(guestIdentityUpdateGuard).toContain("ERRCODE = '42501'");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION "public"\."plan6b_guard_guest_identity_update"\(\) FROM PUBLIC/u
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "guest_identities_plan6b_update_guard"\s+BEFORE UPDATE ON "public"\."guest_identities"/u
    );
    expect(outboxMetadata).toMatch(/RETURNS TABLE \(\s*id uuid\s*\)/u);
    expect(outboxMetadata).not.toMatch(
      /dispatch_job_id|status text|last_error|delivered_at|created_at|updated_at/u
    );
    expect(migration).toMatch(
      /REVOKE SELECT \(\s*"payload"\s*\) ON TABLE "public"\."outbox_messages"\s+FROM PUBLIC, "pale_orbit_runtime"/u
    );
    for (const column of [
      'claim_proof_sha256',
      'auth_token_sha256',
      'normalized_email',
      'anchor_order_id',
      'kind',
      'state',
      'authorized_user_id',
      'issued_at',
      'expires_at',
      'authorized_at',
      'consumed_at',
      'result_disposition',
      'result_changed',
      'result_order_count',
      'result_title_count'
    ]) {
      expect(migration).toMatch(new RegExp(
        `REVOKE SELECT \\([\\s\\S]*?"${column}"[\\s\\S]*?\\) ON TABLE "public"\\."commerce_claim_issuances"[\\s\\S]*?FROM PUBLIC`,
        'u'
      ));
    }
  });

  it('backs lock-only financial id privileges with immutable transition guards', () => {
    const financialMigration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');
    const claimMigration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');
    const draftGuard = functionDefinition(
      financialMigration,
      'plan6b_validate_refund_draft_transition'
    );
    const draftItemGuard = functionDefinition(
      financialMigration,
      'plan6b_validate_refund_draft_item_transition'
    );

    expect(draftGuard).toContain('NEW.id IS DISTINCT FROM OLD.id');
    expect(draftItemGuard).toContain('NEW.id IS DISTINCT FROM OLD.id');
    for (const table of [
      'refund_allocations',
      'refund_allocation_components',
      'refund_reporting_correction_sets',
      'refund_reporting_correction_items',
      'dispute_item_allocations',
      'stripe_payout_balance_transactions',
      'stripe_balance_transaction_fee_details',
      'financial_classification_versions',
      'financial_allocation_sets',
      'financial_item_allocations'
    ]) {
      expect(financialMigration).toMatch(new RegExp(
        `CREATE TRIGGER "${table}_(?:immutable|narrow_update)"[\\s\\S]+?ON "${table}"[\\s\\S]+?EXECUTE FUNCTION "public"\\."plan6b_reject_history_mutation"\\(\\)`,
        'u'
      ));
    }
    expect(claimMigration).toMatch(
      /CREATE TRIGGER "payout_import_run_entries_immutable"\s+BEFORE UPDATE OR DELETE ON "public"\."payout_import_run_entries"\s+FOR EACH ROW EXECUTE FUNCTION "public"\."plan6b_reject_history_mutation"\(\)/u
    );
  });

  it('reserves aggregate-only guest-claim audits for the exact claim definer path', () => {
    const migration = source('../drizzle/0010_plan6b_guest_claim_authority.sql');
    const guard = functionDefinition(migration, 'plan6b_guard_audit_insert');

    expect(guard).toContain('commerce.guest_claimed');
    expect(guard).toContain(
      "'public.claim_guest_purchases_after_authorization(text,text)'"
    );
    expect(guard).toMatch(/pg_catalog\.pg_get_userbyid[\s\S]+current_user/u);
    expect(guard).toContain("NEW.actor_type = 'user'");
    expect(guard).toContain("NEW.outcome = 'succeeded'");
    expect(guard).toContain("NEW.resource_type = 'guest_identity'");
    expect(guard).toContain('NEW.request_metadata IS NULL');
    expect(guard).toContain('NEW.before IS NULL');
    expect(guard).toContain("'claimedOrderCount'");
    expect(guard).toContain("'claimedTitleCount'");
    expect(guard).toContain("ERRCODE = '42501'");
  });

  it('uses an independent proof bridge and removes forgeable claim authorization markers', () => {
    const options = source('../src/lib/server/auth/options.ts');
    const authorization = source('../src/lib/server/auth/commerce-claim-authorization.ts');
    const capability = source('../src/lib/server/auth/commerce-claim-capability.ts');
    const claimEmail = source('../src/lib/server/commerce/claim-email.ts');
    const bridge = source('../src/routes/claim/authorize/+server.ts');
    const completion = source('../src/routes/claim/complete/+page.server.ts');
    const claims = source('../src/lib/server/commerce/claims.ts');

    expect(options).toContain('createCommerceClaimProofToken');
    expect(options).toContain('registerCommerceClaimIssuance');
    expect(options).toContain('wrapCommerceClaimActionUrl');
    expect(options).toContain('authorizeCommerceClaimIssuance');
    expect(options).toContain('COMMERCE_CLAIM_PROOF_COOKIE');
    expect(options).toContain('claimProofSha256');
    expect(options).toContain('authTokenSha256');
    expect(options).toContain('anchorOrderId');
    expect(options).toMatch(/claimProof[\s\S]+authToken[\s\S]+authorizeCommerceClaimIssuance/u);

    expect(authorization).not.toContain('pale-orbit:commerce-claim-authorization:');
    expect(authorization).not.toContain('insertAuthorization(');
    expect(authorization).not.toContain('consumeCommerceClaimAuthorizationInTransaction');

    expect(claimEmail).toMatch(
      /reset-password\?purpose=commerce-claim(?:&|&amp;)orderId=/u
    );
    expect(bridge).toContain("'cache-control': 'no-store'");
    expect(bridge).toContain("'referrer-policy': 'same-origin'");
    expect(bridge).toContain("'content-security-policy'");
    expect(bridge).toContain('window.location.hash');
    expect(bridge).toContain("history.replaceState(null, '', '/claim/authorize')");
    expect(bridge).toContain("form.method = 'post'");
    expect(bridge.indexOf("history.replaceState(null, '', '/claim/authorize')"))
      .toBeLessThan(bridge.indexOf('form.submit()'));
    expect(bridge).toContain("request.headers.get('origin') !== trustedOrigin");
    expect(bridge).toContain('COMMERCE_CLAIM_BRIDGE_NONCE_COOKIE');
    expect(capability).toContain('bridge.hash = payload.toString()');
    expect(capability).not.toMatch(/bridge\.searchParams\.set\(['"](?:proof|action)/u);
    expect(bridge).toContain('httpOnly: true');
    expect(bridge).toContain("sameSite: 'lax'");
    expect(bridge).toContain("path: '/'");
    expect(bridge).toContain("environment === 'production'");
    expect(bridge).toMatch(/throw redirect\(303,/u);
    expect(bridge).not.toMatch(/console\.(?:log|info|error)/u);

    expect(completion).toContain('claimGuestPurchasesAfterAuthorization');
    expect(completion).not.toMatch(/userId:\s*locals\.actor\.id/u);
    expect(claims).not.toMatch(/\.update\(entitlementGrants\)|\.update\(guestIdentities\)/u);
  });

  it('keeps claim-email delivery on the global identity-before-order lock sequence', () => {
    const claimEmail = source('../src/lib/server/commerce/claim-email.ts');
    const queue = claimEmail.slice(
      claimEmail.indexOf('export async function queueCommerceClaimEmail'),
      claimEmail.indexOf('export type ClaimEmailAccountState')
    );

    expect(queue).toMatch(
      /select\(\{ guestIdentityId: orders\.guestIdentityId \}\)[\s\S]+\.from\(guestIdentities\)[\s\S]+\.for\('update'\)[\s\S]+\.from\(orders\)[\s\S]+\.for\('update'\)/u
    );
  });

  it('carries the valid 0006 upgrade through 0015 while isolating claim preflights at 0010', () => {
    const upgrade = source('../tests/integration/financial-migration.test.ts');
    const journal = JSON.parse(source('../drizzle/meta/_journal.json')) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(journal.entries).toHaveLength(16);
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 15,
      tag: '0015_plan7a_operations_authority'
    });
    expect(upgrade).toContain(
      'maxMigrationIndex: 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15'
    );
    const validFixture = upgrade.slice(
      upgrade.indexOf('async function runValidFixture'),
      upgrade.indexOf('async function runInvalidFixture')
    );
    expect(validFixture).toMatch(
      /createMigrationFolderThrough\(11\)[\s\S]+migrationCount\(pool\), 12/u
    );
    expect(validFixture).toContain('assertStorageCleanupAuthorityUpgrade(pool)');
    expect(validFixture).toContain('await runRepairedFixtureThroughPlan6biiHead(pool');
    const repairedHead = upgrade.slice(
      upgrade.indexOf('async function runRepairedFixtureThroughPlan6biiHead'),
      upgrade.indexOf('async function plan6biiIssueTransitionCatalogState')
    );
    expect(repairedHead).toContain('createMigrationFolderThrough(15)');
    expect(repairedHead).toContain("equal(await migrationCount(pool), 16");
    expect(repairedHead).toContain('second 0015 migration pass is a no-op');

    for (const [startMarker, endMarker] of [
      ['async function runClaimAuthorityInvalidFixture',
        'async function runClaimIdentityAuthorityInvalidFixture'],
      ['async function runClaimIdentityAuthorityInvalidFixture',
        'async function runEntitlementProjectionInvalidFixture'],
      ['async function runEntitlementProjectionInvalidFixture',
        'async function main']
    ] as const) {
      const fixture = upgrade.slice(upgrade.indexOf(startMarker), upgrade.indexOf(endMarker));
      const repairedHeadIndex = fixture.indexOf('runRepairedFixtureThroughPlan6biiHead');
      expect(repairedHeadIndex, startMarker).toBeGreaterThanOrEqual(0);
      const isolated0010Proof = fixture.slice(0, repairedHeadIndex);
      expect(isolated0010Proof).toMatch(
        /createMigrationFolderThrough\(10\)[\s\S]+migrationCount\(pool\), 11/u
      );
      expect(isolated0010Proof).not.toMatch(/createMigrationFolderThrough\(1[1-5]\)/u);
    }
    expect(upgrade).toContain('legacy-claimed-guest-null-grant');
    expect(upgrade).toContain('legacy-paid-guest-missing-grant');
    expect(upgrade).toContain('legacy-claimed-identity-authority');
    expect(upgrade).toContain('legacy-entitlement-projection');
    expect(upgrade).toContain('runClaimAuthorityInvalidFixture');
    expect(upgrade).toContain('runClaimIdentityAuthorityInvalidFixture');
    expect(upgrade).toContain('runEntitlementProjectionInvalidFixture');
  });
});
