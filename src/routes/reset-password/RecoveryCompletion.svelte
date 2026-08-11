<script lang="ts">
  import { resolve } from '$app/paths';

  interface Props {
    commerceClaim: boolean;
    recoveryRequired?: boolean;
    signInUnavailable?: boolean;
    claimReady?: boolean;
  }

  let {
    commerceClaim,
    recoveryRequired = false,
    signInUnavailable = false,
    claimReady = false
  }: Props = $props();
</script>

{#if commerceClaim}
  {#if recoveryRequired}
    <p class="success" role="status">
      This recovery attempt could not be completed. Request a fresh claim email to continue safely.
    </p>
    <a class="btn" href={resolve('/claim')}>Request another claim email</a>
  {:else if claimReady}
    <p class="success" role="status">
      Your password has been updated and the recovered account is ready.
    </p>
    <a class="btn" href={resolve('/claim/complete')}>Claim your purchases</a>
  {:else if signInUnavailable}
    <p class="success" role="status">
      Your password has been updated, but automatic sign-in is temporarily unavailable.
    </p>
  {:else}
    <p class="success" role="status">
      Your password has been updated.
    </p>
  {/if}
  {#if !claimReady && !recoveryRequired}
    <a class="btn" href={resolve('/?auth=required&returnTo=%2Fclaim%2Fcomplete')}>Sign in to continue</a>
  {/if}
{:else}
  <p class="success" role="status">Your password has been updated.</p>
  <a class="btn" href={resolve('/?auth=signin')}>Return to sign in</a>
{/if}

<style>
  .success { color: var(--accent); }
</style>
