import type { RequestHandler } from './$types';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { acknowledgeMigrationNotice } from '$lib/server/reader-state/service';
import { readerMigrationNoticeInputSchema } from '$lib/types/library';
import {
  assertSameOrigin,
  correlationIdForRequest,
  handleReaderStateMutation,
  parseRouteUuid,
  privateJson,
  readStrictJson,
  requireMutationActor
} from '../../route-support';

export const PATCH: RequestHandler = (event) => handleReaderStateMutation(async () => {
  const actor = requireMutationActor(event.locals.actor);
  assertSameOrigin(event.request);
  const titleId = parseRouteUuid(event.params.titleId);
  const input = await readStrictJson(event.request, readerMigrationNoticeInputSchema);
  const value = await acknowledgeMigrationNotice({
    database: getDatabaseClient().db,
    actor,
    titleId,
    correlationId: correlationIdForRequest(event.request),
    ...input
  });
  return privateJson(value);
});
