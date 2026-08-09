<script lang="ts">
  import { resolve } from '$app/paths';
  import type { PageData } from './$types';
  interface Props { data: PageData; }
  let { data }: Props = $props();
  function formatted(value: unknown): string { return JSON.stringify(value, null, 2) ?? 'null'; }
</script>

<svelte:head><title>{data.event.action} · Audit · Pale Orbit</title></svelte:head>
<header><a href={resolve('/admin/audit')}>← Audit trail</a><p class="mono">{data.event.outcome} · {data.event.occurredAt.toLocaleString()}</p><h2 class="display">{data.event.action}</h2></header>

<dl>
  <div><dt>Actor</dt><dd>{data.event.actorType}{data.event.actorId ? ` · ${data.event.actorId}` : ''}</dd></div>
  <div><dt>Resource</dt><dd>{data.event.resourceType}{data.event.resourceId ? ` · ${data.event.resourceId}` : ''}</dd></div>
  <div><dt>Correlation</dt><dd>{data.event.correlationId}</dd></div>
  <div><dt>Event ID</dt><dd>{data.event.id}</dd></div>
</dl>

<div class="contexts">
  <section><h3 class="mono">Request metadata</h3><pre>{formatted(data.event.requestMetadata)}</pre></section>
  <section><h3 class="mono">Before</h3><pre>{formatted(data.event.before)}</pre></section>
  <section><h3 class="mono">After</h3><pre>{formatted(data.event.after)}</pre></section>
</div>

<style>
  header { margin-bottom: 26px; }
  header .mono { margin: 20px 0 4px; color: var(--muted); }
  h2 { margin: 0; font-size: 42px; overflow-wrap: anywhere; }
  dl { display: grid; gap: 1px; margin: 0 0 28px; background: var(--line); border: 1px solid var(--line); }
  dl div { display: grid; grid-template-columns: 140px 1fr; gap: 16px; padding: 10px 12px; background: var(--surface); }
  dt { color: var(--muted); font: 10px var(--font-mono); text-transform: uppercase; }
  dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
  .contexts { display: grid; gap: 18px; }
  section { min-width: 0; }
  pre { margin: 8px 0 0; padding: 16px; overflow: auto; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: 12px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
