<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { invalidateAll } from '$app/navigation';
  import '../app.css';
  import Header from '$lib/components/Header.svelte';
  import AuthModal from '$lib/components/AuthModal.svelte';
  import { page } from '$app/stores';

  interface Props {
    children: Snippet;
    data: LayoutData;
  }

  let { children, data }: Props = $props();
  let authOpen = $state($page.url.searchParams.get('auth') === 'signin');

  const isReader = $derived($page.url.pathname.startsWith('/read/'));
</script>

<Header user={data.user} onsignin={() => (authOpen = true)} />

{@render children()}

{#if !isReader}
  <footer>
    <span>PALE ORBIT PRESS &middot; EST. 2026</span>
    <span>Terms &middot; Privacy &middot; Contact</span>
  </footer>
{/if}

<AuthModal
  open={authOpen}
  onclose={() => (authOpen = false)}
  onauthenticated={() => {
    authOpen = false;
    void invalidateAll();
  }}
/>

<style>
  footer {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 34px 48px;
    border-top: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    color: var(--muted);
  }
</style>
