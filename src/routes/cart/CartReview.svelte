<script lang="ts">
  import { resolve } from '$app/paths';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import type { CommerceQuoteDto } from '$lib/types/commerce';

  type Phase = 'loading' | 'empty' | 'ready' | 'error';
  type Issue = 'mixed_currency' | 'quote_unavailable' | 'checkout_unavailable';

  interface Props {
    phase: Phase;
    quote?: CommerceQuoteDto | null;
    issue?: Issue | null;
    canceled?: boolean;
    requiresConfirmation?: boolean;
    submitting?: boolean;
    onremove?: (titleId: string) => void;
    oncheckout?: () => void;
    onretry?: () => void;
  }

  let {
    phase,
    quote = null,
    issue = null,
    canceled = false,
    requiresConfirmation = false,
    submitting = false,
    onremove = () => undefined,
    oncheckout = () => undefined,
    onretry = () => undefined
  }: Props = $props();

  function money(amountMinor: number, currency: string): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
      amountMinor / 100
    );
  }

  function issueText(value: Issue | null): string {
    if (value === 'mixed_currency') {
      return 'Items in different currencies must be checked out separately.';
    }
    if (value === 'checkout_unavailable') {
      return 'Checkout is temporarily unavailable. Your cart has not changed.';
    }
    return 'We could not refresh your cart. Please try again.';
  }
</script>

<section class="cart-page wrap">
  <header class="page-head">
    <div class="mono accent">Storefront</div>
    <h1 class="display">Your cart</h1>
  </header>

  {#if canceled}
    <p class="notice" role="status">Checkout was canceled. Your cart is unchanged.</p>
  {/if}

  {#if phase === 'loading'}
    <p class="state" role="status">Loading your cart…</p>
  {:else if phase === 'empty'}
    <div class="state">
      <h2>Your cart is empty</h2>
      <p>Browse the catalog to add a book or comic.</p>
      <a class="btn" href={resolve('/catalog')}>Browse the catalog</a>
    </div>
  {:else if phase === 'error'}
    <div class="error" role="alert">
      <p>{issueText(issue)}</p>
      <button class="btn" type="button" onclick={onretry}>Try again</button>
    </div>
  {:else if quote}
    {#if requiresConfirmation}
      <div class="changed" role="alert">
        <strong>Your cart changed.</strong> Review the updated items and total, then confirm again.
      </div>
    {/if}

    {#if quote.items.length > 0}
      <ul class="items" aria-label="Items ready for checkout">
        {#each quote.items as item (item.titleId)}
          <li>
            <a class="item-link" href={resolve('/book/[id]', { id: item.slug })}>
              <CoverArt src={item.coverUrl} alt="" width="72px" height="104px" />
              <span class="item-copy">
                <strong>{item.title}</strong>
                <span>{item.creatorName}</span>
                <span class="mono">{item.format === 'comic' ? 'Comic' : 'Book'}</span>
              </span>
            </a>
            <span class="item-price">{money(item.unitSubtotalMinor, item.currency)}</span>
            <button
              class="remove"
              type="button"
              aria-label={`Remove ${item.title} from cart`}
              onclick={() => onremove(item.titleId)}
            >Remove</button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if quote.alreadyOwnedTitleIds.length > 0}
      <section class="rejected" aria-labelledby="owned-heading">
        <h2 id="owned-heading">Already owned</h2>
        {#each quote.alreadyOwnedTitleIds as titleId, index (titleId)}
          <div>
            <span>An item in your cart is already in your library.</span>
            <button
              type="button"
              aria-label={`Remove owned item ${index + 1}`}
              onclick={() => onremove(titleId)}
            >Remove</button>
          </div>
        {/each}
      </section>
    {/if}

    {#if quote.unavailableTitleIds.length > 0}
      <section class="rejected" aria-labelledby="unavailable-heading">
        <h2 id="unavailable-heading">Unavailable</h2>
        {#each quote.unavailableTitleIds as titleId, index (titleId)}
          <div>
            <span>An item in your cart is currently unavailable.</span>
            <button
              type="button"
              aria-label={`Remove unavailable item ${index + 1}`}
              onclick={() => onremove(titleId)}
            >Remove</button>
          </div>
        {/each}
      </section>
    {/if}

    {#if quote.currency}
      <aside class="summary" aria-label="Cart total">
        <div><span>Subtotal</span><strong>{money(quote.subtotalMinor, quote.currency)}</strong></div>
        <p>Tax calculated at checkout</p>
        <button
          class="btn"
          type="button"
          disabled={!quote.canCheckout || submitting}
          onclick={oncheckout}
        >{submitting ? 'Opening checkout…' : requiresConfirmation ? 'Confirm updated cart' : 'Continue to checkout'}</button>
      </aside>
    {/if}
  {/if}
</section>

<style>
  .cart-page { padding-top: 54px; padding-bottom: 100px; max-width: 980px; }
  .page-head { margin-bottom: 30px; }
  .accent { color: var(--accent); }
  h1 { margin: 10px 0 0; font-size: 48px; }
  .state, .error { padding: 34px; border: 1px solid var(--line); background: var(--raised); }
  .state h2 { margin-top: 0; font-family: var(--font-display); font-weight: 400; }
  .notice, .changed, .error { margin: 0 0 22px; border-left: 4px solid var(--accent); padding: 14px 18px; background: var(--raised); }
  .error { border-left-color: #d45f5f; }
  .items { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
  .items li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 18px; align-items: center; padding: 18px 0; border-bottom: 1px solid var(--line); }
  .item-link { display: flex; gap: 18px; align-items: center; color: var(--ink); min-width: 0; }
  .item-copy { display: grid; gap: 5px; min-width: 0; }
  .item-copy strong { font-family: var(--font-display); font-size: 20px; font-weight: 400; }
  .item-copy > span { color: var(--muted); font-size: 13px; }
  .item-price { font-family: var(--font-mono); font-size: 13px; }
  .remove, .rejected button { border: 0; background: none; color: var(--muted); text-decoration: underline; cursor: pointer; }
  button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in oklab, var(--accent) 65%, white); outline-offset: 3px; }
  .rejected { margin-top: 22px; padding: 18px; border: 1px solid var(--line); }
  .rejected h2 { margin: 0 0 12px; font-family: var(--font-display); font-size: 20px; font-weight: 400; }
  .rejected > div { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 7px 0; color: var(--muted); }
  .summary { width: min(100%, 420px); margin: 30px 0 0 auto; padding: 24px; border: 1px solid var(--line); background: var(--raised); }
  .summary > div { display: flex; justify-content: space-between; gap: 20px; font-size: 18px; }
  .summary p { margin: 8px 0 20px; color: var(--muted); font-size: 12px; }
  .summary .btn { width: 100%; }
  .summary .btn:disabled { cursor: wait; opacity: 0.65; }
  @media (max-width: 600px) {
    .items li { grid-template-columns: minmax(0, 1fr) auto; }
    .remove { grid-column: 2; }
  }
</style>
