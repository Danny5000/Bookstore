<script lang="ts">
  import { session } from '$lib/stores/session.svelte';

  type AuthMode = 'signin' | 'magic';

  interface Props {
    open?: boolean;
    onclose?: () => void;
  }

  let { open = false, onclose }: Props = $props();

  let mode = $state<AuthMode>('signin');
  let email = $state('');
  let password = $state('');
  let sent = $state(false);

  function submit(): void {
    if (!email) return;
    if (mode === 'magic') {
      // POST /api/auth/magic-link in production
      sent = true;
      return;
    }
    session.signIn(email);
    onclose?.();
  }

  function oauth(_provider: 'google' | 'apple'): void {
    // Redirect to /auth/{provider} in production (see README -> Auth)
    session.signIn('reader@paleorbit.co');
    onclose?.();
  }
</script>

{#if open}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && onclose?.()}
  >
    <div class="card" role="dialog" aria-modal="true">
      <h3 class="display">
        {mode === 'magic' ? 'Magic link' : 'Welcome back'}
      </h3>
      <p>
        {mode === 'magic'
          ? "We'll email you a link. No password to remember."
          : 'Your shelf and your place in every book follow you here.'}
      </p>

      <div class="stack">
        <button class="btn ghost" onclick={() => oauth('google')}>Continue with Google</button>
        <button class="btn ghost" onclick={() => oauth('apple')}>Continue with Apple</button>
      </div>

      <div class="or"><span></span>OR<span></span></div>

      {#if sent}
        <p class="sent">Link sent to {email}. Check your inbox.</p>
      {:else}
        <div class="stack">
          <input class="field" bind:value={email} placeholder="you@email.com" type="email" />
          {#if mode !== 'magic'}
            <input class="field" bind:value={password} placeholder="Password" type="password" />
          {/if}
          <button class="btn" onclick={submit}>
            {mode === 'magic' ? 'Email me a link' : 'Sign in'}
          </button>
        </div>
      {/if}

      <button class="switch" onclick={() => (mode = mode === 'magic' ? 'signin' : 'magic')}>
        {mode === 'magic' ? 'Back to password sign in' : 'Use a magic link instead'}
      </button>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(5px);
  }

  .card {
    width: 420px;
    max-width: 100%;
    padding: 34px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    animation: fade-up 0.22s ease both;
  }

  h3 {
    font-size: 30px;
    margin: 0 0 6px;
  }

  p {
    font-size: 14px;
    color: var(--muted);
    margin: 0 0 24px;
  }

  .stack {
    display: grid;
    gap: 10px;
  }

  .or {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 20px 0;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.18em;
    color: var(--muted);
  }

  .or span {
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  .sent {
    margin: 0;
    color: var(--accent);
  }

  .switch {
    display: block;
    width: 100%;
    margin-top: 18px;
    border: 0;
    background: none;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
  }
</style>
