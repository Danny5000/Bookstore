import { and, eq, isNull } from 'drizzle-orm';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import {
  entitlements,
  revisionPresentations,
  titleRevisions,
  titles,
  type RevisionPresentationRow,
  type TitleRow
} from '$lib/server/db/schema';

export interface PublicationAccessRoot {
  title: TitleRow;
  revisionId: string;
  presentation: RevisionPresentationRow;
}

type AvailablePublicationAccess = {
  titleId: string;
  revisionId: string;
  presentationId: string;
  root: PublicationAccessRoot;
};

export type PublicationAccessDecision =
  | ({ level: 'admin' } & AvailablePublicationAccess)
  | ({ level: 'entitled' } & AvailablePublicationAccess)
  | ({ level: 'preview' } & AvailablePublicationAccess)
  | { level: 'unavailable'; titleId: string }
  | { level: 'denied' };

export type PublicationAccessLevel = PublicationAccessDecision['level'];

function isAdministrator(actor: Actor): boolean {
  return actor.type === 'user' && actor.roles.includes('admin');
}

export function decidePublicationAccess(input: {
  actor: Actor;
  titleVisibility: TitleRow['visibility'] | null;
  hasActivePublication: boolean;
  hasActiveEntitlement: boolean;
}): PublicationAccessLevel {
  if (input.titleVisibility === null) return 'denied';

  if (isAdministrator(input.actor)) {
    return input.hasActivePublication ? 'admin' : 'unavailable';
  }
  if (input.hasActiveEntitlement) {
    return input.hasActivePublication ? 'entitled' : 'unavailable';
  }
  if (input.titleVisibility === 'public' && input.hasActivePublication) return 'preview';
  return 'denied';
}

export async function hasActiveEntitlement(
  db: Database,
  userId: string,
  titleId: string
): Promise<boolean> {
  const [entitlement] = await db
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.userId, userId),
        eq(entitlements.titleId, titleId),
        isNull(entitlements.revokedAt)
      )
    )
    .limit(1);
  return Boolean(entitlement);
}

async function getCurrentPublicationRoot(
  db: Database,
  title: TitleRow
): Promise<PublicationAccessRoot | null> {
  if (!title.activeRevisionId) return null;
  const [publication] = await db
    .select({
      revisionId: titleRevisions.id,
      presentation: revisionPresentations
    })
    .from(titleRevisions)
    .innerJoin(
      revisionPresentations,
      and(
        eq(revisionPresentations.revisionId, titleRevisions.id),
        eq(revisionPresentations.state, 'published')
      )
    )
    .where(
      and(
        eq(titleRevisions.id, title.activeRevisionId),
        eq(titleRevisions.titleId, title.id),
        eq(titleRevisions.state, 'active')
      )
    )
    .limit(1);
  return publication
    ? { title, revisionId: publication.revisionId, presentation: publication.presentation }
    : null;
}

function availableDecision(
  level: 'admin' | 'entitled' | 'preview',
  root: PublicationAccessRoot
): PublicationAccessDecision {
  return {
    level,
    titleId: root.title.id,
    revisionId: root.revisionId,
    presentationId: root.presentation.id,
    root
  };
}

export async function resolveAdminReviewAccess(input: {
  db: Database;
  actor: Actor;
  revisionId: string;
  presentationState: 'draft' | 'published';
}): Promise<PublicationAccessDecision> {
  requireCapability(input.actor, 'catalog.manage');
  const [root] = await input.db
    .select({
      title: titles,
      revisionId: titleRevisions.id,
      presentation: revisionPresentations
    })
    .from(titleRevisions)
    .innerJoin(titles, eq(titles.id, titleRevisions.titleId))
    .innerJoin(
      revisionPresentations,
      and(
        eq(revisionPresentations.revisionId, titleRevisions.id),
        eq(revisionPresentations.state, input.presentationState)
      )
    )
    .where(eq(titleRevisions.id, input.revisionId))
    .limit(1);
  return root ? availableDecision('admin', root) : { level: 'denied' };
}

export async function resolvePublicationAccess(input: {
  db: Database;
  actor: Actor;
  titleId: string;
  requestedRevisionId?: string;
  requestedPresentationState?: 'draft' | 'published';
  purpose: 'reader' | 'cover' | 'derived-media' | 'original-download' | 'admin-review';
}): Promise<PublicationAccessDecision> {
  if (input.purpose === 'admin-review') {
    if (!input.requestedRevisionId) return { level: 'denied' };
    return resolveAdminReviewAccess({
      db: input.db,
      actor: input.actor,
      revisionId: input.requestedRevisionId,
      presentationState: input.requestedPresentationState ?? 'draft'
    });
  }

  const [title] = await input.db
    .select()
    .from(titles)
    .where(eq(titles.id, input.titleId))
    .limit(1);
  if (!title) return { level: 'denied' };

  const entitled =
    input.actor.type === 'user' && !isAdministrator(input.actor)
      ? await hasActiveEntitlement(input.db, input.actor.id, title.id)
      : false;
  const root = await getCurrentPublicationRoot(input.db, title);
  const level = decidePublicationAccess({
    actor: input.actor,
    titleVisibility: title.visibility,
    hasActivePublication: Boolean(root),
    hasActiveEntitlement: entitled
  });
  if (level === 'denied') return { level };
  if (level === 'unavailable') return { level, titleId: title.id };
  if (!root) return { level: 'denied' };
  return availableDecision(level, root);
}
