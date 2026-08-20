import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  probeDatabase: vi.fn(),
  probeStorage: vi.fn()
}));

vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ database: { readinessTimeoutMs: 2_000 } })
}));
vi.mock('$lib/server/db/health', () => ({ probeDatabase: mocks.probeDatabase }));
vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ pool: 'database-pool' })
}));
vi.mock('$lib/server/storage/health', () => ({ probeStorage: mocks.probeStorage }));
vi.mock('$lib/server/storage/runtime', () => ({
  getObjectStorage: () => 'object-storage'
}));

import { GET } from './+server';

describe('GET /health/ready', () => {
  beforeEach(() => {
    mocks.probeDatabase.mockReset().mockResolvedValue(undefined);
    mocks.probeStorage.mockReset().mockResolvedValue(undefined);
  });

  it('requires both database and object-storage readiness', async () => {
    const response = await GET({} as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ready' });
    expect(mocks.probeDatabase).toHaveBeenCalledWith('database-pool', 2_000);
    expect(mocks.probeStorage).toHaveBeenCalledWith('object-storage', 'web');
  });

  it('returns only a safe not-ready response when storage fails', async () => {
    mocks.probeStorage.mockRejectedValue(new Error('private local path'));

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ status: 'not_ready' });
  });
});
