import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getPublicPreview } from '$lib/server/catalog/reader';
import { getDatabaseClient } from '$lib/server/db/runtime';

export const load: PageServerLoad = async ({ params }) => {
  const document = await getPublicPreview(getDatabaseClient().db, params.id);
  if (!document) error(404, 'Preview not found');
  return { document, slug: params.id };
};
