<script lang="ts">
  import { onMount } from 'svelte';
  import { cart } from '$lib/commerce/cart.svelte';
  import {
    clearPendingCheckout,
    loadPendingCheckout,
    pollOrderStatus
  } from '$lib/commerce/checkout-client';
  import type { OrderStatusDto } from '$lib/types/commerce';
  import CheckoutStatus from './CheckoutStatus.svelte';
  import type { PageData } from './$types';

  interface Props { data: PageData; }
  let { data }: Props = $props();
  let status = $state<OrderStatusDto>({ status: 'pending' });
  let timedOut = $state(false);
  let pollFailed = $state(false);

  function finishTerminal(terminal: Exclude<OrderStatusDto, { status: 'pending' }>): void {
    if (terminal.status === 'paid' || terminal.status === 'paid_guest') {
      const pending = loadPendingCheckout(globalThis.sessionStorage);
      cart.completePaid(pending?.acceptedTitleIds ?? []);
    } else {
      cart.rotateAttempt();
    }
    clearPendingCheckout(globalThis.sessionStorage);
  }

  onMount(() => {
    const controller = new AbortController();
    void pollOrderStatus(globalThis.fetch, data.orderId, {
      signal: controller.signal,
      onStatus: (next) => { status = next; }
    }).then((result) => {
      if (result.outcome === 'timeout') timedOut = true;
      if (result.outcome === 'terminal') finishTerminal(result.status);
    }).catch(() => {
      if (!controller.signal.aborted) pollFailed = true;
    });
    return () => controller.abort();
  });
</script>

<svelte:head><title>Purchase status · Pale Orbit Press</title></svelte:head>

<CheckoutStatus {status} {timedOut} {pollFailed} />
