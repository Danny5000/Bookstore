import type { PageServerLoad } from './$types';
import { listAdminTitles } from '$lib/server/catalog/titles';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { requireCatalogPage, safeAdminTitle } from './route-support';

export const load: PageServerLoad = async ({ locals }) => {
  requireCatalogPage(locals.actor);
  const rows = await listAdminTitles(getDatabaseClient().db);
  return { titles: rows.map(safeAdminTitle) };
};
