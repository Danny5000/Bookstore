import type { PageServerLoad } from './$types';
import { listPublicCatalog } from '$lib/server/catalog/reader';
import { getDatabaseClient } from '$lib/server/db/runtime';

export const load: PageServerLoad = async () => ({
  titles: await listPublicCatalog(getDatabaseClient().db)
});
