export type ApplicationRole = 'customer' | 'admin';
export type AdminCapability = 'catalog.manage' | 'audit.read' | 'jobs.retry';

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
  _capability: AdminCapability
): asserts actor is AdministratorActor {
  if (actor.type === 'anonymous') {
    throw new AuthorizationError('unauthenticated', 401);
  }
  if (actor.type !== 'user' || !actor.roles.includes('admin')) {
    throw new AuthorizationError('forbidden', 403);
  }
}
