import { access, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';

const { listCustomerLibrary } = vi.hoisted(() => ({ listCustomerLibrary: vi.fn() }));
vi.mock('$lib/server/db/runtime', () => ({ getDatabaseClient: () => ({ db: {} }) }));
vi.mock('$lib/server/library/query', () => ({ listCustomerLibrary }));

import { load } from './+page.server';
import LibraryPage from './+page.svelte';

const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const proseId = randomUUID();
const comicId = randomUUID();
const unavailableId = randomUUID();
const entries = [
  {
    titleId: proseId,
    slug: 'archived-prose',
    title: 'Archived Prose',
    creatorName: 'Pale Orbit',
    format: 'prose' as const,
    coverUrl: `/media/covers/${proseId}/${'a'.repeat(64)}`,
    availability: 'available' as const,
    activeRevisionId: randomUUID(),
    downloadFormat: 'epub' as const,
    progressPercent: 42.5,
    readUrl: `/read/${proseId}`,
    resumeUrl: `/read/${proseId}?resume=1`,
    downloadUrl: `/library/${proseId}/download`
  },
  {
    titleId: comicId,
    slug: 'private-comic',
    title: 'Private Comic',
    creatorName: 'Pale Orbit',
    format: 'comic' as const,
    coverUrl: `/media/covers/${comicId}/${'b'.repeat(64)}`,
    availability: 'available' as const,
    activeRevisionId: randomUUID(),
    downloadFormat: 'cbz' as const,
    progressPercent: 0,
    readUrl: `/read/${comicId}`,
    resumeUrl: `/read/${comicId}?resume=1`,
    downloadUrl: `/library/${comicId}/download`
  },
  {
    titleId: unavailableId,
    slug: 'unavailable',
    title: 'Unavailable Edition',
    creatorName: 'Pale Orbit',
    format: 'comic' as const,
    coverUrl: null,
    availability: 'temporarily_unavailable' as const,
    activeRevisionId: null,
    downloadFormat: null,
    progressPercent: null,
    readUrl: null,
    resumeUrl: null,
    downloadUrl: null
  }
];

describe('customer library route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not query or leak a shelf for signed-out actors', async () => {
    const data = await load({ locals: { actor: { type: 'anonymous' } } } as never);
    expect(data).toEqual({ signedIn: false, entries: [] });
    expect(listCustomerLibrary).not.toHaveBeenCalled();
    const { body } = render(LibraryPage, {
      props: { data: { user: null, ...data } as never }
    });
    expect(body).toContain('Sign in to view your library');
    expect(body).not.toContain('Archived Prose');
  });

  it('renders the actor-derived shelf with progress, unavailable state, and format downloads', async () => {
    listCustomerLibrary.mockResolvedValueOnce(entries);
    const data = await load({ locals: { actor: customer } } as never);
    expect(listCustomerLibrary).toHaveBeenCalledWith({}, customer.id);
    const { body } = render(LibraryPage, {
      props: { data: { user: null, ...data } as never }
    });
    expect(body).toContain('Archived Prose');
    expect(body).toContain('42.5% read');
    expect(body).toContain('Resume');
    expect(body).toContain('Download EPUB');
    expect(body).toContain('Download CBZ');
    expect(body).toContain('Temporarily unavailable');
    expect(body).toContain(entries[0]!.coverUrl!);
    expect(body).not.toContain(['Email', 'me', 'the', 'file'].join(' '));
    expect(body).not.toContain('Checkout complete');
  });

  it('renders an honest empty signed-in state', () => {
    const { body } = render(LibraryPage, {
      props: { data: { user: null, signedIn: true, entries: [] } }
    });
    expect(body).toContain('Your library is empty');
    expect(body).toContain('Add a title to your cart');
  });

  it('has no retired fake checkout, webhook, or delivery API on disk', async () => {
    const paths = ['checkout', 'stripe-webhook', 'deliver'].map(
      (route) => `../api/${route}/+server.ts`
    );
    for (const path of paths) {
      await expect(access(new URL(path, import.meta.url))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const source = await readFile(new URL('./+page.svelte', import.meta.url), 'utf8');
    expect(source).not.toMatch(/library\.grant|api\/checkout|api\/deliver|checkout\/success/u);
  });
});
