<script lang="ts">
  import { resolve } from '$app/paths';
  import AuditFilters from '$lib/components/admin/AuditFilters.svelte';
  import type { PageData } from './$types';
  interface Props { data: PageData; }
  let { data }: Props = $props();
</script>

<svelte:head><title>Audit trail · Pale Orbit Admin</title></svelte:head>
<header><p class="mono">Append-only operations</p><h2 class="display">Audit trail</h2><p>Filtering the list is not audited. Opening a detail record is.</p></header>
<AuditFilters values={data.values} />

<div class="events">
  {#each data.page.events as event (event.id)}
    <a class="event" href={resolve('/admin/audit/[eventId]', { eventId: event.id })}>
      <time datetime={event.occurredAt.toISOString()}>{event.occurredAt.toLocaleString()}</time>
      <span class="action">{event.action}</span>
      <span>{event.actorType}{event.actorId ? ` · ${event.actorId}` : ''}</span>
      <span>{event.resourceType}{event.resourceId ? ` · ${event.resourceId}` : ''}</span>
      <span class:failed={event.outcome !== 'succeeded'} class="outcome">{event.outcome}</span>
    </a>
  {:else}<p class="empty">No audit events match these filters.</p>{/each}
</div>

{#if data.nextUrl}
  <!-- The strict server parser generated this same-route continuation URL. -->
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
  <a class="next" href={data.nextUrl}>Next page →</a>
{/if}

<style>
  header { margin-bottom: 22px; }
  h2 { margin: 5px 0; font-size: 46px; }
  header p:last-child { color: var(--muted); }
  .events { display: grid; margin-top: 24px; border-top: 1px solid var(--line); }
  .event { display: grid; grid-template-columns: 150px minmax(180px, 1fr) minmax(130px, 1fr) minmax(130px, 1fr) auto; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); color: var(--muted); font: 11px var(--font-mono); overflow-wrap: anywhere; }
  .event:hover, .action { color: var(--ink); }
  .outcome { color: #3c8d69; text-transform: uppercase; }
  .outcome.failed { color: var(--accent); }
  .next { display: inline-block; margin-top: 20px; }
  .empty { color: var(--muted); }
  @media (max-width: 900px) { .event { grid-template-columns: 1fr 1fr; } }
</style>
