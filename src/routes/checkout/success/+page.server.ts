import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  const values = url.searchParams.getAll('order');
  const parsed = values.length === 1 ? z.uuid().safeParse(values[0]) : null;
  if (!parsed?.success) error(404, 'Order not found');
  setHeaders({ 'cache-control': 'private, no-store' });
  return { orderId: parsed.data };
};
