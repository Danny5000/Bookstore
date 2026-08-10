import { desc, eq } from 'drizzle-orm';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { AuditRequestMetadata } from '$lib/server/audit/request-metadata';
import type { Database } from '$lib/server/db/client';
import { titles, type TitleRow } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import {
  parseCreateTitleInput,
  parseUpdateTitleMetadataInput,
  type CreateTitleInput,
  type UpdateTitleMetadataInput
} from './input';
import { withLockedAdminTitle } from './lock';

interface CatalogCommand<T> {
  actor: Actor;
  correlationId: string;
  requestMetadata?: AuditRequestMetadata;
  input: T;
}

export interface AdminTitleDto {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string;
  creatorName: string;
  format: TitleRow['format'];
  priceMinor: number;
  currency: string;
  visibility: TitleRow['visibility'];
  activeRevisionId: string | null;
  cover: {
    url: string;
    checksumSha256: string;
    mediaType: string;
    byteSize: number;
    width: number;
    height: number;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toAdminTitleDto(title: TitleRow): AdminTitleDto {
  return {
    id: title.id,
    slug: title.slug,
    title: title.title,
    subtitle: title.subtitle,
    description: title.description,
    creatorName: title.creatorName,
    format: title.format,
    priceMinor: title.priceMinor,
    currency: title.currency,
    visibility: title.visibility,
    activeRevisionId: title.activeRevisionId,
    cover: title.coverChecksumSha256 && title.coverMediaType && title.coverByteSize && title.coverWidth && title.coverHeight
      ? {
          url: `/media/covers/${title.id}/${title.coverChecksumSha256}`,
          checksumSha256: title.coverChecksumSha256,
          mediaType: title.coverMediaType,
          byteSize: title.coverByteSize,
          width: title.coverWidth,
          height: title.coverHeight
        }
      : null,
    createdAt: title.createdAt,
    updatedAt: title.updatedAt
  };
}

export async function createPrivateTitle(
  database: Database,
  command: CatalogCommand<CreateTitleInput>
): Promise<TitleRow> {
  requireCapability(command.actor, 'catalog.manage');
  const actor = command.actor;
  const input = parseCreateTitleInput(command.input);

  return withTransaction(database, async (transaction) => {
    const [title] = await transaction
      .insert(titles)
      .values({ ...input, visibility: 'private' })
      .returning();
    if (!title) throw new Error('Title insert returned no row');
    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.title.create',
      outcome: 'succeeded',
      resourceType: 'title',
      resourceId: title.id,
      correlationId: command.correlationId,
      ...(command.requestMetadata ? { requestMetadata: command.requestMetadata } : {}),
      after: {
        slug: title.slug,
        title: title.title,
        format: title.format,
        visibility: title.visibility,
        priceMinor: title.priceMinor,
        currency: title.currency
      }
    });
    return title;
  });
}

export async function updateTitleMetadata(
  database: Database,
  command: CatalogCommand<UpdateTitleMetadataInput>
): Promise<TitleRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parseUpdateTitleMetadataInput(command.input);

  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(
      transaction,
      command.actor,
      input.titleId,
      async ({ actor, title: before }) => {
        const [updated] = await transaction
          .update(titles)
          .set({
            slug: input.slug,
            title: input.title,
            subtitle: input.subtitle,
            description: input.description,
            creatorName: input.creatorName,
            priceMinor: input.priceMinor,
            currency: input.currency,
            updatedAt: new Date()
          })
          .where(eq(titles.id, input.titleId))
          .returning();
        if (!updated) throw new Error('Title update returned no row');
        await appendAuditEvent(transaction, {
          actor,
          action: 'catalog.title.update',
          outcome: 'succeeded',
          resourceType: 'title',
          resourceId: updated.id,
          correlationId: command.correlationId,
          ...(command.requestMetadata ? { requestMetadata: command.requestMetadata } : {}),
          before: {
            slug: before.slug,
            title: before.title,
            subtitle: before.subtitle,
            description: before.description,
            creatorName: before.creatorName,
            priceMinor: before.priceMinor,
            currency: before.currency
          },
          after: {
            slug: updated.slug,
            title: updated.title,
            subtitle: updated.subtitle,
            description: updated.description,
            creatorName: updated.creatorName,
            priceMinor: updated.priceMinor,
            currency: updated.currency
          }
        });
        return updated;
      }
    )
  );
}

export async function listAdminTitles(database: Database): Promise<TitleRow[]> {
  return database.select().from(titles).orderBy(desc(titles.updatedAt), desc(titles.id));
}

export async function getAdminTitleDetail(
  database: Database,
  titleId: string
): Promise<TitleRow | null> {
  const [title] = await database.select().from(titles).where(eq(titles.id, titleId)).limit(1);
  return title ?? null;
}
