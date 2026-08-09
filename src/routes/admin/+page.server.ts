import type { PageServerLoad } from './$types';
import { listAdminTitles } from '$lib/server/catalog/titles';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { requireCatalogPage } from './catalog/route-support';

export const load: PageServerLoad = async ({ locals }) => {
  requireCatalogPage(locals.actor);
  const titles = await listAdminTitles(getDatabaseClient().db);
  return {
    catalog: {
      total: titles.length,
      private: titles.filter((title) => title.visibility === 'private').length,
      public: titles.filter((title) => title.visibility === 'public').length
    }
  };
};
