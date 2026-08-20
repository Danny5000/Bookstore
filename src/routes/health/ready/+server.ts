import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationConfig } from '$lib/server/config';
import { probeDatabase } from '$lib/server/db/health';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { probeStorage } from '$lib/server/storage/health';
import { getObjectStorage } from '$lib/server/storage/runtime';

const headers = { 'cache-control': 'no-store' };

export const GET: RequestHandler = async () => {
  const config = getApplicationConfig();
  const databaseClient = getDatabaseClient();

  try {
    await Promise.all([
      probeDatabase(databaseClient.pool, config.database.readinessTimeoutMs),
      probeStorage(getObjectStorage(), 'web')
    ]);
    return json({ status: 'ready' }, { headers });
  } catch {
    return json({ status: 'not_ready' }, { status: 503, headers });
  }
};
