import { eq, sql, type SQL } from 'drizzle-orm';
import { titleRevisions, type TitleRevisionRow } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';

export interface TitleRevisionInsertValues {
  titleId: string;
  parentRevisionId: string | null;
  createdByActorId: string;
  changeSummary: string;
  stagingStorageKey: string | null;
  stagingChecksumSha256: string | null;
  stagingByteSize: number | null;
  uploadFilename: string | null;
  uploadMimeType: string | null;
}

export function titleRevisionInsertQuery(values: TitleRevisionInsertValues): SQL {
  return sql`
    insert into "public"."title_revisions" (
      "title_id", "parent_revision_id", "created_by_actor_id", "change_summary",
      "staging_storage_key", "staging_checksum_sha256", "staging_byte_size",
      "upload_filename", "upload_mime_type"
    ) values (
      ${values.titleId}::uuid,
      ${values.parentRevisionId}::uuid,
      ${values.createdByActorId}::text,
      ${values.changeSummary}::text,
      ${values.stagingStorageKey}::text,
      ${values.stagingChecksumSha256}::text,
      ${values.stagingByteSize}::bigint,
      ${values.uploadFilename}::text,
      ${values.uploadMimeType}::text
    )
    returning "id"
  `;
}

export async function insertTitleRevision(
  database: DatabaseExecutor,
  values: TitleRevisionInsertValues
): Promise<TitleRevisionRow | undefined> {
  const result = await database.execute<{ id: string }>(
    titleRevisionInsertQuery(values)
  );
  const insertedId = result.rows[0]?.id;
  if (!insertedId) return undefined;
  const [revision] = await database
    .select()
    .from(titleRevisions)
    .where(eq(titleRevisions.id, insertedId))
    .limit(1);
  return revision;
}
