import type { ApplicationRole } from '$lib/types/auth';
import type { FinancialAdminCommandKind } from '$lib/types/financial-reporting';

export type { ApplicationRole } from '$lib/types/auth';
export type AdminCapability =
  | 'admin.access'
  | 'catalog.manage'
  | 'roles.manage'
  | 'audit.read'
  | 'jobs.retry'
  | 'sales.read'
  | 'sales.export'
  | 'reconciliation.manage';

export const CAPABILITIES_BY_ROLE: Readonly<
  Record<ApplicationRole, ReadonlySet<AdminCapability>>
> = {
  customer: new Set<AdminCapability>(),
  admin: new Set<AdminCapability>([
    'admin.access',
    'catalog.manage',
    'roles.manage',
    'audit.read',
    'jobs.retry',
    'sales.read',
    'sales.export',
    'reconciliation.manage'
  ])
};

export function capabilitiesForRoles(
  roles: readonly ApplicationRole[]
): ReadonlySet<AdminCapability> {
  const capabilities = new Set<AdminCapability>();
  for (const role of roles) {
    for (const capability of CAPABILITIES_BY_ROLE[role]) capabilities.add(capability);
  }
  return capabilities;
}

export type CapabilityResolver = (
  roles: readonly ApplicationRole[]
) => ReadonlySet<AdminCapability>;

export interface FinancialAuthorizationDependencies {
  readonly capabilityResolver?: CapabilityResolver;
}

export const FINANCIAL_ADMIN_COMMAND_CAPABILITIES: Readonly<
  Record<FinancialAdminCommandKind, readonly ['sales.read', 'reconciliation.manage']>
> = {
  refund_draft_save: ['sales.read', 'reconciliation.manage'],
  refund_draft_discard: ['sales.read', 'reconciliation.manage'],
  refund_allocation_finalize: ['sales.read', 'reconciliation.manage'],
  refund_reporting_correction_create: ['sales.read', 'reconciliation.manage'],
  administrative_recovery_activate: ['sales.read', 'reconciliation.manage'],
  administrative_recovery_deactivate: ['sales.read', 'reconciliation.manage']
};

export type Actor =
  | { type: 'anonymous' }
  | { type: 'guest'; id: string }
  | { type: 'system'; id: string }
  | { type: 'user'; id: string; roles: readonly ApplicationRole[] };

export type AdministratorActor = Extract<Actor, { type: 'user' }> & {
  roles: readonly ApplicationRole[];
};

export class AuthorizationError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'forbidden',
    readonly status: 401 | 403
  ) {
    super(code);
    this.name = 'AuthorizationError';
  }
}

export function requireCapability(
  actor: Actor,
  capability: AdminCapability,
  capabilityResolver: CapabilityResolver = capabilitiesForRoles
): asserts actor is AdministratorActor {
  if (actor.type === 'anonymous') {
    throw new AuthorizationError('unauthenticated', 401);
  }
  if (actor.type !== 'user' || !capabilityResolver(actor.roles).has(capability)) {
    throw new AuthorizationError('forbidden', 403);
  }
}

export function requireFinancialServiceCapability(
  actor: Actor,
  capability: AdminCapability,
  dependencies: FinancialAuthorizationDependencies = {}
): asserts actor is AdministratorActor {
  requireCapability(actor, capability, dependencies.capabilityResolver);
}

function requireFinancialCommandCapabilities(
  actor: Actor,
  kind: FinancialAdminCommandKind,
  dependencies: FinancialAuthorizationDependencies
): asserts actor is AdministratorActor {
  for (const capability of FINANCIAL_ADMIN_COMMAND_CAPABILITIES[kind]) {
    requireCapability(actor, capability, dependencies.capabilityResolver);
  }
}

export function requireFinancialCommandSubmissionCapabilities(
  actor: Actor,
  kind: FinancialAdminCommandKind,
  dependencies: FinancialAuthorizationDependencies = {}
): asserts actor is AdministratorActor {
  requireFinancialCommandCapabilities(actor, kind, dependencies);
}

export function requireFinancialCommandExecutionCapabilities(
  actor: Actor,
  kind: FinancialAdminCommandKind,
  dependencies: FinancialAuthorizationDependencies = {}
): asserts actor is AdministratorActor {
  requireFinancialCommandCapabilities(actor, kind, dependencies);
}
