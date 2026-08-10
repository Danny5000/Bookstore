import type { RequestHandler } from './$types';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { saveReaderPreferences } from '$lib/server/reader-state/service';
import { readerPreferencesInputSchema } from '$lib/types/library';
import {
  assertSameOrigin,
  correlationIdForRequest,
  handleReaderStateMutation,
  privateJson,
  readStrictJson,
  requireMutationActor
} from '../route-support';

export const PUT: RequestHandler = (event) => handleReaderStateMutation(async () => {
  const actor = requireMutationActor(event.locals.actor);
  assertSameOrigin(event.request);
  const input = await readStrictJson(event.request, readerPreferencesInputSchema);
  const value = await saveReaderPreferences({
    database: getDatabaseClient().db,
    actor,
    correlationId: correlationIdForRequest(event.request),
    ...input
  });
  return privateJson(value);
});
