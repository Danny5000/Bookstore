<script>
  import { page } from '$app/stores';
  import { theme, THEMES } from '$lib/stores/theme.svelte.js';
  import { session } from '$lib/stores/session.svelte.js';

  let { onsignin } = $props();

  const links = [
    { href: '/catalog', label: 'Catalog' },
    { href: '/library', label: 'My Shelf' },
    { href: '/studio', label: 'Studio' }
  ];
</script>

<header>
  <a class="brand" href="/">
    <span class="dot"></span>
    <span class="wordmark">Pale Orbit</span>
    <span class="mono">Press</span>
  </a>

  <nav>
    {#each links as l}
      <a href={l.href} class:active={$page.url.pathname.startsWith(l.href)}>{l.label}</a>
    {/each}
  </nav>

  <div class="spacer"></div>

  <div class="themes">
    {#each THEMES as t}
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

  {#if session.user}
    <a class="account" href="/library"><span class="dot small"></span><span class="who">{session.user.email}</span></a>
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
