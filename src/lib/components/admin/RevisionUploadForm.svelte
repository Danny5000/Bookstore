<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';

  interface Props {
    titleId: string;
    format: 'prose' | 'comic';
    parentRevisionId?: string | null;
  }

  let { titleId, format, parentRevisionId = null }: Props = $props();
  let busy = $state(false);
  let ready = $state(false);
  let message = $state('');

  onMount(() => {
    ready = true;
  });

  async function upload(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!(event.currentTarget instanceof HTMLFormElement) || busy) return;
    busy = true;
    message = 'Uploading…';
    try {
      const response = await fetch(
        resolve('/admin/catalog/[titleId]/revisions/upload', { titleId }),
        { method: 'POST', body: new FormData(event.currentTarget) }
      );
      const body = await response.json() as { revisionId?: string; message?: string };
      if (!response.ok || !body.revisionId) {
        message = body.message ?? 'Upload failed';
        return;
      }
      await goto(resolve('/admin/catalog/[titleId]/revisions/[revisionId]', {
        titleId,
        revisionId: body.revisionId
      }));
    } catch {
      message = 'Upload failed. Check the connection and try again.';
    } finally {
      busy = false;
    }
  }
</script>

<form class="upload" onsubmit={upload}>
  <label>
    <span class="mono">Corrected original</span>
    <input
      name="original"
      type="file"
      accept={format === 'prose' ? '.epub,application/epub+zip' : '.cbz,.zip,application/zip'}
      required
    />
  </label>
  <label><span class="mono">Change summary</span><textarea class="field" name="changeSummary" rows="3" required maxlength="2000"></textarea></label>
  <input type="hidden" name="parentRevisionId" value={parentRevisionId ?? ''} />
  <button class="btn" type="submit" disabled={!ready || busy}>{busy ? 'Uploading…' : 'Upload immutable revision'}</button>
  {#if message}<p class="message" role="status">{message}</p>{/if}
</form>

<style>
  .upload, label { display: grid; gap: 9px; }
  .upload { padding: 20px; border: 1px solid var(--line); background: var(--surface); }
  textarea { resize: vertical; }
  .btn { justify-self: start; }
  .message { margin: 0; color: var(--muted); font-size: 13px; }
</style>
