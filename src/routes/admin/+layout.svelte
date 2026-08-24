<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { page } from '$app/stores';
  import { resolve } from '$app/paths';

  interface Props {
    data: LayoutData;
    children: Snippet;
  }

  let { data, children }: Props = $props();
</script>

<div class="admin-shell">
  <aside>
    <p class="mono">Administration</p>
    <h1 class="display">Pale Orbit</h1>
    <p class="operator">Signed in as {data.user?.email}</p>
    <nav aria-label="Admin sections">
      <a href={resolve('/admin')} class:active={$page.url.pathname === '/admin'}>Overview</a>
      <a href={resolve('/admin/users')} class:active={$page.url.pathname.startsWith('/admin/users')}>Users</a>
      <a href={resolve('/admin/catalog')} class:active={$page.url.pathname.startsWith('/admin/catalog')}>Catalog</a>
      <a href={resolve('/admin/audit')} class:active={$page.url.pathname.startsWith('/admin/audit')}>Audit</a>
      <a href={resolve('/admin/sales')} class:active={$page.url.pathname.startsWith('/admin/sales')}>Sales</a>
    </nav>
  </aside>
  <main>{@render children()}</main>
</div>

<style>
  .admin-shell {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    min-height: calc(100vh - 68px);
  }

  aside {
    padding: 34px 28px;
    border-right: 1px solid var(--line);
    background: var(--surface);
  }

  h1 {
    margin: 4px 0 8px;
    font-size: 28px;
  }

  .operator {
    margin: 0 0 28px;
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  nav {
    display: grid;
    gap: 5px;
  }

  nav a {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 4px;
    color: var(--muted);
    font-size: 14px;
  }

  nav a:hover,
  nav a.active {
    background: var(--raised);
    color: var(--ink);
  }

  main {
    min-width: 0;
    padding: 48px;
  }

  @media (max-width: 760px) {
    .admin-shell {
      grid-template-columns: 1fr;
    }
    aside {
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    nav {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    main {
      padding: 28px 20px;
    }
  }
</style>
