<script lang="ts">
  interface Props {
    visibility: 'private' | 'public' | 'archived';
    activeRevisionId: string | null;
    revisionId: string;
    revisionState: 'uploaded' | 'processing' | 'ready_for_review' | 'failed' | 'active' | 'retired';
    hasPublishedSettings: boolean;
    retryAvailable: boolean;
  }

  let {
    visibility,
    activeRevisionId,
    revisionId,
    revisionState,
    hasPublishedSettings,
    retryAvailable
  }: Props = $props();

  function confirmEffect(event: SubmitEvent, message: string): void {
    if (!window.confirm(message)) event.preventDefault();
  }
</script>

<section class="actions">
  <div class="mono">Publication actions</div>
  {#if revisionState === 'failed' && retryAvailable}
    <form method="POST" action="?/retry" onsubmit={(event) => confirmEffect(event, 'Retry processing this retained upload? The live title will not change.') }>
      <button type="submit">Retry processing</button>
    </form>
  {/if}
  {#if revisionState === 'ready_for_review' && hasPublishedSettings && visibility === 'private'}
    <form method="POST" action="?/activatePrivate" onsubmit={(event) => confirmEffect(event, activeRevisionId ? 'Make this revision the private active revision? The storefront remains hidden.' : 'Activate this reviewed revision privately? It will remain hidden from the storefront.') }>
      <button type="submit">{activeRevisionId ? 'Replace private active revision' : 'Activate privately'}</button>
    </form>
  {/if}
  {#if revisionState === 'ready_for_review' && hasPublishedSettings && visibility === 'public' && !!activeRevisionId && activeRevisionId !== revisionId}
    <form method="POST" action="?/publishReplacement" onsubmit={(event) => confirmEffect(event, 'Publish this revision as the public replacement now? The current live revision will be retired.') }>
      <button type="submit">Publish replacement</button>
    </form>
  {/if}
  {#if revisionState === 'retired' && hasPublishedSettings && visibility !== 'archived' && !!activeRevisionId && activeRevisionId !== revisionId}
    <form method="POST" action="?/rollback" onsubmit={(event) => confirmEffect(event, visibility === 'public' ? 'Roll the public title back to this retired revision now? The current live revision will be retired.' : 'Roll the private active title back to this retired revision?') }>
      <button type="submit">Roll back to this revision</button>
    </form>
  {/if}
  {#if !retryAvailable && revisionState === 'failed'}
    <p>The retained retry source is unavailable. Upload a new immutable revision.</p>
  {/if}
</section>

<style>
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 18px; border: 1px solid var(--line); }
  .actions .mono { width: 100%; }
  form { margin: 0; }
  button { padding: 10px 14px; border: 1px solid var(--accent); background: none; color: var(--accent); cursor: pointer; }
  p { margin: 0; color: var(--muted); font-size: 13px; }
</style>
