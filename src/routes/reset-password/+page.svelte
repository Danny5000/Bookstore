<script lang="ts">
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { authClient } from '$lib/auth/client';
  import { validatePasswordConfirmation } from '$lib/auth/forms';

  const token = $derived(page.url.searchParams.get('token') ?? '');
  const linkError = $derived(page.url.searchParams.has('error'));
  let password = $state('');
  let confirmation = $state('');
  let pending = $state(false);
  let complete = $state(false);
  let errorMessage = $state('');

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMessage = '';
    const validationError = validatePasswordConfirmation(password, confirmation);
    if (validationError) {
      errorMessage = validationError;
      return;
    }
    if (!token || linkError) {
      errorMessage = 'This reset link is invalid or has expired.';
      return;
    }
    pending = true;
    try {
      const result = await authClient.resetPassword({ token, newPassword: password });
      if (result.error) {
        errorMessage = 'This reset link is invalid or has expired.';
        return;
      }
      password = '';
      confirmation = '';
      complete = true;
    } finally {
      pending = false;
    }
  }
</script>

<svelte:head><title>Reset password · Pale Orbit Press</title></svelte:head>

<main class="reset-wrap">
  <section class="card">
    <p class="mono">Account recovery</p>
    <h1 class="display">Choose a new password</h1>

    {#if complete}
      <p class="success" role="status">Your password has been updated.</p>
      <a class="btn" href={resolve('/?auth=signin')}>Return to sign in</a>
    {:else if !token || linkError}
      <p class="error" role="alert">This reset link is invalid or has expired.</p>
      <a href={resolve('/?auth=signin')}>Request another reset link</a>
    {:else}
      <p>Use at least 12 characters. This link can be used only once.</p>
      <form onsubmit={submit}>
        <label>
          <span>New password</span>
          <input
            class="field"
            bind:value={password}
            type="password"
            autocomplete="new-password"
            minlength="12"
            required
          />
        </label>
        <label>
          <span>Confirm new password</span>
          <input
            class="field"
            bind:value={confirmation}
            type="password"
            autocomplete="new-password"
            minlength="12"
            required
          />
        </label>
        {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
        <button class="btn" type="submit" disabled={pending}>
          {pending ? 'Updating…' : 'Update password'}
        </button>
      </form>
    {/if}
  </section>
</main>

<style>
  .reset-wrap {
    min-height: calc(100vh - 68px);
    display: grid;
    place-items: center;
    padding: 48px 20px;
  }

  .card {
    width: min(460px, 100%);
    padding: 36px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }

  h1 {
    margin: 4px 0 12px;
    font-size: 36px;
  }

  p {
    color: var(--muted);
  }

  form,
  label {
    display: grid;
    gap: 10px;
  }

  form {
    gap: 16px;
    margin-top: 24px;
  }

  label span {
    color: var(--muted);
    font-size: 12px;
  }

  .error {
    color: oklch(0.72 0.17 25);
  }

  .success {
    color: var(--accent);
  }

  button:disabled {
    cursor: wait;
    opacity: 0.7;
  }
</style>
