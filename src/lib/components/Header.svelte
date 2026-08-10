<script lang="ts">
  import { page } from '$app/stores';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { authClient } from '$lib/auth/client';
  import { cart } from '$lib/commerce/cart.svelte';
  import { theme, THEMES } from '$lib/stores/theme.svelte';
  import type { SessionUser } from '$lib/types/auth';

  interface Props {
    user: SessionUser | null;
    onsignin: () => void;
  }

  let { user, onsignin }: Props = $props();
  const liveSession = authClient.useSession();
  let signingOut = $state(false);
  const activeEmail = $derived($liveSession.data?.user.email ?? user?.email ?? null);

  async function signOut(): Promise<void> {
    signingOut = true;
    try {
      await authClient.signOut();
      await invalidateAll();
    } finally {
      signingOut = false;
    }
  }

  const links = [
    { href: '/catalog', label: 'Catalog' },
    { href: '/library', label: 'My Shelf' },
    { href: '/studio', label: 'Studio' }
  ] as const;
</script>

<header>
  <a class="brand" href={resolve('/')}>
    <span class="dot"></span>
    <span class="wordmark">Pale Orbit</span>
    <span class="mono">Press</span>
  </a>

  <nav>
    {#each links as l (l.href)}
      <a href={resolve(l.href)} class:active={$page.url.pathname.startsWith(l.href)}>{l.label}</a>
    {/each}
    {#if user?.roles.includes('admin')}
      <a href={resolve('/admin')} class:active={$page.url.pathname.startsWith('/admin')}>Admin</a>
    {/if}
  </nav>

  <div class="spacer"></div>

  <a
    class="cart-link"
    href={resolve('/cart')}
    aria-label={`Cart, ${cart.size} items`}
    class:active={$page.url.pathname.startsWith('/cart')}
  >
    <span>Cart</span>
    <span class="cart-count" aria-hidden="true">{cart.size}</span>
  </a>
  <span class="sr-only" aria-live="polite" aria-atomic="true">Cart contains {cart.size} items</span>

  <div class="themes">
    {#each THEMES as t (t.id)}
      <button
        class="chip"
        class:on={theme.current === t.id}
        style:background={t.chip}
        title={t.label}
        aria-label="Use {t.label} theme"
        onclick={() => theme.set(t.id)}
      ></button>
    {/each}
  </div>

  {#if activeEmail}
    <a class="account" href={resolve('/library')}><span class="dot small"></span><span class="who">{activeEmail}</span></a>
    <button class="signout" disabled={signingOut} onclick={signOut}>
      {signingOut ? 'Signing out…' : 'Sign out'}
    </button>
  {:else}
    <button class="account" onclick={onsignin}><span class="dot small"></span><span class="who">Sign in</span></button>
  {/if}
</header>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 28px;
    height: 68px;
    padding: 0 28px;
    background: color-mix(in oklab, var(--bg) 88%, transparent);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line);
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex: 0 0 auto;
    color: var(--ink);
  }

  .wordmark {
    font-family: var(--font-display);
    font-size: 22px;
    white-space: nowrap;
  }

  .dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--accent);
    align-self: center;
  }

  .dot.small {
    width: 6px;
    height: 6px;
  }

  nav {
    display: flex;
    gap: 22px;
    font-size: 14px;
  }

  nav a {
    color: var(--muted);
  }

  nav a:hover,
  nav a.active {
    color: var(--ink);
  }

  .spacer {
    flex: 1;
  }

  .themes {
    display: flex;
    gap: 8px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 999px;
  }

  .cart-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
  }

  .cart-link:hover,
  .cart-link.active {
    color: var(--ink);
  }

  .cart-link:focus-visible {
    outline: 3px solid color-mix(in oklab, var(--accent) 65%, white);
    outline-offset: 4px;
    border-radius: 4px;
  }

  .cart-count {
    display: inline-grid;
    place-items: center;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--bg);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .chip {
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--line);
    cursor: pointer;
  }

  .chip.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 40%, transparent);
  }

  .account {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 16px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--raised);
    color: var(--ink);
    font-size: 13px;
    cursor: pointer;
    min-width: 0;
  }

  .who {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account:hover {
    border-color: var(--accent);
  }

  .signout {
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }

  .signout:hover:not(:disabled) {
    color: var(--ink);
  }

  .signout:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  /* Everything here shrinks or drops rather than wrapping: a wrapped header
     grows past the viewport and drags the page off-centre under it. */
  @media (max-width: 700px) {
    nav {
      display: none;
    }
    header {
      padding: 0 16px;
      gap: 14px;
    }
    .wordmark {
      font-size: 18px;
    }
    .brand .mono {
      display: none;
    }
    .account {
      padding: 7px 12px;
      max-width: 40vw;
    }
  }
</style>
