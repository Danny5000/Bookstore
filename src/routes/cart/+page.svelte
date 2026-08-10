<script lang="ts">
  import { onMount } from 'svelte';
  import { cart } from '$lib/commerce/cart.svelte';
  import {
    CheckoutClientError,
    QuoteRequestCoordinator,
    buildCheckoutRequest,
    clearPendingCheckout,
    createCheckout,
    storePendingCheckout
  } from '$lib/commerce/checkout-client';
  import type { CommerceQuoteDto } from '$lib/types/commerce';
  import CartReview from './CartReview.svelte';
  import type { PageData } from './$types';

  interface Props { data: PageData; }
  type Phase = 'loading' | 'empty' | 'ready' | 'error';
  type Issue = 'mixed_currency' | 'quote_unavailable' | 'checkout_unavailable';

  let { data }: Props = $props();
  let phase = $state<Phase>('loading');
  let quote = $state<CommerceQuoteDto | null>(null);
  let issue = $state<Issue | null>(null);
  let requiresConfirmation = $state(false);
  let submitting = $state(false);
  const quoteRequests = new QuoteRequestCoordinator();

  onMount(() => {
    if (data.canceled) clearPendingCheckout(globalThis.sessionStorage);
  });

  function quoteFailure(error: unknown): Issue {
    return error instanceof CheckoutClientError && error.kind === 'invalid_cart'
      ? 'mixed_currency'
      : 'quote_unavailable';
  }

  async function refresh(titleIds: readonly string[]): Promise<void> {
    requiresConfirmation = false;
    issue = null;
    quote = null;
    if (titleIds.length === 0) {
      quoteRequests.cancel();
      phase = 'empty';
      return;
    }
    phase = 'loading';
    try {
      const result = await quoteRequests.refresh(globalThis.fetch, titleIds);
      if (result.status === 'stale') return;
      quote = result.quote;
      phase = 'ready';
    } catch (error) {
      issue = quoteFailure(error);
      phase = 'error';
    }
  }

  function remove(titleId: string): void {
    cart.remove(titleId);
  }

  async function checkout(): Promise<void> {
    if (submitting || !quote?.canCheckout) return;
    submitting = true;
    const reviewedQuote = quote;
    try {
      const result = await createCheckout(
        globalThis.fetch,
        buildCheckoutRequest(cart.titleIds, reviewedQuote, cart.checkoutAttemptId)
      );
      if (result.status === 'cart_changed') {
        quote = result.quote;
        issue = null;
        phase = 'ready';
        requiresConfirmation = true;
        return;
      }
      try {
        storePendingCheckout(globalThis.sessionStorage, {
          acceptedTitleIds: reviewedQuote.items.map((item) => item.titleId),
          checkoutAttemptId: cart.checkoutAttemptId
        });
      } catch {
        // Checkout remains authoritative when private browsing blocks session storage.
      }
      globalThis.location.assign(result.checkoutUrl);
    } catch (error) {
      if (error instanceof CheckoutClientError && error.kind === 'attempt_conflict') {
        cart.rotateAttempt();
      }
      issue = 'checkout_unavailable';
      phase = 'error';
    } finally {
      submitting = false;
    }
  }

  $effect(() => {
    const titleIds = cart.titleIds;
    void refresh(titleIds);
    return () => quoteRequests.cancel();
  });
</script>

<svelte:head><title>Cart · Pale Orbit Press</title></svelte:head>

<CartReview
  {phase}
  {quote}
  {issue}
  canceled={data.canceled}
  {requiresConfirmation}
  {submitting}
  onremove={remove}
  oncheckout={checkout}
  onretry={() => refresh(cart.titleIds)}
/>
