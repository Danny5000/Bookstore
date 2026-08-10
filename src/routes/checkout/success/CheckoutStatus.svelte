<script lang="ts">
  import { resolve } from '$app/paths';
  import type { OrderStatusDto } from '$lib/types/commerce';

  interface Props {
    status?: OrderStatusDto;
    timedOut?: boolean;
    pollFailed?: boolean;
  }

  let {
    status = { status: 'pending' },
    timedOut = false,
    pollFailed = false
  }: Props = $props();

  function refresh(): void {
    globalThis.location.reload();
  }
</script>

<section class="success wrap">
  <div class="mono accent">Checkout return</div>

  {#if timedOut || pollFailed}
    <div class="panel failure" role="alert">
      <h1 class="display">We are still checking</h1>
      <p>
        {timedOut
          ? 'Confirmation is taking longer than expected. Your payment may still complete.'
          : 'We could not refresh this purchase status. Your payment status has not been changed.'}
      </p>
      <button class="btn" type="button" onclick={refresh}>Refresh status</button>
    </div>
  {:else if status.status === 'pending'}
    <div class="panel" role="status">
      <h1 class="display">Confirming your purchase</h1>
      <p>Some payment methods take longer to confirm. You can safely leave this page and return later.</p>
    </div>
  {:else if status.status === 'paid'}
    <div class="panel" role="status">
      <h1 class="display">Purchase complete</h1>
      <p>Your titles are ready. Progress, bookmarks, reading, and downloads stay with your account.</p>
      <a class="btn" href={resolve('/library')}>Open your library</a>
    </div>
  {:else if status.status === 'paid_guest'}
    <div class="panel" role="status">
      <h1 class="display">Purchase complete</h1>
      <p>Check your email for a secure claim link. You can claim the purchase after signing in or creating an account.</p>
    </div>
  {:else}
    <div class="panel failure" role="alert">
      <h1 class="display">
        {status.status === 'expired'
          ? 'Checkout expired'
          : status.status === 'failed'
            ? 'Payment was not completed'
            : 'Purchase confirmation needs review'}
      </h1>
      <p>
        {status.status === 'exception'
          ? 'Please return to your cart or contact support if you believe payment completed.'
          : 'Your cart is still available so you can review it and try again.'}
      </p>
      <a class="btn" href={resolve('/cart')}>Return to your cart</a>
    </div>
  {/if}
</section>

<style>
  .success { max-width: 760px; padding-top: 80px; padding-bottom: 110px; }
  .accent { color: var(--accent); margin-bottom: 12px; }
  .panel { padding: 38px; border: 1px solid var(--line); background: var(--raised); }
  .panel.failure { border-left: 4px solid #d45f5f; }
  h1 { margin: 0 0 18px; font-size: 44px; }
  p { max-width: 58ch; margin: 0 0 26px; color: var(--muted); line-height: 1.65; }
  button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in oklab, var(--accent) 65%, white); outline-offset: 3px; }
</style>
