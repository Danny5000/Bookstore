import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCapability } from '$lib/server/auth/admin-policy';
import {
  parseTitlePublicationActionInput,
  parseUpdateTitleMetadataInput
} from '$lib/server/catalog/input';
import {
  publishTitleToStorefront,
  withdrawTitle
} from '$lib/server/catalog/publication';
import { listAdminRevisions } from '$lib/server/catalog/revisions';
import { getAdminTitleDetail, updateTitleMetadata } from '$lib/server/catalog/titles';
import { getDatabaseClient } from '$lib/server/db/runtime';
import {
  catalogActionFailure,
  commandContext,
  readScalarForm,
  requireCatalogPage,
  requireRouteUuid,
  safeAdminTitle
} from '../route-support';

export const load: PageServerLoad = async ({ locals, params }) => {
  requireCatalogPage(locals.actor);
  const titleId = requireRouteUuid(params.titleId);
  const database = getDatabaseClient().db;
  const title = await getAdminTitleDetail(database, titleId);
  if (!title) error(404, 'Title not found');
  return {
    title: safeAdminTitle(title),
    revisions: await listAdminRevisions(database, titleId)
  };
};

async function publicationAction(
  event: Parameters<NonNullable<Actions[string]>>[0],
  service: typeof publishTitleToStorefront
) {
  try {
    requireCapability(event.locals.actor, 'catalog.manage');
    const titleId = requireRouteUuid(event.params.titleId);
    await service(getDatabaseClient().db, {
      actor: event.locals.actor,
      ...commandContext(event.request, event.route.id),
      input: parseTitlePublicationActionInput({ titleId })
    });
    return { success: true };
  } catch (cause: unknown) {
    return catalogActionFailure(cause);
  }
}

export const actions: Actions = {
  metadata: async ({ locals, params, request, route }) => {
    try {
      requireCapability(locals.actor, 'catalog.manage');
      const titleId = requireRouteUuid(params.titleId);
      const fields = await readScalarForm(request);
      const input = parseUpdateTitleMetadataInput({
        titleId,
        slug: fields.slug,
        title: fields.title,
        subtitle: fields.subtitle,
        description: fields.description,
        creatorName: fields.creatorName,
        priceMinor: Number(fields.priceMinor),
        currency: fields.currency
      });
      await updateTitleMetadata(getDatabaseClient().db, {
        actor: locals.actor,
        ...commandContext(request, route.id),
        input
      });
      return { success: true };
    } catch (cause: unknown) {
      return catalogActionFailure(cause);
    }
  },
  publish: (event) => publicationAction(event, publishTitleToStorefront),
  withdraw: (event) => publicationAction(event, withdrawTitle)
};
