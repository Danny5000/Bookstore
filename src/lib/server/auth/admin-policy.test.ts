import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CAPABILITIES_BY_ROLE,
  FINANCIAL_ADMIN_COMMAND_CAPABILITIES,
  AuthorizationError,
  capabilitiesForRoles,
  requireCapability,
  requireFinancialCommandExecutionCapabilities,
  requireFinancialCommandSubmissionCapabilities,
  requireFinancialServiceCapability,
  type Actor,
  type AdminCapability,
  type ApplicationRole,
  type CapabilityResolver
} from './admin-policy';

describe('requireCapability', () => {
  it('allows an administrator to manage catalog records', () => {
    const actor: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
    expect(() => requireCapability(actor, 'catalog.manage')).not.toThrow();
  });

  it.each(['admin.access', 'roles.manage'] as const)(
    'allows an administrator to use %s',
    (capability) => {
      const actor: Actor = { type: 'user', id: 'admin-1', roles: ['customer', 'admin'] };
      expect(() => requireCapability(actor, capability)).not.toThrow();
    }
  );

  it.each(['sales.read', 'sales.export', 'reconciliation.manage'] as const)(
    'allows an administrator to use the independent %s capability',
    (capability) => {
      const actor: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
      expect(() => requireCapability(actor, capability)).not.toThrow();
    }
  );

  it('rejects an anonymous actor as unauthenticated', () => {
    expect(() => requireCapability({ type: 'anonymous' }, 'audit.read')).toThrow(
      new AuthorizationError('unauthenticated', 401)
    );
  });

  it('rejects a customer as forbidden', () => {
    const actor: Actor = { type: 'user', id: 'customer-1', roles: ['customer'] };
    expect(() => requireCapability(actor, 'jobs.retry')).toThrow(
      new AuthorizationError('forbidden', 403)
    );
  });

  it('does not treat a background system actor as an administrator', () => {
    expect(() =>
      requireCapability({ type: 'system', id: 'worker-1' }, 'catalog.manage')
    ).toThrow(AuthorizationError);
  });

  it('does not allow a guest to manage roles', () => {
    expect(() => requireCapability({ type: 'guest', id: 'guest-1' }, 'roles.manage')).toThrow(
      new AuthorizationError('forbidden', 403)
    );
  });

  it('consults the requested capability instead of treating the admin role as sufficient', () => {
    const actor: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
    const resolver: CapabilityResolver = () => new Set<AdminCapability>(['sales.read']);

    expect(() => requireCapability(actor, 'sales.read', resolver)).not.toThrow();
    expect(() => requireCapability(actor, 'sales.export', resolver)).toThrow(
      new AuthorizationError('forbidden', 403)
    );
  });
});

describe('admin capability policy', () => {
  const allCapabilities = [
    'admin.access',
    'catalog.manage',
    'roles.manage',
    'audit.read',
    'jobs.retry',
    'sales.read',
    'sales.export',
    'reconciliation.manage'
  ] as const satisfies readonly AdminCapability[];

  it('maps customers to no capabilities and administrators to all eight', () => {
    expectTypeOf(CAPABILITIES_BY_ROLE).toEqualTypeOf<
      Readonly<Record<ApplicationRole, ReadonlySet<AdminCapability>>>
    >();
    expect(CAPABILITIES_BY_ROLE.customer).toBeInstanceOf(Set);
    expect(CAPABILITIES_BY_ROLE.admin).toBeInstanceOf(Set);
    expect([...CAPABILITIES_BY_ROLE.customer]).toEqual([]);
    expect([...CAPABILITIES_BY_ROLE.admin]).toEqual(allCapabilities);
    expect([...capabilitiesForRoles(['customer'])]).toEqual([]);
    expect([...capabilitiesForRoles(['customer', 'admin'])]).toEqual(allCapabilities);
  });

  it('fixes every financial command kind to both read and reconciliation capabilities', () => {
    expect(FINANCIAL_ADMIN_COMMAND_CAPABILITIES).toEqual({
      refund_draft_save: ['sales.read', 'reconciliation.manage'],
      refund_draft_discard: ['sales.read', 'reconciliation.manage'],
      refund_allocation_finalize: ['sales.read', 'reconciliation.manage'],
      refund_reporting_correction_create: ['sales.read', 'reconciliation.manage'],
      administrative_recovery_activate: ['sales.read', 'reconciliation.manage'],
      administrative_recovery_deactivate: ['sales.read', 'reconciliation.manage']
    });
  });

  const newCapabilities = ['sales.read', 'sales.export', 'reconciliation.manage'] as const;
  const resolverWithout = (missing: AdminCapability): CapabilityResolver => () =>
    new Set<AdminCapability>(newCapabilities.filter((capability) => capability !== missing));

  it.each(newCapabilities)(
    'independently enforces %s at the reusable service boundary',
    (capability) => {
      const actor: Actor = { type: 'user', id: 'admin-service', roles: ['admin'] };

      expect(() =>
        requireFinancialServiceCapability(actor, capability, {
          capabilityResolver: resolverWithout(capability)
        })
      ).toThrow(new AuthorizationError('forbidden', 403));
    }
  );

  const commandBoundaryCases = Object.entries(FINANCIAL_ADMIN_COMMAND_CAPABILITIES).flatMap(
    ([kind, capabilities]) => capabilities.map((capability) => [capability, kind] as const)
  );

  it.each(commandBoundaryCases)(
    'independently enforces %s for %s at command submission',
    (capability, kind) => {
      const actor: Actor = { type: 'user', id: 'admin-submission', roles: ['admin'] };

      expect(() =>
        requireFinancialCommandSubmissionCapabilities(
          actor,
          kind as keyof typeof FINANCIAL_ADMIN_COMMAND_CAPABILITIES,
          { capabilityResolver: resolverWithout(capability) }
        )
      ).toThrow(new AuthorizationError('forbidden', 403));
    }
  );

  it.each(commandBoundaryCases)(
    'independently enforces %s for %s at command execution',
    (capability, kind) => {
      const actor: Actor = { type: 'user', id: 'admin-execution', roles: ['admin'] };

      expect(() =>
        requireFinancialCommandExecutionCapabilities(
          actor,
          kind as keyof typeof FINANCIAL_ADMIN_COMMAND_CAPABILITIES,
          { capabilityResolver: resolverWithout(capability) }
        )
      ).toThrow(new AuthorizationError('forbidden', 403));
    }
  );
});
