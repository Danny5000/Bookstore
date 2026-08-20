import { beforeEach, describe, expect, it } from 'vitest';
import { ownerDatabaseClient as databaseClient } from './database';

const PLAN_2_TABLES = [
  'audit_events',
  'jobs',
  'outbox_messages',
  'title_revisions',
  'titles'
];

const PLAN_4_TABLES = [
  'comic_pages',
  'comic_panel_regions',
  'prose_blocks',
  'prose_images',
  'prose_sections',
  'revision_cover_suggestions',
  'revision_ingestion_warnings',
  'revision_presentations'
];

const PLAN_5_TABLES = [
  'entitlements',
  'reader_bookmarks',
  'reader_preferences',
  'reader_progress',
  'reader_revision_migrations',
  'reader_title_preferences'
];

let entitySequence = 0;

beforeEach(() => {
  entitySequence = 0;
});

async function createTitle(format: 'prose' | 'comic' = 'prose'): Promise<string> {
  entitySequence += 1;
  const result = await databaseClient.pool.query<{ id: string }>(
    `
      insert into titles
        (slug, title, description, creator_name, format, price_minor, currency)
      values ($1, $2, 'Description', 'Creator', $3, 1000, 'USD')
      returning id
    `,
    [`schema-title-${entitySequence}`, `Schema Title ${entitySequence}`, format]
  );
  return result.rows[0]!.id;
}

async function createUser(): Promise<string> {
  entitySequence += 1;
  const result = await databaseClient.pool.query<{ id: string }>(
    `
      insert into "user" (name, email, email_verified)
      values ($1, $2, true)
      returning id
    `,
    [`Schema User ${entitySequence}`, `schema-${entitySequence}@example.com`]
  );
  return result.rows[0]!.id;
}

async function createRevision(
  titleId: string,
  state: 'uploaded' | 'ready_for_review' | 'active' = 'uploaded'
): Promise<string> {
  const result = await databaseClient.pool.query<{ id: string }>(
    `
      insert into title_revisions
        (title_id, state, created_by_actor_id, change_summary)
      values ($1, $2, 'system:test', 'Schema test revision')
      returning id
    `,
    [titleId, state]
  );
  return result.rows[0]!.id;
}

async function createProseSection(revisionId: string, ordinal = 0): Promise<string> {
  const result = await databaseClient.pool.query<{ id: string }>(
    `
      insert into prose_sections (revision_id, ordinal, label, source_reference)
      values ($1, $2, 'Chapter', 'EPUB/chapter.xhtml')
      returning id
    `,
    [revisionId, ordinal]
  );
  return result.rows[0]!.id;
}

async function createProseImage(revisionId: string): Promise<string> {
  const result = await databaseClient.pool.query<{ id: string }>(
    `
      insert into prose_images
        (revision_id, storage_key, media_type, checksum_sha256, byte_size, width, height, alt_text)
      values ($1, 'titles/test/derived/image.webp', 'image/webp', repeat('a', 64), 100, 10, 20, 'Image')
      returning id
    `,
    [revisionId]
  );
  return result.rows[0]!.id;
}

async function createProseBlock(
  revisionId: string,
  sectionId: string,
  ordinal = 0,
  imageId: string | null = null
): Promise<string> {
  const isImage = imageId !== null;
  const result = await databaseClient.pool.query<{ id: string }>(
    `
      insert into prose_blocks (revision_id, section_id, ordinal, kind, content, image_id)
      values ($1, $2, $3, $4, $5::jsonb, $6)
      returning id
    `,
    [
      revisionId,
      sectionId,
      ordinal,
      isImage ? 'image' : 'paragraph',
      JSON.stringify(
        isImage
          ? { kind: 'image', imageId, alt: 'Image' }
          : { kind: 'paragraph', fragments: [{ text: 'Text', marks: [] }] }
      ),
      imageId
    ]
  );
  return result.rows[0]!.id;
}

async function createComicPage(revisionId: string, ordinal = 1): Promise<string> {
  const result = await databaseClient.pool.query<{ id: string }>(
    `
      insert into comic_pages
        (revision_id, ordinal, source_path, storage_key, media_type, checksum_sha256,
         byte_size, width, height)
      values ($1, $2, $3, $4, 'image/webp', repeat('b', 64), 100, 10, 20)
      returning id
    `,
    [
      revisionId,
      ordinal,
      `page-${ordinal + 1}.png`,
      `titles/test/revisions/${revisionId}/derived/page-${ordinal + 1}.webp`
    ]
  );
  return result.rows[0]!.id;
}

describe('Plan 2 migrations', () => {
  it('creates every Plan 2 table', async () => {
    const result = await databaseClient.pool.query<{ table_name: string }>(
      `
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name
      `,
      [PLAN_2_TABLES]
    );

    expect(result.rows.map((row) => row.table_name)).toEqual(PLAN_2_TABLES);
  });
});

describe('Plan 4 publication schema', () => {
  it('creates every publication manifest table', async () => {
    const result = await databaseClient.pool.query<{ table_name: string }>(
      `
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name
      `,
      [PLAN_4_TABLES]
    );

    expect(result.rows.map((row) => row.table_name)).toEqual(PLAN_4_TABLES);
  });

  it('allows only one active revision per title', async () => {
    const titleId = await createTitle();
    await createRevision(titleId, 'active');

    await expect(createRevision(titleId, 'active')).rejects.toMatchObject({ code: '23505' });
  });

  it('prevents an active revision pointer from crossing titles', async () => {
    const firstTitleId = await createTitle();
    const secondTitleId = await createTitle();
    const firstRevisionId = await createRevision(firstTitleId, 'active');

    await expect(
      databaseClient.pool.query(`update titles set active_revision_id = $1 where id = $2`, [
        firstRevisionId,
        secondTitleId
      ])
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps section, block, and page ordinals unique within their parents', async () => {
    const proseRevisionId = await createRevision(await createTitle('prose'));
    const sectionId = await createProseSection(proseRevisionId);
    await expect(createProseSection(proseRevisionId)).rejects.toMatchObject({ code: '23505' });
    await createProseBlock(proseRevisionId, sectionId);
    await expect(createProseBlock(proseRevisionId, sectionId)).rejects.toMatchObject({
      code: '23505'
    });

    const comicRevisionId = await createRevision(await createTitle('comic'));
    await createComicPage(comicRevisionId);
    await expect(createComicPage(comicRevisionId)).rejects.toMatchObject({ code: '23505' });
  });

  it('permits one draft and one published presentation but rejects duplicates', async () => {
    const revisionId = await createRevision(await createTitle('prose'));
    const sectionId = await createProseSection(revisionId);
    const blockId = await createProseBlock(revisionId, sectionId);
    const values = [revisionId, sectionId, blockId];
    const insert = (state: 'draft' | 'published') =>
      databaseClient.pool.query(
        `
          insert into revision_presentations
            (revision_id, state, reading_direction, guided_view_enabled,
             preview_prose_section_id, preview_prose_block_id)
          values ($1, $2, 'ltr', false, $3, $4)
        `,
        [values[0], state, values[1], values[2]]
      );

    await insert('draft');
    await insert('published');
    await expect(insert('draft')).rejects.toMatchObject({ code: '23505' });
    await expect(insert('published')).rejects.toMatchObject({ code: '23505' });
  });

  it('allows incomplete drafts but rejects invalid published preview shapes', async () => {
    const revisionId = await createRevision(await createTitle('prose'));
    const sectionId = await createProseSection(revisionId);
    const blockId = await createProseBlock(revisionId, sectionId);
    const pageId = await createComicPage(revisionId);

    await expect(
      databaseClient.pool.query(
        `insert into revision_presentations
          (revision_id, state, reading_direction, guided_view_enabled)
         values ($1, 'draft', 'ltr', false)`,
        [revisionId]
      )
    ).resolves.toBeDefined();
    await expect(
      databaseClient.pool.query(
        `insert into revision_presentations
          (revision_id, state, reading_direction, guided_view_enabled)
         values ($1, 'published', 'ltr', false)`,
        [revisionId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      databaseClient.pool.query(
        `insert into revision_presentations
          (revision_id, state, reading_direction, guided_view_enabled,
           preview_prose_section_id, preview_prose_block_id, preview_comic_page_id)
         values ($1, 'published', 'ltr', false, $2, $3, $4)`,
        [revisionId, sectionId, blockId, pageId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces positive in-bounds comic panel rectangles', async () => {
    const revisionId = await createRevision(await createTitle('comic'));
    const pageId = await createComicPage(revisionId);
    const presentation = await databaseClient.pool.query<{ id: string }>(
      `
        insert into revision_presentations
          (revision_id, state, reading_direction, guided_view_enabled, preview_comic_page_id)
        values ($1, 'published', 'ltr', true, $2)
        returning id
      `,
      [revisionId, pageId]
    );
    const presentationId = presentation.rows[0]!.id;
    const insertPanel = (x: number, width: number) =>
      databaseClient.pool.query(
        `
          insert into comic_panel_regions
            (revision_id, presentation_id, page_id, ordinal, x, y, width, height)
          values ($1, $2, $3, 0, $4, 0, $5, 1)
        `,
        [revisionId, presentationId, pageId, x, width]
      );

    await expect(insertPanel(0.1, 0.5)).resolves.toBeDefined();
    await expect(insertPanel(0, 0)).rejects.toMatchObject({ code: '23514' });
    await expect(insertPanel(0.8, 0.3)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects cross-revision blocks, images, presentations, and panels', async () => {
    const titleId = await createTitle('prose');
    const firstRevisionId = await createRevision(titleId);
    const secondRevisionId = await createRevision(titleId);
    const firstSectionId = await createProseSection(firstRevisionId);
    const secondSectionId = await createProseSection(secondRevisionId);
    const firstImageId = await createProseImage(firstRevisionId);

    await expect(
      createProseBlock(secondRevisionId, firstSectionId, 0)
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      createProseBlock(secondRevisionId, secondSectionId, 0, firstImageId)
    ).rejects.toMatchObject({ code: '23503' });

    const firstBlockId = await createProseBlock(firstRevisionId, firstSectionId);
    await expect(
      databaseClient.pool.query(
        `
          insert into revision_presentations
            (revision_id, state, reading_direction, guided_view_enabled,
             preview_prose_section_id, preview_prose_block_id)
          values ($1, 'published', 'ltr', false, $2, $3)
        `,
        [secondRevisionId, firstSectionId, firstBlockId]
      )
    ).rejects.toMatchObject({ code: '23503' });

    const comicTitleId = await createTitle('comic');
    const firstComicRevisionId = await createRevision(comicTitleId);
    const secondComicRevisionId = await createRevision(comicTitleId);
    const firstPageId = await createComicPage(firstComicRevisionId);
    const secondPageId = await createComicPage(secondComicRevisionId);
    const presentation = await databaseClient.pool.query<{ id: string }>(
      `
        insert into revision_presentations
          (revision_id, state, reading_direction, guided_view_enabled, preview_comic_page_id)
        values ($1, 'published', 'ltr', true, $2)
        returning id
      `,
      [secondComicRevisionId, secondPageId]
    );

    await expect(
      databaseClient.pool.query(
        `
          insert into comic_panel_regions
            (revision_id, presentation_id, page_id, ordinal, x, y, width, height)
          values ($1, $2, $3, 0, 0, 0, 1, 1)
        `,
        [secondComicRevisionId, presentation.rows[0]!.id, firstPageId]
      )
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('cascades manifests while preserving append-only audit history', async () => {
    const titleId = await createTitle();
    const revisionId = await createRevision(titleId);
    await createProseSection(revisionId);
    await databaseClient.pool.query(
      `
        insert into audit_events
          (actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id)
        values ('system', 'system:test', 'catalog.test', 'succeeded', 'title', $1,
                'schema-cascade')
      `,
      [titleId]
    );

    await databaseClient.pool.query(`delete from titles where id = $1`, [titleId]);

    const manifests = await databaseClient.pool.query<{ count: string }>(
      `select count(*) from prose_sections where revision_id = $1`,
      [revisionId]
    );
    const audit = await databaseClient.pool.query<{ count: string }>(
      `select count(*) from audit_events where correlation_id = 'schema-cascade'`
    );
    expect(manifests.rows[0]!.count).toBe('0');
    expect(audit.rows[0]!.count).toBe('1');
    await expect(
      databaseClient.pool.query(
        `delete from audit_events where correlation_id = 'schema-cascade'`
      )
    ).rejects.toThrow();
  });

  it('stores sanitized request metadata and permits historical null values', async () => {
    await databaseClient.pool.query(
      `
        insert into audit_events
          (actor_type, actor_id, action, outcome, resource_type, correlation_id,
           request_metadata)
        values
          ('system', 'system:test', 'catalog.test', 'succeeded', 'title',
           'metadata-present',
           '{"method":"POST","routeId":"/admin/catalog/[id]"}'::jsonb),
          ('system', 'system:test', 'catalog.test', 'succeeded', 'title',
           'metadata-null', null)
      `
    );
    const result = await databaseClient.pool.query<{
      correlation_id: string;
      request_metadata: unknown;
    }>(
      `
        select correlation_id, request_metadata
        from audit_events
        where correlation_id in ('metadata-present', 'metadata-null')
        order by correlation_id
      `
    );

    expect(result.rows).toEqual([
      { correlation_id: 'metadata-null', request_metadata: null },
      {
        correlation_id: 'metadata-present',
        request_metadata: { method: 'POST', routeId: '/admin/catalog/[id]' }
      }
    ]);
  });
});

describe('Plan 5 reader library schema', () => {
  it('creates every entitlement and reader-state table', async () => {
    const result = await databaseClient.pool.query<{ table_name: string }>(
      `
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name
      `,
      [PLAN_5_TABLES]
    );

    expect(result.rows.map((row) => row.table_name)).toEqual(PLAN_5_TABLES);
  });

  it('keeps semantic fingerprint digest and version paired while allowing legacy nulls', async () => {
    const proseRevisionId = await createRevision(await createTitle('prose'));
    const sectionId = await createProseSection(proseRevisionId);
    const blockId = await createProseBlock(proseRevisionId, sectionId);
    const comicRevisionId = await createRevision(await createTitle('comic'));
    const pageId = await createComicPage(comicRevisionId);

    await expect(
      databaseClient.pool.query(
        `update prose_blocks
         set semantic_fingerprint_sha256 = repeat('a', 64), semantic_fingerprint_version = 1
         where id = $1`,
        [blockId]
      )
    ).resolves.toBeDefined();
    await expect(
      databaseClient.pool.query(
        `update prose_blocks set semantic_fingerprint_version = null where id = $1`,
        [blockId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      databaseClient.pool.query(
        `update comic_pages
         set semantic_fingerprint_sha256 = 'NOT-A-DIGEST', semantic_fingerprint_version = 1
         where id = $1`,
        [pageId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      databaseClient.pool.query(
        `update comic_pages
         set semantic_fingerprint_sha256 = repeat('b', 64), semantic_fingerprint_version = 1
         where id = $1`,
        [pageId]
      )
    ).resolves.toBeDefined();
  });

  it('stores one effective entitlement row per user and title', async () => {
    const userId = await createUser();
    const titleId = await createTitle();

    await databaseClient.pool.query(
      `insert into entitlements (user_id, title_id) values ($1, $2)`,
      [userId, titleId]
    );
    await expect(
      databaseClient.pool.query(
        `insert into entitlements (user_id, title_id) values ($1, $2)`,
        [userId, titleId]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      databaseClient.pool.query(
        `update entitlements set revoked_at = clock_timestamp(), updated_at = clock_timestamp()
         where user_id = $1 and title_id = $2`,
        [userId, titleId]
      )
    ).resolves.toBeDefined();
  });

  it('enforces semantic progress shape and same-title same-revision anchors', async () => {
    const userId = await createUser();
    const firstTitleId = await createTitle('prose');
    const firstRevisionId = await createRevision(firstTitleId);
    const firstSectionId = await createProseSection(firstRevisionId);
    const firstBlockId = await createProseBlock(firstRevisionId, firstSectionId);
    const secondTitleId = await createTitle('prose');
    const secondRevisionId = await createRevision(secondTitleId);
    const secondSectionId = await createProseSection(secondRevisionId);
    const secondBlockId = await createProseBlock(secondRevisionId, secondSectionId);

    await expect(
      databaseClient.pool.query(
        `insert into reader_progress
           (user_id, title_id, revision_id, format, block_id, prose_offset, version)
         values ($1, $2, $3, 'prose', $4, 0, 1)`,
        [userId, firstTitleId, firstRevisionId, firstBlockId]
      )
    ).resolves.toBeDefined();
    await expect(
      databaseClient.pool.query(
        `insert into reader_progress
           (user_id, title_id, revision_id, format, block_id, prose_offset,
            page_id, panel_ordinal, version)
         values ($1, $2, $3, 'prose', $4, 0, $5, 0, 1)`,
        [userId, secondTitleId, secondRevisionId, secondBlockId, await createComicPage(secondRevisionId)]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      databaseClient.pool.query(
        `insert into reader_progress
           (user_id, title_id, revision_id, format, block_id, prose_offset, version)
         values ($1, $2, $3, 'prose', $4, 0, 1)`,
        [userId, secondTitleId, secondRevisionId, firstBlockId]
      )
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      databaseClient.pool.query(
        `insert into reader_progress
           (user_id, title_id, revision_id, format, block_id, prose_offset, version)
         values ($1, $2, $3, 'prose', $4, 0, 1)`,
        [userId, firstTitleId, secondRevisionId, secondBlockId]
      )
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('deduplicates prose and comic bookmark locations independently', async () => {
    const userId = await createUser();
    const proseTitleId = await createTitle('prose');
    const proseRevisionId = await createRevision(proseTitleId);
    const sectionId = await createProseSection(proseRevisionId);
    const blockId = await createProseBlock(proseRevisionId, sectionId);
    const comicTitleId = await createTitle('comic');
    const comicRevisionId = await createRevision(comicTitleId);
    const pageId = await createComicPage(comicRevisionId);

    const insertProse = (offset: number) => databaseClient.pool.query(
      `insert into reader_bookmarks
         (user_id, title_id, revision_id, format, block_id, prose_offset)
       values ($1, $2, $3, 'prose', $4, $5)`,
      [userId, proseTitleId, proseRevisionId, blockId, offset]
    );
    await insertProse(0);
    await insertProse(1);
    await expect(insertProse(0)).rejects.toMatchObject({ code: '23505' });

    const insertComic = () => databaseClient.pool.query(
      `insert into reader_bookmarks
         (user_id, title_id, revision_id, format, page_id, panel_ordinal)
       values ($1, $2, $3, 'comic', $4, null)`,
      [userId, comicTitleId, comicRevisionId, pageId]
    );
    await insertComic();
    await expect(insertComic()).rejects.toMatchObject({ code: '23505' });
  });

  it('bounds preference values and versions', async () => {
    const firstUserId = await createUser();
    const secondUserId = await createUser();
    const titleId = await createTitle('comic');

    await expect(
      databaseClient.pool.query(
        `insert into reader_preferences (user_id, font_size, typeface, paper, version)
         values ($1, 18, 'serif', 'white', 1)`,
        [firstUserId]
      )
    ).resolves.toBeDefined();
    await expect(
      databaseClient.pool.query(
        `insert into reader_preferences (user_id, font_size, typeface, paper, version)
         values ($1, 13, 'serif', 'white', 1)`,
        [secondUserId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      databaseClient.pool.query(
        `insert into reader_title_preferences (user_id, title_id, comic_mode, version)
         values ($1, $2, 'guided', 0)`,
        [firstUserId, titleId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('records one nonnegative migration outcome per user title and target revision', async () => {
    const userId = await createUser();
    const titleId = await createTitle();
    const sourceRevisionId = await createRevision(titleId);
    const otherSourceRevisionId = await createRevision(titleId);
    const targetRevisionId = await createRevision(titleId);

    await databaseClient.pool.query(
      `insert into reader_revision_migrations
         (user_id, title_id, source_revision_id, target_revision_id, progress_result,
          panel_position_simplified, migrated_bookmark_count, unmatched_bookmark_count)
       values ($1, $2, $3, $4, 'migrated', true, 1, 2)`,
      [userId, titleId, sourceRevisionId, targetRevisionId]
    );
    await expect(
      databaseClient.pool.query(
        `insert into reader_revision_migrations
           (user_id, title_id, source_revision_id, target_revision_id, progress_result)
         values ($1, $2, $3, $4, 'absent')`,
        [userId, titleId, otherSourceRevisionId, targetRevisionId]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      databaseClient.pool.query(
        `insert into reader_revision_migrations
           (user_id, title_id, source_revision_id, target_revision_id, progress_result,
            unmatched_bookmark_count)
         values ($1, $2, $3, $4, 'reset', -1)`,
        [userId, titleId, sourceRevisionId, otherSourceRevisionId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      databaseClient.pool.query(
        `insert into reader_revision_migrations
           (user_id, title_id, source_revision_id, target_revision_id, progress_result,
            panel_position_simplified)
         values ($1, $2, $3, $4, 'reset', true)`,
        [userId, titleId, sourceRevisionId, otherSourceRevisionId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});
