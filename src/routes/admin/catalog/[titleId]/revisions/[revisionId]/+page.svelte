<script lang="ts">
  import { resolve } from '$app/paths';
  import BookReader from '$lib/components/BookReader.svelte';
  import PanelEditor from '$lib/components/admin/PanelEditor.svelte';
  import PreviewBoundaryEditor from '$lib/components/admin/PreviewBoundaryEditor.svelte';
  import PublicationActions from '$lib/components/admin/PublicationActions.svelte';
  import RevisionStatus from '$lib/components/admin/RevisionStatus.svelte';
  import { createMemoryReaderPersistence } from '$lib/reader/persistence';
  import type { ActionData, PageData } from './$types';
  interface Props { data: PageData; form: ActionData; }
  let { data, form }: Props = $props();
  const statusUrl = $derived(resolve('/admin/catalog/[titleId]/revisions/[revisionId]/status', {
    titleId: data.review.title.id,
    revisionId: data.review.revision.id
  }));
  const processing = $derived(['uploaded', 'processing'].includes(data.review.revision.state));
  const reviewPersistence = $derived(
    data.document
      ? createMemoryReaderPersistence({
          document: data.document,
          initialState: {
            progress: null,
            bookmarks: [],
            preferences: { fontSize: 18, typeface: 'serif', paper: 'white', version: 0 },
            titlePreferences: null,
            migrationNotice: null
          }
        })
      : null
  );
</script>

<svelte:head><title>Review {data.review.title.title} · Pale Orbit Admin</title></svelte:head>
<header class="heading">
  <div><p class="mono">Revision review · {data.review.revision.state.replaceAll('_', ' ')}</p><h2 class="display">{data.review.title.title}</h2><p>{data.review.revision.changeSummary}</p></div>
  <a href={resolve('/admin/catalog/[titleId]', { titleId: data.review.title.id })}>← Title</a>
</header>
{#if form?.message}<p class="notice" role="status">{form.message}</p>{/if}

<RevisionStatus url={statusUrl} initial={{
  state: data.review.revision.state,
  processingStartedAt: data.review.revision.processingStartedAt,
  processedAt: data.review.revision.processedAt,
  failure: data.review.revision.failure,
  warnings: data.review.warnings
}} onstatus={(status) => { if (!['uploaded', 'processing'].includes(status.state)) window.location.reload(); }} />

<div class="facts">
  {#if data.review.revision.original}
    <a href={resolve('/admin/catalog/[titleId]/revisions/[revisionId]/original', {
      titleId: data.review.title.id,
      revisionId: data.review.revision.id
    })}>Download {data.review.revision.original.filename}</a>
    <span>{data.review.revision.original.mediaType} · {data.review.revision.original.byteSize.toLocaleString()} bytes</span>
    <span class="mono">SHA-256 {data.review.revision.original.checksumSha256}</span>
  {:else}<span>Original metadata becomes available after successful ingestion.</span>{/if}
</div>

{#if data.review.suggestion}
  <section class="suggestion">
    <img src={data.review.suggestion.url} alt="Suggested cover" />
    <div><h3 class="display">Ingested cover suggestion</h3><p>{data.review.suggestion.sourceDescription}</p><form method="POST" action="?/confirmCover"><input type="hidden" name="suggestionId" value={data.review.suggestion.id} /><button type="submit">Use as title cover</button></form></div>
  </section>
{/if}

{#if data.document && data.review.draft && reviewPersistence}
  <section class="settings">
    <h3 class="display">Draft reader settings</h3>
    <form method="POST" action="?/saveSettings">
      <input type="hidden" name="presentationId" value={data.review.draft.id} />
      <input type="hidden" name="expectedUpdatedAt" value={data.review.draft.updatedAt.toISOString()} />
      <input type="hidden" name="format" value={data.document.format} />
      <PreviewBoundaryEditor document={data.document} draft={data.review.draft} />
      {#if data.document.format === 'comic'}<PanelEditor pages={data.document.pages} />{:else}<input type="hidden" name="panels" value="[]" />{/if}
      <button type="submit">Save private draft</button>
    </form>
    <form method="POST" action="?/publishSettings" onsubmit={(event) => { if (!window.confirm('Publish these reader settings? The reviewed preview boundary becomes eligible for activation or immediate public use.')) event.preventDefault(); }}>
      <input type="hidden" name="presentationId" value={data.review.draft.id} />
      <input type="hidden" name="expectedUpdatedAt" value={data.review.draft.updatedAt.toISOString()} />
      <button class="publish" type="submit">Publish reader settings</button>
    </form>
  </section>
  <section class="reader"><h3 class="display">Full private review</h3><BookReader document={data.document} persistence={reviewPersistence} /></section>
{/if}

<PublicationActions
  visibility={data.review.title.visibility}
  activeRevisionId={data.review.title.activeRevisionId}
  revisionId={data.review.revision.id}
  revisionState={data.review.revision.state}
  hasPublishedSettings={!!data.review.published}
  retryAvailable={data.review.revision.retryAvailable}
/>
{#if processing}<p class="waiting">Publishing controls stay hidden until processing completes.</p>{/if}

<style>
  .heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
  h2 { margin: 5px 0; font-size: 44px; }
  h3 { margin: 0 0 15px; font-size: 28px; }
  .heading p:last-child, .facts, .waiting { color: var(--muted); }
  .facts { display: grid; gap: 5px; margin: 18px 0 32px; font-size: 12px; overflow-wrap: anywhere; }
  .suggestion { display: grid; grid-template-columns: 140px 1fr; gap: 20px; margin: 28px 0; padding: 18px; border: 1px solid var(--line); }
  .suggestion img { width: 140px; height: 200px; object-fit: cover; }
  .settings { display: grid; gap: 16px; margin: 34px 0; }
  .settings form:first-of-type { display: grid; gap: 18px; }
  button { justify-self: start; padding: 10px 14px; border: 1px solid var(--line); background: none; color: var(--ink); cursor: pointer; }
  button.publish { border-color: var(--accent); color: var(--accent); }
  .reader { margin: 38px 0; border-top: 1px solid var(--line); padding-top: 28px; }
  .notice { padding: 10px; border: 1px solid var(--accent); color: var(--accent); }
  @media (max-width: 680px) { .suggestion { grid-template-columns: 1fr; } }
</style>
