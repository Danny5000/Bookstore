import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCapability } from '$lib/server/auth/admin-policy';
import { createPrivateTitle } from '$lib/server/catalog/titles';
import { parseCreateTitleInput } from '$lib/server/catalog/input';
import { getDatabaseClient } from '$lib/server/db/runtime';
import {
  catalogActionFailure,
  commandContext,
  readScalarForm,
  requireCatalogPage
} from '../route-support';

export const load: PageServerLoad = ({ locals }) => {
  requireCatalogPage(locals.actor);
  return {};
};

export const actions: Actions = {
  default: async ({ locals, request, route }) => {
    try {
      requireCapability(locals.actor, 'catalog.manage');
      const fields = await readScalarForm(request);
      const input = parseCreateTitleInput({
        slug: fields.slug,
        title: fields.title,
        subtitle: fields.subtitle,
        description: fields.description,
        creatorName: fields.creatorName,
        format: fields.format,
        priceMinor: Number(fields.priceMinor),
        currency: fields.currency
      });
      const title = await createPrivateTitle(getDatabaseClient().db, {
        actor: locals.actor,
        ...commandContext(request, route.id),
        input
      });
      redirect(303, `/admin/catalog/${title.id}`);
    } catch (cause: unknown) {
      return catalogActionFailure(cause);
    }
  }
};
