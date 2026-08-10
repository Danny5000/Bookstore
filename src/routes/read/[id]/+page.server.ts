import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { getPublicPreview, getReaderDocumentForAccess } from '$lib/server/catalog/reader';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { resolvePublicationAccess } from '$lib/server/library/access';
import { getReaderInitialState } from '$lib/server/reader-state/service';
import type { ReaderInitialStateDto } from '$lib/types/library';

const titleIdSchema = z.uuid();
const emptyInitialState: ReaderInitialStateDto = {
  progress: null,
  bookmarks: [],
  preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
  titlePreferences: null,
  migrationNotice: null
};

export const load: PageServerLoad = async ({ params, locals, setHeaders }) => {
  const database = getDatabaseClient().db;
  const parsedTitleId = titleIdSchema.safeParse(params.id);
  if (!parsedTitleId.success) {
    const document = await getPublicPreview(database, params.id);
    if (!document) error(404, 'Publication not found');
    setHeaders?.({ 'cache-control': 'private, no-store' });
    return {
      document,
      initialState: emptyInitialState,
      persistenceKind: 'preview-local' as const,
      slug: params.id
    };
  }

  const decision = await resolvePublicationAccess({
    db: database,
    actor: locals.actor,
    titleId: parsedTitleId.data,
    purpose: 'reader'
  });
  if (decision.level === 'denied' || decision.level === 'unavailable') {
    error(404, 'Publication not found');
  }
  const document = await getReaderDocumentForAccess(database, decision);
  if (!document) error(404, 'Publication not found');
  const persistenceKind =
    decision.level === 'entitled'
      ? 'server' as const
      : decision.level === 'admin'
        ? 'memory' as const
        : 'preview-local' as const;
  const initialState = decision.level === 'entitled'
    ? await getReaderInitialState({
        database,
        actor: locals.actor,
        titleId: decision.titleId,
        correlationId: randomUUID()
      })
    : emptyInitialState;
  setHeaders?.({ 'cache-control': 'private, no-store' });
  return {
    document,
    initialState,
    persistenceKind,
    slug: decision.root.title.slug
  };
};
