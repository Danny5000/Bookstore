<script lang="ts">
  import { resolve } from '$app/paths';
  import CatalogTitleForm from '$lib/components/admin/CatalogTitleForm.svelte';
  import RevisionUploadForm from '$lib/components/admin/RevisionUploadForm.svelte';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import type { ActionData, PageData } from './$types';
  interface Props { data: PageData; form: ActionData; }
  let { data, form }: Props = $props();
  let coverMessage = $state('');
  let coverBusy = $state(false);

  async function uploadCover(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement) || coverBusy) return;
    coverBusy = true;
    coverMessage = 'Uploading…';
    try {
      const response = await fetch(resolve('/admin/catalog/[titleId]/cover', { titleId: data.title.id }), {
        method: 'POST', body: new FormData(event.currentTarget)
      });
      const body = await response.json() as { message?: string };
      coverMessage = response.ok ? 'Cover saved. Reloading…' : body.message ?? 'Cover upload failed';
      if (response.ok) window.location.reload();
    } catch { coverMessage = 'Cover upload failed'; }
    finally { coverBusy = false; }
  }
  function confirmAction(event: SubmitEvent, message: string): void {
    if (!window.confirm(message)) event.preventDefault();
  }
</script>

<svelte:head><title>{data.title.title} · Pale Orbit Admin</title></svelte:head>
<header class="heading">
  <div><p class="mono">{data.title.visibility} · {data.title.format}</p><h2 class="display">{data.title.title}</h2></div>
  <a href={resolve('/admin/catalog')}>← Catalog</a>
</header>
{#if form?.message}<p class="notice" role="status">{form.message}</p>{/if}
<div class="columns">
  <div class="main">
    <section><h3 class="display">Metadata</h3><CatalogTitleForm value={data.title} action="?/metadata" /></section>
    <section>
      <h3 class="display">Revisions</h3>
      <div class="revisions">
        {#each data.revisions as revision (revision.id)}
          <a href={resolve('/admin/catalog/[titleId]/revisions/[revisionId]', { titleId: data.title.id, revisionId: revision.id })}>
            <span><strong>{revision.changeSummary}</strong><small>{revision.createdAt.toLocaleString()}</small></span>
            <span class="state">{revision.state.replaceAll('_', ' ')}</span>
          </a>
        {:else}<p>No revisions have been uploaded.</p>{/each}
      </div>
    </section>
    <section><h3 class="display">Upload a revision</h3><RevisionUploadForm titleId={data.title.id} format={data.title.format} parentRevisionId={data.title.activeRevisionId} /></section>
  </div>
  <aside>
    <h3 class="display">Cover</h3>
    <CoverArt src={data.title.cover?.url} alt={data.title.title} height="280px" />
    <form class="cover-form" onsubmit={uploadCover}>
      <input name="cover" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" required />
      <button type="submit" disabled={coverBusy}>Replace cover</button>
      {#if coverMessage}<p role="status">{coverMessage}</p>{/if}
    </form>
    <h3 class="display">Storefront</h3>
    {#if data.title.visibility === 'private' && data.title.activeRevisionId}
      <form method="POST" action="?/publish" onsubmit={(event) => confirmAction(event, 'Make this title publicly visible with its current active revision?')}><button class="publish" type="submit">Publish storefront</button></form>
    {:else if data.title.visibility === 'public'}
      <form method="POST" action="?/withdraw" onsubmit={(event) => confirmAction(event, 'Remove this title from the public storefront? Its files and revisions will remain private.') }><button type="submit">Withdraw storefront</button></form>
    {:else}<p>Activate a reviewed revision privately before publishing.</p>{/if}
  </aside>
</div>

<style>
  .heading { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 28px; }
  h2 { margin: 4px 0 0; font-size: 46px; }
  h3 { margin: 0 0 16px; font-size: 28px; }
  .columns { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 38px; align-items: start; }
  .main, aside { display: grid; gap: 34px; }
  section { display: grid; gap: 8px; padding-bottom: 30px; border-bottom: 1px solid var(--line); }
  .revisions { display: grid; border-top: 1px solid var(--line); }
  .revisions a { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--line); color: var(--ink); }
  .revisions a > span:first-child { display: grid; gap: 4px; }
  small, aside p, .revisions p { color: var(--muted); font-size: 12px; }
  .state { color: var(--muted); font: 10px var(--font-mono); text-transform: uppercase; }
  aside { padding: 20px; border: 1px solid var(--line); background: var(--surface); }
  .cover-form { display: grid; gap: 10px; }
  button { padding: 10px 12px; border: 1px solid var(--line); background: none; color: var(--ink); cursor: pointer; }
  button.publish { border-color: var(--accent); color: var(--accent); }
  .notice { padding: 10px; border: 1px solid var(--accent); color: var(--accent); }
  @media (max-width: 960px) { .columns { grid-template-columns: 1fr; } }
</style>
