import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationConfig } from '$lib/server/config';

export const GET: RequestHandler = () => {
  getApplicationConfig();
  return json(
    { status: 'ready' },
    {
      headers: { 'cache-control': 'no-store' }
    }
  );
};
