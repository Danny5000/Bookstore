import type { RequestHandler } from './$types';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { deleteBookmark } from '$lib/server/reader-state/service';
import {
  assertSameOrigin,
  correlationIdForRequest,
  handleReaderStateMutation,
  parseRouteUuid,
  privateEmpty,
  requireMutationActor
} from '../../../route-support';

export const DELETE: RequestHandler = (event) => handleReaderStateMutation(async () => {
  const actor = requireMutationActor(event.locals.actor);
  assertSameOrigin(event.request);
  await deleteBookmark({
    database: getDatabaseClient().db,
    actor,
    titleId: parseRouteUuid(event.params.titleId),
    bookmarkId: parseRouteUuid(event.params.bookmarkId),
    correlationId: correlationIdForRequest(event.request)
  });
  return privateEmpty();
});
