import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';

const database = {};
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: database }) }));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ origin: 'https://books.example.com' })
}));
vi.mock('$lib/server/reader-state/service', () => ({
  saveProgress: vi.fn(),
  createBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  saveReaderPreferences: vi.fn(),
  saveReaderTitlePreferences: vi.fn(),
  acknowledgeMigrationNotice: vi.fn()
}));

import { PUT as putProgress } from './[titleId]/progress/+server';
import { POST as postBookmark } from './[titleId]/bookmarks/+server';
import { DELETE as deleteBookmarkRoute } from './[titleId]/bookmarks/[bookmarkId]/+server';
import { PUT as putPreferences } from './preferences/+server';
import { PUT as putTitlePreferences } from './[titleId]/preferences/+server';
import { PATCH as patchNotice } from './[titleId]/migration-notice/+server';
import {
  acknowledgeMigrationNotice,
  createBookmark,
  deleteBookmark,
  saveProgress,
  saveReaderPreferences,
  saveReaderTitlePreferences
} from '$lib/server/reader-state/service';

const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const titleId = randomUUID();
const blockId = randomUUID();
const bookmarkId = randomUUID();

function event(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = { titleId }
) {
  return {
    locals: { actor },
    params,
    request: new Request(`https://books.example.com${path}`, {
      method,
      headers: {
        origin: 'https://books.example.com',
        'content-type': 'application/json',
        'x-request-id': 'reader-request'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    route: { id: path }
  };
}

describe('reader-state mutation routes', () => {
  it('rejects authentication before touching the body', async () => {
    const requestEvent = event(
      { type: 'anonymous' },
      'PUT',
      `/api/reader-state/${titleId}/progress`,
      { location: { format: 'prose', blockId, offset: 0 }, expectedVersion: 0 }
    );
    let bodyAccessed = false;
    Object.defineProperty(requestEvent.request, 'body', {
      get() { bodyAccessed = true; return null; }
    });
    const response = await putProgress(requestEvent as never);
    expect(response.status).toBe(401);
    expect(bodyAccessed).toBe(false);
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it('dispatches every mutation with server authority and exact statuses', async () => {
    const progress = {
      revisionId: randomUUID(),
      location: { format: 'prose' as const, blockId, offset: 4 },
      version: 1,
      updatedAt: new Date().toISOString()
    };
    vi.mocked(saveProgress).mockResolvedValueOnce(progress);
    const progressResponse = await putProgress(event(
      customer,
      'PUT',
      `/api/reader-state/${titleId}/progress`,
      { location: progress.location, expectedVersion: 0 }
    ) as never);
    expect(progressResponse.status).toBe(200);
    expect(saveProgress).toHaveBeenCalledWith({
      database,
      actor: customer,
      titleId,
      correlationId: 'reader-request',
      location: progress.location,
      expectedVersion: 0
    });

    const bookmark = { id: bookmarkId, revisionId: progress.revisionId, location: progress.location, createdAt: progress.updatedAt };
    vi.mocked(createBookmark).mockResolvedValueOnce(bookmark);
    expect((await postBookmark(event(
      customer,
      'POST',
      `/api/reader-state/${titleId}/bookmarks`,
      { location: progress.location }
    ) as never)).status).toBe(201);
    expect(createBookmark).toHaveBeenCalledWith(expect.objectContaining({
      database, actor: customer, titleId, location: progress.location
    }));

    vi.mocked(deleteBookmark).mockResolvedValueOnce(undefined);
    expect((await deleteBookmarkRoute(event(
      customer,
      'DELETE',
      `/api/reader-state/${titleId}/bookmarks/${bookmarkId}`,
      undefined,
      { titleId, bookmarkId }
    ) as never)).status).toBe(204);
    expect(deleteBookmark).toHaveBeenCalledWith(expect.objectContaining({
      database, actor: customer, titleId, bookmarkId
    }));

    const preferences = { fontSize: 20, typeface: 'georgia' as const, paper: 'dim' as const, version: 1 };
    vi.mocked(saveReaderPreferences).mockResolvedValueOnce(preferences);
    expect((await putPreferences(event(customer, 'PUT', '/api/reader-state/preferences', {
      fontSize: 20, typeface: 'georgia', paper: 'dim', expectedVersion: 0
    }, {}) as never)).status).toBe(200);
    expect(saveReaderPreferences).toHaveBeenCalledWith(expect.objectContaining({
      database, actor: customer, fontSize: 20, expectedVersion: 0
    }));

    const titlePreferences = { titleId, comicMode: 'guided' as const, version: 1 };
    vi.mocked(saveReaderTitlePreferences).mockResolvedValueOnce(titlePreferences);
    expect((await putTitlePreferences(event(
      customer,
      'PUT',
      `/api/reader-state/${titleId}/preferences`,
      { comicMode: 'guided', expectedVersion: 0 }
    ) as never)).status).toBe(200);
    expect(saveReaderTitlePreferences).toHaveBeenCalledWith(expect.objectContaining({
      database, actor: customer, titleId, comicMode: 'guided'
    }));

    const notice = {
      targetRevisionId: progress.revisionId,
      progress: 'migrated' as const,
      panelPositionSimplified: false,
      migratedBookmarkCount: 1,
      unmatchedBookmarkCount: 0,
      acknowledged: true
    };
    vi.mocked(acknowledgeMigrationNotice).mockResolvedValueOnce(notice);
    expect((await patchNotice(event(
      customer,
      'PATCH',
      `/api/reader-state/${titleId}/migration-notice`,
      { targetRevisionId: progress.revisionId }
    ) as never)).status).toBe(200);
    expect(acknowledgeMigrationNotice).toHaveBeenCalledWith(expect.objectContaining({
      database, actor: customer, titleId, targetRevisionId: progress.revisionId
    }));
  });

  it('rejects invalid IDs and strict-body extras without invoking services', async () => {
    vi.clearAllMocks();
    const invalidId = await putProgress(event(
      customer,
      'PUT',
      '/api/reader-state/bad/progress',
      { location: { format: 'prose', blockId, offset: 0 }, expectedVersion: 0 },
      { titleId: 'bad' }
    ) as never);
    expect(invalidId.status).toBe(404);
    const extra = await putPreferences(event(customer, 'PUT', '/api/reader-state/preferences', {
      fontSize: 18,
      typeface: 'serif',
      paper: 'white',
      expectedVersion: 0,
      userId: customer.type === 'user' ? customer.id : ''
    }, {}) as never);
    expect(extra.status).toBe(422);
    expect(saveProgress).not.toHaveBeenCalled();
    expect(saveReaderPreferences).not.toHaveBeenCalled();
  });
});
