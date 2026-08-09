<script lang="ts">
  import { resolve } from '$app/paths';
  interface Values {
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    outcome: string;
    from: string;
    to: string;
    pageSize: number;
  }
  interface Props { values: Values; }
  let { values }: Props = $props();
</script>

<form method="GET" action={resolve('/admin/audit')} class="filters">
  <label><span>Actor ID</span><input name="actorId" value={values.actorId} maxlength="200" /></label>
  <label><span>Action</span><input name="action" value={values.action} maxlength="200" placeholder="catalog.title.update" /></label>
  <label><span>Resource type</span><input name="resourceType" value={values.resourceType} maxlength="200" /></label>
  <label><span>Resource ID</span><input name="resourceId" value={values.resourceId} maxlength="200" /></label>
  <label><span>Outcome</span><select name="outcome" value={values.outcome}><option value="">Any</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="denied">Denied</option></select></label>
  <label><span>From · UTC ISO</span><input name="from" value={values.from} maxlength="200" placeholder="2026-08-01T00:00:00Z" /></label>
  <label><span>To · UTC ISO</span><input name="to" value={values.to} maxlength="200" placeholder="2026-08-09T23:59:59Z" /></label>
  <label><span>Rows</span><select name="pageSize" value={String(values.pageSize)}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></label>
  <div class="buttons"><button type="submit">Apply filters</button><a href={resolve('/admin/audit')}>Clear</a></div>
</form>

<style>
  .filters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 18px; border: 1px solid var(--line); background: var(--surface); }
  label { display: grid; gap: 5px; color: var(--muted); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; }
  input, select { min-width: 0; padding: 9px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font: 12px var(--font-mono); text-transform: none; letter-spacing: 0; }
  .buttons { display: flex; align-items: center; gap: 12px; grid-column: 1 / -1; }
  button { padding: 9px 14px; border: 1px solid var(--accent); background: none; color: var(--accent); cursor: pointer; }
  .buttons a { font-size: 12px; }
  @media (max-width: 1000px) { .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 560px) { .filters { grid-template-columns: 1fr; } }
</style>
