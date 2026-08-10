<script lang="ts">
  import { resolve } from '$app/paths';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<svelte:head><title>Claim status · Pale Orbit</title></svelte:head>

<main class="claim-shell">
  <section aria-labelledby="claim-status-heading">
    <p class="mono">Guest checkout</p>
    {#if data.state === 'claimed'}
      <h1 id="claim-status-heading" class="display">Purchases claimed</h1>
      <p role="status">Your eligible purchases are now attached to this account.</p>
      <a class="primary" href={resolve('/library')}>Open your library</a>
    {:else if data.state === 'retry'}
      <h1 id="claim-status-heading" class="display">Link unavailable</h1>
      <p>The sign-in or verification link is invalid or expired. Request a new link to continue.</p>
      <a class="primary" href={resolve('/claim')}>Request another claim link</a>
    {:else if data.state === 'sign_in'}
      <h1 id="claim-status-heading" class="display">Sign in to continue</h1>
      <p>Use a verified account with the same checkout email, then return through a new claim link.</p>
      <a class="primary" href={resolve('/?auth=required')}>Sign in</a>
      <a href={resolve('/claim')}>Request another claim link</a>
    {:else if data.state === 'not_claimed'}
      <h1 id="claim-status-heading" class="display">Claim not completed</h1>
      <p>We could not attach purchases to this account. Check that the account is verified, then request another link.</p>
      <a class="primary" href={resolve('/claim')}>Request another claim link</a>
    {:else}
      <h1 id="claim-status-heading" class="display">Try again later</h1>
      <p role="status">The claim service is temporarily unavailable. No changes were made.</p>
      <a class="primary" href={resolve('/claim')}>Return to claim purchases</a>
    {/if}
  </section>
</main>

<style>
  .claim-shell {
    width: min(100% - 32px, 640px);
    margin: 72px auto;
  }

  section {
    padding: clamp(24px, 6vw, 48px);
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--raised);
  }

  h1 {
    margin: 6px 0 14px;
    font-size: clamp(38px, 8vw, 64px);
    line-height: 0.96;
  }

  section > p {
    color: var(--muted);
  }

  a {
    display: inline-block;
    margin: 20px 14px 0 0;
    color: var(--accent);
  }

  a.primary {
    padding: 10px 16px;
    border-radius: 4px;
    background: var(--accent);
    color: var(--surface);
    font-weight: 800;
    text-decoration: none;
  }

  a:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
</style>
