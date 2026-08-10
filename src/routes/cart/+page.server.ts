import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => ({
  canceled: url.searchParams.get('canceled') === '1'
});
