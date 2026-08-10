import type { RequestHandler } from './$types';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { saveReaderTitlePreferences } from '$lib/server/reader-state/service';
import { readerTitlePreferencesInputSchema } from '$lib/types/library';
import {
  assertSameOrigin,
  correlationIdForRequest,
  handleReaderStateMutation,
  parseRouteUuid,
  privateJson,
  readStrictJson,
  requireMutationActor
} from '../../route-support';

export const PUT: RequestHandler = (event) => handleReaderStateMutation(async () => {
  const actor = requireMutationActor(event.locals.actor);
  assertSameOrigin(event.request);
  const titleId = parseRouteUuid(event.params.titleId);
  const input = await readStrictJson(event.request, readerTitlePreferencesInputSchema);
  const value = await saveReaderTitlePreferences({
    database: getDatabaseClient().db,
    actor,
    titleId,
    correlationId: correlationIdForRequest(event.request),
    ...input
  });
  return privateJson(value);
});
