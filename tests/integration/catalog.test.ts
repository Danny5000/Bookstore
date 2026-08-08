import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import {
  CatalogDomainError,
  createPrivateTitle,
  createRevisionSkeleton
} from '$lib/server/catalog/service';
import { auditEvents, titleRevisions, titles } from '$lib/server/db/schema';
import { databaseClient } from './database';

const admin: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
const customer: Actor = { type: 'user', id: 'customer-1', roles: ['customer'] };

const titleInput = {
  slug: 'the-glass-astronomer',
  title: 'The Glass Astronomer',
  subtitle: null,
  description: 'A private prose title.',
  creatorName: 'Pale Orbit',
  format: 'prose' as const,
  priceMinor: 1499,
  currency: 'USD'
};

describe('catalog foundation', () => {
  it('creates a private title and audit event atomically', async () => {
    const title = await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-create-title',
      input: titleInput
    });

    expect(title.visibility).toBe('private');
    const [event] = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, title.id));
    expect(event).toMatchObject({
      action: 'catalog.title.create',
      actorId: 'admin-1',
      outcome: 'succeeded'
    });
  });

  it('rejects a customer before writing either table', async () => {
    await expect(
      createPrivateTitle(databaseClient.db, {
        actor: customer,
        correlationId: 'request-denied',
        input: titleInput
      })
    ).rejects.toMatchObject({ code: 'forbidden' });

    const [titleCount] = await databaseClient.db.select({ value: count() }).from(titles);
    const [auditCount] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(titleCount?.value).toBe(0);
    expect(auditCount?.value).toBe(0);
  });

  it('rolls back the audit insert when a duplicate slug fails', async () => {
    await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-first',
      input: titleInput
    });

    await expect(
      createPrivateTitle(databaseClient.db, {
        actor: admin,
        correlationId: 'request-duplicate',
        input: titleInput
      })
    ).rejects.toThrow();

    const [auditCount] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(auditCount?.value).toBe(1);
  });

  it('requires a parent revision to belong to the same title', async () => {
    const firstTitle = await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-first-title',
      input: titleInput
    });
    const secondTitle = await createPrivateTitle(databaseClient.db, {
      actor: admin,
      correlationId: 'request-second-title',
      input: { ...titleInput, slug: 'second-title', title: 'Second Title' }
    });
    const parent = await createRevisionSkeleton(databaseClient.db, {
      actor: admin,
      correlationId: 'request-parent',
      input: {
        titleId: firstTitle.id,
        parentRevisionId: null,
        changeSummary: 'First candidate'
      }
    });

    await expect(
      createRevisionSkeleton(databaseClient.db, {
        actor: admin,
        correlationId: 'request-invalid-parent',
        input: {
          titleId: secondTitle.id,
          parentRevisionId: parent.id,
          changeSummary: 'Invalid parent'
        }
      })
    ).rejects.toEqual(new CatalogDomainError('parent_revision_not_in_title'));

    const revisions = await databaseClient.db.select().from(titleRevisions);
    expect(revisions).toHaveLength(1);
  });
});
