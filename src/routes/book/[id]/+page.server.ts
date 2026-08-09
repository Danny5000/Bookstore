import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getPublicTitleDetail } from '$lib/server/catalog/reader';
import { getDatabaseClient } from '$lib/server/db/runtime';

export const load: PageServerLoad = async ({ params }) => {
  const title = await getPublicTitleDetail(getDatabaseClient().db, params.id);
  if (!title) error(404, 'Title not found');
  return { title };
};
