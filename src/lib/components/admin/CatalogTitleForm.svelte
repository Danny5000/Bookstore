<script lang="ts">
  interface TitleValue {
    slug: string;
    title: string;
    subtitle: string | null;
    description: string;
    creatorName: string;
    format: 'prose' | 'comic';
    priceMinor: number;
    currency: string;
  }

  interface Props {
    value?: TitleValue | null;
    action?: string;
    message?: string | null | undefined;
    submitLabel?: string;
  }

  let {
    value = null,
    action = '',
    message = null,
    submitLabel = value ? 'Save metadata' : 'Create private title'
  }: Props = $props();
</script>

<form method="POST" {action} class="title-form">
  {#if message}<p class="notice" role="status">{message}</p>{/if}
  <div class="pair">
    <label><span class="mono">Title</span><input class="field" name="title" value={value?.title ?? ''} required maxlength="300" /></label>
    <label><span class="mono">Slug</span><input class="field" name="slug" value={value?.slug ?? ''} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label>
  </div>
  <label><span class="mono">Subtitle</span><input class="field" name="subtitle" value={value?.subtitle ?? ''} maxlength="300" /></label>
  <label><span class="mono">Description</span><textarea class="field" name="description" rows="6" required maxlength="20000">{value?.description ?? ''}</textarea></label>
  <div class="pair">
    <label><span class="mono">Creator</span><input class="field" name="creatorName" value={value?.creatorName ?? ''} required maxlength="300" /></label>
    {#if value}
      <label><span class="mono">Format</span><input class="field" value={value.format === 'prose' ? 'EPUB prose' : 'CBZ / ZIP comic'} disabled /></label>
    {:else}
      <label><span class="mono">Format</span><select class="field" name="format"><option value="prose">EPUB prose</option><option value="comic">CBZ / ZIP comic</option></select></label>
    {/if}
  </div>
  <div class="pair">
    <label><span class="mono">Price · minor units</span><input class="field" name="priceMinor" type="number" min="0" step="1" value={value?.priceMinor ?? 0} required /></label>
    <label><span class="mono">Currency</span><input class="field" name="currency" value={value?.currency ?? 'USD'} pattern="[A-Za-z]{3}" maxlength="3" required /></label>
  </div>
  <button class="btn" type="submit">{submitLabel}</button>
</form>

<style>
  .title-form { display: grid; gap: 16px; }
  label { display: grid; gap: 7px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  textarea { resize: vertical; line-height: 1.55; }
  .btn { justify-self: start; }
  .notice { margin: 0; padding: 10px 12px; border: 1px solid var(--line); color: var(--accent); }
  @media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
</style>
