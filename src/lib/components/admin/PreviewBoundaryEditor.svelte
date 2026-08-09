<script lang="ts">
  import { untrack } from 'svelte';
  import type { ReaderDocument } from '$lib/types/publication';

  interface Draft {
    readingDirection: 'ltr' | 'rtl';
    guidedViewEnabled: boolean;
    previewProseSectionId: string | null;
    previewProseBlockId: string | null;
    previewComicPageId: string | null;
  }

  interface Props {
    document: ReaderDocument;
    draft: Draft;
  }

  let { document, draft }: Props = $props();
  let sectionId = $state(untrack(() => draft.previewProseSectionId ?? ''));
  let blockId = $state(untrack(() => draft.previewProseBlockId ?? ''));
  let pageId = $state(untrack(() => draft.previewComicPageId ?? ''));

  function chooseProse(event: Event): void {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    [sectionId = '', blockId = ''] = event.currentTarget.value.split(':');
  }
</script>

<fieldset>
  <legend class="mono">Reader settings</legend>
  <label><span>Reading direction</span><select class="field" name="readingDirection" value={draft.readingDirection}><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>
  {#if document.format === 'prose'}
    <label>
      <span>Free preview ends after</span>
      <select class="field" onchange={chooseProse} value={`${sectionId}:${blockId}`} required>
        {#each document.sections as section (section.id)}
          {#each section.blocks as block (block.id)}
            <option value={`${section.id}:${block.id}`}>{section.label ?? `Section ${section.ordinal + 1}`} · {block.content.kind} {block.ordinal + 1}</option>
          {/each}
        {/each}
      </select>
    </label>
    <input type="hidden" name="previewSectionId" value={sectionId} />
    <input type="hidden" name="previewBlockId" value={blockId} />
    <input type="hidden" name="previewPageId" value="" />
    <input type="hidden" name="guidedViewEnabled" value="false" />
  {:else}
    <label>
      <span>Free preview ends after</span>
      <select class="field" name="previewPageId" bind:value={pageId} required>
        {#each document.pages as page (page.id)}<option value={page.id}>Page {page.ordinal}</option>{/each}
      </select>
    </label>
    <label class="check"><input type="checkbox" name="guidedViewEnabled" value="true" checked={draft.guidedViewEnabled} /><span>Enable guided panel view when every page has a sequence</span></label>
    <input type="hidden" name="previewSectionId" value="" />
    <input type="hidden" name="previewBlockId" value="" />
  {/if}
</fieldset>

<style>
  fieldset { display: grid; gap: 14px; margin: 0; padding: 18px; border: 1px solid var(--line); }
  legend { padding: 0 8px; }
  label { display: grid; gap: 7px; font-size: 14px; }
  .check { grid-template-columns: auto 1fr; align-items: center; }
</style>
