<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/stores';
  import { resolve } from '$app/paths';
  import './sales.css';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  const salesRoot = resolve('/admin/sales');
  const reviewHref = `${salesRoot}/review`;
  const payoutsHref = `${salesRoot}/payouts`;
</script>

<section class="sales-workspace">
  <nav class="sales-local-nav" aria-label="Sales sections">
    <a
      href={salesRoot}
      class:active={$page.url.pathname === '/admin/sales'}
      aria-current={$page.url.pathname === '/admin/sales' ? 'page' : undefined}
    >Overview</a>
    <!-- Derived from the resolved Sales root so nested routes retain local current-page state. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a href={reviewHref}
      class:active={$page.url.pathname.startsWith('/admin/sales/review')}
      aria-current={$page.url.pathname.startsWith('/admin/sales/review') ? 'page' : undefined}
    >Needs Review</a>
    <!-- Derived from the resolved Sales root so nested routes retain local current-page state. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a href={payoutsHref}
      class:active={$page.url.pathname.startsWith('/admin/sales/payouts')}
      aria-current={$page.url.pathname.startsWith('/admin/sales/payouts') ? 'page' : undefined}
    >Payouts</a>
  </nav>
  {@render children()}
</section>
