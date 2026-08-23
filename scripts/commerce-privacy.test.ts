import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  FINANCIAL_REPORTING_DTO_KEYSETS,
  REFERENCE_DTO_KEYS,
  STATUS_DTO_KEYS
} from '../src/lib/types/financial-reporting';
import { renderCommerceEmail } from '../src/lib/server/commerce/email/render';
import { parseCommerceEmailPayload } from '../src/lib/server/commerce/email/payload';
import { assertCommercePrivacy } from '../tests/e2e/commerce-privacy';

const financialSurfaces = [
  'financial html',
  'financial json',
  'financial csv',
  'financial status',
  'financial safe result',
  'financial audit',
  'financial email',
  'financial log',
  'financial browser',
  'financial restore'
] as const;

const financialSensitiveKeys = [
  'privateInput',
  'privateCommand',
  'commandInput',
  'idempotencyKey',
  'idempotencyKeySha256',
  'inputFingerprintSha256',
  'jobId',
  'jobPayload',
  'attempts',
  'maxAttempts',
  'financialAdminLeaseCapability',
  'leaseCapability',
  'capabilityDigest',
  'capabilitySha256',
  'financialAdminLeaseCapabilitySha256',
  'generation',
  'leaseGeneration',
  'expiresAt',
  'leaseExpiresAt',
  'lastError',
  'last_error',
  'providerRequest',
  'providerResponse',
  'providerBody',
  'providerId',
  'providerEventId',
  'providerPayoutId',
  'providerRefundId',
  'providerTransactionId',
  'stripePaymentIntentId',
  'stripeChargeId',
  'stripeRefundId',
  'stripeDisputeId',
  'stripePayoutId',
  'claimProof',
  'authToken',
  'password',
  'passwordResetToken',
  'resetToken',
  'magicLinkToken',
  'statusTokenSha256',
  'ipAddress',
  'userAgent',
  'sqlError',
  'stack',
  'stackTrace',
  'databaseRole',
  'filesystemPath'
] as const;

describe('commerce privacy evidence helper', () => {
  it('accepts safe commerce evidence', () => {
    expect(() => assertCommercePrivacy('account database', {
      paymentMethodCategory: 'card',
      rawBodySha256: '0'.repeat(64),
      amountMinor: 1299
    })).not.toThrow();
  });

  it.each([
    'secret',
    'signature',
    'stripeSignature',
    'rawBody',
    'rawEvent',
    'billingAddress',
    'shippingAddress',
    'cardNumber',
    'cardLast4',
    'cardBrand',
    'last4',
    'brand',
    'billing_details',
    'email',
    'customer',
    'card',
    'payment_method',
    'address',
    'receipt_url',
    'description',
    'destination',
    'metadata',
    'payment_method_details',
    'client_secret',
    'raw_object',
    'provider_message'
  ])('rejects the sensitive key %s', (key) => {
    expect(() => assertCommercePrivacy('guest browser', { [key]: 'private-value' }))
      .toThrow('Sensitive commerce data detected on guest browser');
  });

  it.each(financialSensitiveKeys)('rejects the financial-artifact key %s', (key) => {
    expect(() => assertCommercePrivacy('financial browser', { [key]: 'private-value' }))
      .toThrow('Sensitive commerce data detected on financial browser');
  });

  it.each([
    '{"private_input":{"kind":"refund_draft_save"}}',
    '{\\"job_id\\":\\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\"}',
    'last_error: internal failure',
    '{"provider_payout_id":"po_plan6biiPrivate"}',
    '{"financial_admin_lease_capability":"private"}'
  ])('rejects serialized sensitive keys without requiring JSON parsing', (artifact) => {
    expect(() => assertCommercePrivacy('financial json', artifact))
      .toThrow('Sensitive commerce data detected on financial json');
  });

  it.each(financialSurfaces)('rejects private job structure from %s artifacts', (surface) => {
    expect(() => assertCommercePrivacy(surface, {
      publicEnvelope: { jobPayload: { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }
    })).toThrow(`Sensitive commerce data detected on ${surface}`);
  });

  it('rejects provider secrets, test card values, and journey-specific private values', () => {
    for (const value of [
      'sk_test_private',
      'sk_live_private',
      'rk_test_private',
      'rk_live_private',
      'whsec_private',
      '-----BEGIN PRIVATE KEY-----',
      '4242',
      'customer-private@example.com',
      'Bearer plan6bii-private-token',
      '203.0.113.42',
      'Mozilla/5.0 (Plan6BII privacy sentinel)',
      'SQLSTATE 42501: permission denied',
      'Error: private failure\n    at execute (C:\\private\\worker.ts:12:3)',
      'pale_orbit_financial_worker',
      '/run/secrets/database_worker_password',
      'C:\\private\\financial-admin.json'
    ]) {
      expect(() => assertCommercePrivacy(
        'lifecycle console',
        { message: value }
      )).toThrow('Sensitive commerce data detected on lifecycle console');
    }
  });

  it('never includes sensitive keys or values in its failure message', () => {
    const privateValue = 'whsec_do-not-print';
    let failure = '';
    try {
      assertCommercePrivacy('account response', {
        client_secret: privateValue
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe('Sensitive commerce data detected on account response');
    expect(failure).not.toContain('client_secret');
    expect(failure).not.toContain(privateValue);
  });

  it('inspects non-enumerable Error messages, stacks, and causes', () => {
    const privateValue = `private-error-${randomBytes(16).toString('hex')}`;
    const cause = new Error(`hidden ${privateValue}`);
    delete cause.stack;
    const nested = new Error('safe outer error', { cause });
    delete nested.stack;
    expect(Object.hasOwn(cause, 'stack')).toBe(false);
    expect(Object.hasOwn(nested, 'stack')).toBe(false);
    expect(() => assertCommercePrivacy(
      'financial log',
      { captured: nested },
      [privateValue]
    )).toThrow('Sensitive commerce data detected on financial log');
  });

  it('inspects enumerable custom Error fields even when the stack is unavailable', () => {
    const privateValue = `custom-error-${randomBytes(16).toString('hex')}`;
    const error = Object.assign(new Error('safe financial failure'), {
      diagnostic: `hidden ${privateValue}`
    });
    delete error.stack;
    expect(Object.hasOwn(error, 'stack')).toBe(false);
    expect(() => assertCommercePrivacy(
      'financial log',
      { captured: error },
      [privateValue]
    ))
      .toThrow('Sensitive commerce data detected on financial log');
  });

  it('inspects non-enumerable custom Error fields without invoking accessors', () => {
    const privateValue = `hidden-error-${randomBytes(16).toString('hex')}`;
    const error = new Error('safe financial failure');
    delete error.stack;
    Object.defineProperty(error, 'cause', {
      get: () => {
        throw new Error('The privacy scanner must not invoke Error accessors');
      },
      enumerable: false
    });
    Object.defineProperty(error, 'diagnostic', {
      value: `hidden ${privateValue}`,
      enumerable: false
    });
    expect(Object.hasOwn(error, 'stack')).toBe(false);
    expect(() => assertCommercePrivacy(
      'financial log',
      { captured: error },
      [privateValue]
    ))
      .toThrow('Sensitive commerce data detected on financial log');
  });

  it('inspects the non-enumerable errors collection on AggregateError', () => {
    const privateValue = `aggregate-private-${randomBytes(16).toString('hex')}`;
    const nested = new Error(`hidden ${privateValue}`);
    delete nested.stack;
    const aggregate = new AggregateError([nested], 'safe aggregate failure');
    delete aggregate.stack;
    expect(Object.hasOwn(nested, 'stack')).toBe(false);
    expect(Object.hasOwn(aggregate, 'stack')).toBe(false);
    expect(() => assertCommercePrivacy(
      'financial log',
      { captured: aggregate },
      [privateValue]
    )).toThrow('Sensitive commerce data detected on financial log');
  });

  it.each([
    'pale_orbit_runtime',
    'pale_orbit_financial_worker',
    'pale_orbit_owner',
    'pale_orbit_storage_cleanup',
    'pale_orbit_storage_cleanup_login',
    'pale_orbit_web',
    'pale_orbit_worker',
    'pale_orbit_worker_login',
    'pale_orbit_test',
    'pale_orbit_test_web',
    'pale_orbit_test_worker',
    'pale_orbit_test_storage_cleanup',
    'pale_orbit_fixture_web',
    'pale_orbit_fixture_worker',
    'pale_orbit_fixture_storage_cleanup',
    'pale_orbit_rehearsal_web',
    'pale_orbit_rehearsal_worker',
    'pale_orbit_rehearsal_owner',
    'pale_orbit_rehearsal_cleanup'
  ])('rejects the database role name %s from financial artifacts', (roleName) => {
    expect(() => assertCommercePrivacy('financial log', { message: roleName }))
      .toThrow('Sensitive commerce data detected on financial log');
  });

  it.each([
    '/app/server/worker.js',
    'C:/private/financial-admin.json'
  ])('rejects the filesystem path %s from deployed artifacts', (path) => {
    expect(() => assertCommercePrivacy('financial log', { message: path }))
      .toThrow('Sensitive commerce data detected on financial log');
  });

  it.each(financialSurfaces)(
    'rejects a fresh lease bearer and its digest from %s artifacts without disclosing either',
    (surface) => {
      const capability = randomBytes(32).toString('base64url');
      const digest = createHash('sha256').update(capability, 'utf8').digest('hex');
      for (const privateValue of [capability, digest]) {
        let failure = '';
        try {
          assertCommercePrivacy(surface, { artifact: `prefix:${privateValue}:suffix` }, [
            capability,
            digest
          ]);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        expect(failure).toBe(`Sensitive commerce data detected on ${surface}`);
        expect(failure).not.toContain(capability);
        expect(failure).not.toContain(digest);
      }
    }
  );

  it('allows the explicitly named internal financial identifiers and reporting generations', () => {
    expect(() => assertCommercePrivacy('financial json', {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      paymentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      refundId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      disputeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      payoutId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      orderItemId: '11111111-1111-4111-8111-111111111111',
      correctionSetId: '22222222-2222-4222-8222-222222222222',
      recoveryGrantId: '33333333-3333-4333-8333-333333333333',
      financialGeneration: 7,
      membershipGeneration: 3,
      sourceFingerprint: '0'.repeat(64)
    })).not.toThrow();
  });

  it('keeps fixture administrator-command evidence boolean-only and free of private state', async () => {
    const fixture = await readFile(
      new URL('./plan6b-fixture-runtime-probe.ts', import.meta.url),
      'utf8'
    );
    const evidenceInterface = fixture.match(
      /export interface FixtureProbeEvidence \{([\s\S]*?)\n\}/u
    )?.[1] ?? '';
    const safeAdministratorEvidence = [
      'administratorCommandSucceeded',
      'administratorWorkerClaimObserved',
      'administratorSalesReflectionObserved',
      'administratorAuditReflectionObserved',
      'webPrivateInputDenied',
      'webDraftMutationDenied'
    ] as const;

    for (const key of safeAdministratorEvidence) {
      expect(evidenceInterface).toContain(`readonly ${key}: boolean;`);
    }
    for (const key of financialSensitiveKeys) {
      expect(evidenceInterface).not.toMatch(new RegExp(`\\b${key}\\b`, 'u'));
    }
    expect(evidenceInterface).not.toMatch(
      /(?:actor|customer|email|reason|commandId|jobId|refundId|draftId|auditId)\s*:/iu
    );
  });

  it('allows canonical provider identifiers only on the existing server-side database surface', () => {
    expect(() => assertCommercePrivacy('lifecycle database', {
      stripePaymentIntentId: 'pi_serverOnlyEvidence',
      stripeRefundId: 're_serverOnlyEvidence'
    })).not.toThrow();
  });

  it('keeps every Plan 6B-II browser and CSV DTO keyset structurally privacy-safe', () => {
    for (const [name, keys] of Object.entries({
      ...FINANCIAL_REPORTING_DTO_KEYSETS,
      commandReference: REFERENCE_DTO_KEYS,
      commandStatus: STATUS_DTO_KEYS
    })) {
      expect(
        () => assertCommercePrivacy(
          name === 'salesCsvRow' ? 'financial csv' : 'financial json',
          Object.fromEntries(keys.map((key) => [key, null]))
        ),
        name
      ).not.toThrow();
    }
  });

  it('does not mistake a canonical public UUID segment for test-card evidence', () => {
    for (const titleId of [
      'aaaaaaaa-4242-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4242-8bbb-bbbbbbbbbbbb'
    ]) {
      expect(() => assertCommercePrivacy('sales csv', {
        body: `Public title,${titleId},prose`
      })).not.toThrow();
    }

    for (const cardEvidence of ['4242', 'Card ending in 4242', '4242 4242 4242 4242']) {
      expect(() => assertCommercePrivacy('sales csv', { body: cardEvidence }))
        .toThrow('Sensitive commerce data detected on sales csv');
    }
  });

  it.each([
    'pi_plan6biiPrivate',
    'ch_plan6biiPrivate',
    're_plan6biiPrivate',
    'dp_plan6biiPrivate',
    'po_plan6biiPrivate',
    'txn_plan6biiPrivate',
    'evt_plan6biiPrivate',
    'cus_plan6biiPrivate',
    'pm_plan6biiPrivate'
  ])('rejects the provider object value %s from financial artifacts', (providerId) => {
    expect(() => assertCommercePrivacy('financial log', { message: providerId }))
      .toThrow('Sensitive commerce data detected on financial log');
  });

  it('keeps recovery email render artifacts free of recipient and worker-only values', () => {
    const recipient = 'privacy-recipient@example.com';
    const capability = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(capability, 'utf8').digest('hex');
    const rendered = renderCommerceEmail(parseCommerceEmailPayload({
      version: 1,
      template: 'commerce.administrative-recovery-access-changed',
      to: recipient,
      messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      soldAsTitle: 'Privacy-safe title',
      accessState: 'active'
    }, 'https://bookstore.example'));

    expect(() => assertCommercePrivacy(
      'financial email',
      rendered,
      [recipient, capability, digest]
    )).not.toThrow();
  });

  it('keeps Plan 6B-II HTML, browser, status, and audit serializers free of worker-only fields', async () => {
    const browserPaths = [
      '../src/lib/components/admin/AdministrativeRecoveryActions.svelte',
      '../src/lib/components/admin/FinancialActionOutcome.svelte',
      '../src/lib/components/admin/FinancialCommandStatus.svelte',
      '../src/lib/components/admin/PayoutTable.svelte',
      '../src/lib/components/admin/RefundAllocationEditor.svelte',
      '../src/lib/components/admin/ReportingCorrectionEditor.svelte',
      '../src/lib/components/admin/ReviewQueue.svelte',
      '../src/lib/components/admin/SalesFilters.svelte',
      '../src/lib/components/admin/SalesSummaryCards.svelte',
      '../src/lib/components/admin/SalesTable.svelte',
      '../src/routes/admin/sales/+layout.svelte',
      '../src/routes/admin/sales/+page.svelte',
      '../src/routes/admin/sales/payouts/[payoutId]/+page.svelte',
      '../src/routes/admin/sales/payouts/+page.svelte',
      '../src/routes/admin/sales/refunds/[refundId]/+page.svelte',
      '../src/routes/admin/sales/review/[issueId]/+page.svelte',
      '../src/routes/admin/sales/review/+page.svelte'
    ];
    const [statusRoute, auditClient, ...browserSources] = await Promise.all([
      readFile(
        new URL('../src/routes/admin/sales/commands/[commandId]/+server.ts', import.meta.url),
        'utf8'
      ),
      readFile(
        new URL('../src/lib/server/commerce/reporting/audit.ts', import.meta.url),
        'utf8'
      ),
      ...browserPaths.map((path) => readFile(new URL(path, import.meta.url), 'utf8'))
    ]);
    const forbiddenArtifactField =
      /financialAdminLeaseCapability|capabilityDigest|(?:^|\W)jobId(?:\W|$)|jobPayload|last_error|lastError|stripe(?:PaymentIntent|Charge|Refund|Dispute|Payout)Id|provider(?:Event|Payout|Refund|Transaction)?Id/iu;

    expect(statusRoute).toContain('privateJson(parseFinancialAdminCommandStatus(status))');
    expect(statusRoute.match(forbiddenArtifactField)?.[0] ?? null).toBeNull();
    expect(auditClient.match(forbiddenArtifactField)?.[0] ?? null).toBeNull();
    browserSources.forEach((browserSource, index) => {
      expect(
        browserSource.match(forbiddenArtifactField)?.[0] ?? null,
        browserPaths[index]
      ).toBeNull();
    });
  });

  it('keeps customer identity and token fields out of financial purchase-lock queries', async () => {
    const [rebase, payment, refund] = await Promise.all([
      readFile(new URL('../src/lib/server/commerce/financial/rebase.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/lib/server/commerce/financial/sources/payment.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/lib/server/commerce/financial/sources/refund.ts', import.meta.url), 'utf8')
    ]);
    const forbidden = /guest_identity_id|purchase_email|status_token_sha256/u;

    expect(rebase.match(/select id, status,[\s\S]*?from orders where id =/u)?.[0]).not.toMatch(forbidden);
    expect(payment).not.toMatch(/\.select\(\)\.from\(orders\)/u);
    expect(refund).not.toMatch(/\.select\(\)\.from\(orders\)/u);
  });
});
