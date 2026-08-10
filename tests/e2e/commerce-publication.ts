import type { Page } from '@playwright/test';
import {
  activateAndPublish,
  createTitle,
  publishSettings,
  saveDraft,
  selectBoundary,
  uploadRevision,
  waitUntilReady
} from './publication-admin';

export async function publishCommerceProse(
  page: Page,
  input: { slug: string; title: string; bytes: Buffer }
): Promise<{ titleId: string; slug: string; revisionId: string }> {
  const titleId = await createTitle(page, {
    slug: input.slug,
    title: input.title,
    format: 'prose',
    description: 'A published title used by the commerce browser journeys.'
  });
  const revision = await uploadRevision(page, {
    filename: `${input.slug}.epub`,
    mimeType: 'application/epub+zip',
    bytes: input.bytes,
    summary: 'Commerce journey edition'
  });
  await waitUntilReady(page);
  await selectBoundary(page, 'paragraph');
  await saveDraft(page);
  await publishSettings(page);
  await activateAndPublish(page);
  return { titleId, slug: input.slug, revisionId: revision.revisionId };
}
