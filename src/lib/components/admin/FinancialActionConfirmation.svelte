<script lang="ts">
  import type { Snippet } from 'svelte';

  interface HiddenField {
    readonly name: string;
    readonly value: string | number;
  }

  interface Props {
    headingId: string;
    heading: string;
    action: string;
    submitLabel: string;
    warnings: readonly string[];
    hiddenFields: readonly HiddenField[];
    children: Snippet;
  }

  let {
    headingId,
    heading,
    action,
    submitLabel,
    warnings,
    hiddenFields,
    children
  }: Props = $props();

  const warningsId = $derived(`${headingId}-warnings`);
</script>

<section class="financial-action-confirmation" aria-labelledby={headingId}>
  <header>
    <h2 id={headingId}>{heading}</h2>
    <ul id={warningsId} class="confirmation-warnings">
      {#each warnings as warning (warning)}
        <li>{warning}</li>
      {/each}
    </ul>
  </header>

  {@render children()}

  <form method="POST" {action} aria-describedby={warningsId}>
    {#each hiddenFields as field, index (index)}
      <input type="hidden" name={field.name} value={field.value} />
    {/each}
    <button type="submit">{submitLabel}</button>
  </form>
</section>

<style>
  .financial-action-confirmation {
    display: grid;
    gap: 1rem;
    border: 1px solid var(--border-color, #bbb);
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .confirmation-warnings {
    display: grid;
    gap: 0.4rem;
    margin-block: 0.75rem 0;
  }
</style>
