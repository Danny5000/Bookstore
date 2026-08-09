<script lang="ts">
  import { authClient } from '$lib/auth/client';
  import { normalizeBrowserEmail, validateRegistration } from '$lib/auth/forms';

  type AuthMode = 'signin' | 'register' | 'verify-request' | 'magic' | 'reset-request';

  interface Props {
    open?: boolean;
    onclose?: () => void;
    onauthenticated?: () => void;
  }

  let { open = false, onclose, onauthenticated }: Props = $props();
  let mode = $state<AuthMode>('signin');
  let email = $state('');
  let name = $state('');
  let password = $state('');
  let confirmation = $state('');
  let pending = $state(false);
  let sent = $state(false);
  let errorMessage = $state('');

  const copy = {
    signin: {
      title: 'Welcome back',
      intro: 'Your shelf and your place in every book follow you here.',
      action: 'Sign in'
    },
    register: {
      title: 'Create your account',
      intro: 'Keep your purchases and reading progress together.',
      action: 'Create account'
    },
    'verify-request': {
      title: 'Resend verification',
      intro: 'Request a fresh link to finish setting up your account.',
      action: 'Send verification link'
    },
    magic: {
      title: 'Magic link',
      intro: 'We’ll email you a single-use sign-in link.',
      action: 'Email me a link'
    },
    'reset-request': {
      title: 'Reset your password',
      intro: 'We’ll email you a link to choose a new password.',
      action: 'Send reset link'
    }
  } as const;

  function switchMode(next: AuthMode): void {
    mode = next;
    password = '';
    confirmation = '';
    errorMessage = '';
    sent = false;
  }

  function genericSentMessage(): string {
    if (mode === 'register') return 'Check your email to finish registration.';
    if (mode === 'verify-request') return 'If verification is available, a link is on its way.';
    if (mode === 'magic') return 'If sign-in is available, a link is on its way.';
    return 'If an account exists for that address, a reset link is on its way.';
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMessage = '';
    const normalizedEmail = normalizeBrowserEmail(email);
    if (!normalizedEmail) {
      errorMessage = 'Email is required.';
      return;
    }
    if (mode === 'register') {
      const validationError = validateRegistration(name, password, confirmation);
      if (validationError) {
        errorMessage = validationError;
        return;
      }
    }

    pending = true;
    try {
      if (mode === 'signin') {
        const result = await authClient.signIn.email({
          email: normalizedEmail,
          password,
          rememberMe: true
        });
        if (result.error) {
          errorMessage = result.error.message || 'Unable to sign in.';
          return;
        }
        onauthenticated?.();
        return;
      }
      if (mode === 'register') {
        const result = await authClient.signUp.email({
          email: normalizedEmail,
          password,
          name: name.trim(),
          callbackURL: '/library'
        });
        if (result.error) {
          errorMessage = result.error.message || 'Unable to create the account.';
          return;
        }
      } else if (mode === 'verify-request') {
        const result = await authClient.sendVerificationEmail({
          email: normalizedEmail,
          callbackURL: '/library'
        });
        if (result.error) {
          errorMessage = result.error.message || 'Unable to send the verification request.';
          return;
        }
      } else if (mode === 'magic') {
        const result = await authClient.signIn.magicLink({
          email: normalizedEmail,
          callbackURL: '/library'
        });
        if (result.error) {
          errorMessage = result.error.message || 'Unable to send the sign-in request.';
          return;
        }
      } else {
        const result = await authClient.requestPasswordReset({
          email: normalizedEmail,
          redirectTo: '/reset-password'
        });
        if (result.error) {
          errorMessage = result.error.message || 'Unable to send the reset request.';
          return;
        }
      }
      email = normalizedEmail;
      password = '';
      confirmation = '';
      sent = true;
    } finally {
      pending = false;
    }
  }
</script>

{#if open}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && onclose?.()}
  >
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <h3 id="auth-title" class="display">{copy[mode].title}</h3>
      <p>{copy[mode].intro}</p>

      {#if sent}
        <p class="sent" role="status">{genericSentMessage()}</p>
        <button class="btn ghost full" type="button" onclick={() => switchMode('signin')}>
          Back to sign in
        </button>
      {:else}
        <form class="stack" onsubmit={submit}>
          {#if mode === 'register'}
            <label>
              <span>Display name</span>
              <input class="field" bind:value={name} autocomplete="name" required />
            </label>
          {/if}
          <label>
            <span>Email</span>
            <input
              class="field"
              bind:value={email}
              autocomplete="email"
              placeholder="you@email.com"
              type="email"
              required
            />
          </label>
          {#if mode === 'signin' || mode === 'register'}
            <label>
              <span>Password</span>
              <input
                class="field"
                bind:value={password}
                autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
                type="password"
                minlength={mode === 'register' ? 12 : undefined}
                required
              />
            </label>
          {/if}
          {#if mode === 'register'}
            <label>
              <span>Confirm password</span>
              <input
                class="field"
                bind:value={confirmation}
                autocomplete="new-password"
                type="password"
                minlength="12"
                required
              />
            </label>
          {/if}
          {#if mode === 'magic'}
            <p class="note">Password accounts must finish email verification before magic-link sign-in.</p>
          {/if}
          {#if errorMessage}
            <p class="error" role="alert">{errorMessage}</p>
          {/if}
          <button class="btn" type="submit" disabled={pending}>
            {pending ? 'Please wait…' : copy[mode].action}
          </button>
        </form>
      {/if}

      {#if !sent}
        <div class="mode-links">
          {#if mode !== 'signin'}
            <button class="switch" type="button" onclick={() => switchMode('signin')}>Password sign in</button>
          {/if}
          {#if mode !== 'register'}
            <button class="switch" type="button" onclick={() => switchMode('register')}>Create an account</button>
          {/if}
          {#if mode !== 'magic'}
            <button class="switch" type="button" onclick={() => switchMode('magic')}>Use a magic link</button>
          {/if}
          {#if mode !== 'verify-request'}
            <button class="switch" type="button" onclick={() => switchMode('verify-request')}>Resend verification</button>
          {/if}
          {#if mode !== 'reset-request'}
            <button class="switch" type="button" onclick={() => switchMode('reset-request')}>Forgot password?</button>
          {/if}
        </div>
      {/if}
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

  label {
    display: grid;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }

  .sent {
    margin: 0 0 18px;
    color: var(--accent);
  }

  .error {
    margin: 0;
    color: oklch(0.72 0.17 25);
  }

  .note {
    margin: 0;
    font-size: 12px;
  }

  .full {
    width: 100%;
  }

  .mode-links {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 2px 14px;
    margin-top: 18px;
  }

  .switch {
    display: inline;
    margin: 0;
    padding: 4px 0;
    border: 0;
    background: none;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.7;
  }
</style>
