import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireCapability } from '$lib/server/auth/admin-policy';
import { confirmCoverSuggestion } from '$lib/server/catalog/covers';
import {
  parseConfirmCoverSuggestionInput,
  parsePublishReaderSettingsInput,
  parseRevisionPublicationActionInput,
  parseSaveDraftPresentationInput
} from '$lib/server/catalog/input';
import {
  activatePrivateRevision,
  publishReplacementRevision,
  rollbackRevision
} from '$lib/server/catalog/publication';
import { publishReaderSettings, saveDraftPresentation } from '$lib/server/catalog/presentations';
import { getAdminRevisionReader } from '$lib/server/catalog/reader';
import { getAdminRevisionReview, retryFailedRevision } from '$lib/server/catalog/revisions';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { getObjectStorage } from '$lib/server/storage/runtime';
import {
  CatalogRouteInputError,
  catalogActionFailure,
  commandContext,
  readScalarForm,
  requireCatalogPage,
  requireRouteUuid
} from '../../../route-support';

export const load: PageServerLoad = async ({ locals, params }) => {
  requireCatalogPage(locals.actor);
  const titleId = requireRouteUuid(params.titleId);
  const revisionId = requireRouteUuid(params.revisionId);
  const database = getDatabaseClient().db;
  const review = await getAdminRevisionReview(database, titleId, revisionId);
  if (!review) error(404, 'Revision not found');
  const canRead = review.draft && ['ready_for_review', 'active', 'retired'].includes(review.revision.state);
  const document = canRead
    ? await getAdminRevisionReader(database, locals.actor, revisionId, 'draft')
    : null;
  return { review, document };
};

function ids(params: Record<string, string | undefined>) {
  return {
    titleId: requireRouteUuid(params.titleId),
    revisionId: requireRouteUuid(params.revisionId)
  };
}

function parsePanels(value: string | undefined): unknown {
  try {
    return JSON.parse(value ?? '[]');
  } catch {
    throw new CatalogRouteInputError('Panels are invalid');
  }
}

async function revisionAction(
  event: Parameters<NonNullable<Actions[string]>>[0],
  service: typeof activatePrivateRevision | typeof publishReplacementRevision | typeof rollbackRevision
) {
  try {
    requireCapability(event.locals.actor, 'catalog.manage');
    const input = parseRevisionPublicationActionInput(ids(event.params));
    await service(getDatabaseClient().db, {
      actor: event.locals.actor,
      ...commandContext(event.request, event.route.id),
      input
    });
    return { success: true };
  } catch (cause: unknown) {
    return catalogActionFailure(cause);
  }
}

export const actions: Actions = {
  confirmCover: async ({ locals, params, request, route }) => {
    try {
      requireCapability(locals.actor, 'catalog.manage');
      const fields = await readScalarForm(request);
      const input = parseConfirmCoverSuggestionInput({ ...ids(params), suggestionId: fields.suggestionId });
      await confirmCoverSuggestion(getDatabaseClient().db, getObjectStorage(), {
        actor: locals.actor,
        ...commandContext(request, route.id),
        input
      });
      return { success: true };
    } catch (cause: unknown) {
      return catalogActionFailure(cause);
    }
  },
  saveSettings: async ({ locals, params, request, route }) => {
    try {
      requireCapability(locals.actor, 'catalog.manage');
      const fields = await readScalarForm(request);
      const format = fields.format;
      const input = parseSaveDraftPresentationInput({
        ...ids(params),
        presentationId: fields.presentationId,
        expectedUpdatedAt: fields.expectedUpdatedAt,
        format,
        readingDirection: fields.readingDirection,
        guidedViewEnabled: format === 'comic' ? fields.guidedViewEnabled === 'true' : false,
        previewSectionId: format === 'prose' ? fields.previewSectionId : null,
        previewBlockId: format === 'prose' ? fields.previewBlockId : null,
        previewPageId: format === 'comic' ? fields.previewPageId : null,
        panels: format === 'comic' ? parsePanels(fields.panels) : []
      });
      await saveDraftPresentation(getDatabaseClient().db, {
        actor: locals.actor,
        ...commandContext(request, route.id),
        input
      });
      return { success: true };
    } catch (cause: unknown) {
      return catalogActionFailure(cause);
    }
  },
  publishSettings: async ({ locals, params, request, route }) => {
    try {
      requireCapability(locals.actor, 'catalog.manage');
      const fields = await readScalarForm(request);
      const input = parsePublishReaderSettingsInput({
        ...ids(params),
        presentationId: fields.presentationId,
        expectedUpdatedAt: fields.expectedUpdatedAt
      });
      await publishReaderSettings(getDatabaseClient().db, {
        actor: locals.actor,
        ...commandContext(request, route.id),
        input
      });
      return { success: true };
    } catch (cause: unknown) {
      return catalogActionFailure(cause);
    }
  },
  activatePrivate: (event) => revisionAction(event, activatePrivateRevision),
  publishReplacement: (event) => revisionAction(event, publishReplacementRevision),
  rollback: (event) => revisionAction(event, rollbackRevision),
  retry: async ({ locals, params, request, route }) => {
    try {
      requireCapability(locals.actor, 'catalog.manage');
      await retryFailedRevision(getDatabaseClient().db, getObjectStorage(), {
        actor: locals.actor,
        ...commandContext(request, route.id),
        input: parseRevisionPublicationActionInput(ids(params))
      });
      return { success: true };
    } catch (cause: unknown) {
      return catalogActionFailure(cause);
    }
  }
};
