import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { runWithDiagnosticContext } from '$lib/server/observability/context';

const database = {};
vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: database })
}));
vi.mock('$lib/server/auth/roles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/auth/roles')>();
  return {
    ...actual,
    listUsersWithRoles: vi.fn(),
    setAdminRole: vi.fn()
  };
});

import { load as adminLayoutLoad } from '../+layout.server';
import { actions, load } from './+page.server';
import {
  LastAdministratorError,
  RoleTargetNotFoundError,
  listUsersWithRoles,
  setAdminRole
} from '$lib/server/auth/roles';

const setAdminAction = actions.setAdmin;
if (!setAdminAction) throw new Error('setAdmin action is required');

const admin: Actor = {
  type: 'user',
  id: randomUUID(),
  roles: ['customer', 'admin']
};
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };

function locals(actor: Actor) {
  return {
    actor,
    user:
      actor.type === 'user'
        ? {
            id: actor.id,
            name: 'Reader',
            email: 'reader@example.com',
            emailVerified: true,
            roles: actor.roles
          }
        : null,
    session: actor.type === 'user' ? { id: randomUUID(), userId: actor.id, expiresAt: new Date() } : null
  };
}

function actionEvent(
  actor: Actor,
  values: Record<string, string>,
  requestId?: string
) {
  const headers = new Headers();
  if (requestId) headers.set('x-request-id', requestId);
  return {
    locals: locals(actor),
    request: new Request('http://localhost/admin/users?/setAdmin', {
      method: 'POST',
      headers,
      body: new URLSearchParams(values)
    })
  };
}

describe('admin route protection', () => {
  it('redirects anonymous requests and rejects customers', () => {
    expect(() => adminLayoutLoad({ locals: locals({ type: 'anonymous' }) } as never)).toThrowError(
      expect.objectContaining({ status: 303, location: '/?auth=required' })
    );
    expect(() => adminLayoutLoad({ locals: locals(customer) } as never)).toThrowError(
      expect.objectContaining({ status: 403 })
    );
  });

  it('allows an administrator to load the admin tree and user list', async () => {
    vi.mocked(listUsersWithRoles).mockResolvedValue([]);
    expect(adminLayoutLoad({ locals: locals(admin) } as never)).toEqual({
      user: expect.objectContaining({ id: admin.id })
    });
    await expect(load({ locals: locals(admin) } as never)).resolves.toEqual({ users: [] });
  });
});

describe('setAdmin action', () => {
  it('rejects a forged customer submission before role mutation', async () => {
    const result = await setAdminAction(
      actionEvent(customer, { userId: randomUUID(), enabled: 'true' }) as never
    );
    expect(result).toMatchObject({ status: 403 });
    expect(setAdminRole).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { userId: 'not-a-uuid', enabled: 'true' },
    { userId: randomUUID(), enabled: 'sometimes' }
  ])('rejects invalid role input', async (values) => {
    const result = await setAdminAction(actionEvent(admin, values) as never);
    expect(result).toMatchObject({ status: 400 });
  });

  it('maps last-admin protection to a safe conflict', async () => {
    vi.mocked(setAdminRole).mockRejectedValueOnce(new LastAdministratorError());
    const result = await setAdminAction(
      actionEvent(admin, { userId: admin.id, enabled: 'false' }) as never
    );
    expect(result).toMatchObject({ status: 409 });
    expect(JSON.stringify(result)).not.toContain(admin.id);
  });

  it('maps a missing target to a safe not-found response', async () => {
    vi.mocked(setAdminRole).mockRejectedValueOnce(new RoleTargetNotFoundError());
    const result = await setAdminAction(
      actionEvent(admin, { userId: randomUUID(), enabled: 'true' }) as never
    );
    expect(result).toMatchObject({ status: 404, data: { message: 'User not found' } });
  });

  it('uses only the server actor and a validated request correlation ID', async () => {
    const targetId = randomUUID();
    vi.mocked(setAdminRole).mockResolvedValueOnce(['customer', 'admin']);
    vi.mocked(listUsersWithRoles).mockResolvedValueOnce([]);
    const result = await setAdminAction(
      actionEvent(admin, { userId: targetId, enabled: 'true' }, 'request-123') as never
    );
    expect(setAdminRole).toHaveBeenCalledWith(database, {
      actor: admin,
      targetUserId: targetId,
      enabled: true,
      correlationId: 'request-123'
    });
    expect(result).toEqual({ users: [] });
  });

  it('accepts exactly 100 characters and replaces 101', async () => {
    vi.mocked(setAdminRole).mockResolvedValueOnce(['customer']);
    vi.mocked(listUsersWithRoles).mockResolvedValueOnce([]);
    const maximum = `a${'x'.repeat(99)}`;
    await setAdminAction(
      actionEvent(admin, { userId: randomUUID(), enabled: 'false' }, maximum) as never
    );
    expect(vi.mocked(setAdminRole).mock.calls.at(-1)?.[1].correlationId).toBe(maximum);

    await setAdminAction(
      actionEvent(admin, { userId: randomUUID(), enabled: 'false' }, 'x'.repeat(101)) as never
    );
    expect(vi.mocked(setAdminRole).mock.calls.at(-1)?.[1].correlationId).toMatch(
      /^[0-9a-f-]{36}$/
    );
  });

  it('prefers ambient diagnostic correlation over a conflicting header', async () => {
    vi.mocked(setAdminRole).mockResolvedValueOnce(['customer']);
    vi.mocked(listUsersWithRoles).mockResolvedValueOnce([]);

    await runWithDiagnosticContext(
      { kind: 'web', correlationId: 'ambient-users' } as never,
      () => setAdminAction(actionEvent(
        admin,
        { userId: randomUUID(), enabled: 'false' },
        'conflicting-header'
      ) as never)
    );

    expect(vi.mocked(setAdminRole).mock.calls.at(-1)?.[1].correlationId).toBe('ambient-users');
  });
});
