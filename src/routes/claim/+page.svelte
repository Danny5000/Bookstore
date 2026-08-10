<script lang="ts">
  import type { ActionData } from './$types';

  interface Props {
    form: ActionData;
  }

  let { form }: Props = $props();
</script>

<svelte:head><title>Claim purchases · Pale Orbit</title></svelte:head>

<main class="claim-shell">
  <section aria-labelledby="claim-heading">
    <p class="mono">Guest checkout</p>
    <h1 id="claim-heading" class="display">Claim your purchases</h1>
    <p>Use the email address entered at checkout. We will send the next safe step if it is available.</p>

    {#if form?.invalid}
      <div class="notice error" role="alert" tabindex="-1">
        <h2>Check your email address</h2>
        <p>Enter a valid email address and try again.</p>
      </div>
    {:else if form?.unavailable}
      <p class="notice" role="status">We could not process the request just now. Please try again later.</p>
    {:else if form?.sent}
      <p class="notice" role="status">
        If eligible purchases exist, we’ll send instructions shortly. Check your inbox and spam folder.
      </p>
    {/if}

    <form method="POST">
      <label for="claim-email">Checkout email</label>
      <input
        id="claim-email"
        name="email"
        type="email"
        autocomplete="email"
        inputmode="email"
        maxlength="320"
        required
      />
      <button type="submit">Send claim link</button>
    </form>
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

  form {
    display: grid;
    gap: 10px;
    margin-top: 28px;
  }

  label {
    font-weight: 700;
  }

  input,
  button {
    min-height: 46px;
    border: 1px solid var(--line);
    border-radius: 4px;
    font: inherit;
  }

  input {
    padding: 10px 12px;
    background: var(--surface);
    color: inherit;
  }

  button {
    margin-top: 6px;
    padding: 10px 18px;
    background: var(--accent);
    color: var(--surface);
    cursor: pointer;
    font-weight: 800;
  }

  input:focus-visible,
  button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }

  .notice {
    margin-top: 22px;
    padding: 14px 16px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    color: inherit;
  }

  .notice h2 {
    margin: 0 0 4px;
    font-size: 18px;
  }

  .notice p {
    margin: 0;
  }

  .notice.error {
    border-color: oklch(0.62 0.2 25);
  }
</style>
