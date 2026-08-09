<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';
  import { invalidateAll, replaceState } from '$app/navigation';
  import { resolve } from '$app/paths';
  import '../app.css';
  import Header from '$lib/components/Header.svelte';
  import AuthModal from '$lib/components/AuthModal.svelte';
  import { page } from '$app/stores';

  interface Props {
    children: Snippet;
    data: LayoutData;
  }

  let { children, data }: Props = $props();
  let lastAuthRequest = $state<string | null>(null);
  let authOpen = $state(false);

  $effect(() => {
    const authRequest = $page.url.searchParams.get('auth');
    if (
      authRequest !== lastAuthRequest &&
      (authRequest === 'signin' || authRequest === 'required')
    ) {
      authOpen = true;
    }
    lastAuthRequest = authRequest;
  });

  const isReader = $derived($page.url.pathname.startsWith('/read/'));

  function clearAuthRequest(): void {
    if (!$page.url.searchParams.has('auth')) return;
    replaceState(resolve('/'), {});
  }

  function closeAuth(): void {
    authOpen = false;
    clearAuthRequest();
  }

  function authenticated(): void {
    authOpen = false;
    clearAuthRequest();
    void invalidateAll();
  }
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
  onclose={closeAuth}
  onauthenticated={authenticated}
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
