<script lang="ts">
  import { cart } from '$lib/commerce/cart.svelte';
  import { MAX_CART_TITLES } from '$lib/types/commerce';

  interface Props {
    titleId: string;
    titleLabel: string;
    owned?: boolean;
    unavailable?: boolean;
  }

  let {
    titleId,
    titleLabel,
    owned = false,
    unavailable = false
  }: Props = $props();

  const inCart = $derived(cart.titleIds.includes(titleId));
  const capped = $derived(!inCart && cart.size >= MAX_CART_TITLES);
  const disabled = $derived(owned || unavailable || capped);
  const accessibleName = $derived.by(() => {
    if (owned) return `${titleLabel} is already owned`;
    if (unavailable) return `${titleLabel} is unavailable`;
    if (capped) return `Cart limit reached; remove an item before adding ${titleLabel}`;
    return inCart ? `Remove ${titleLabel} from cart` : `Add ${titleLabel} to cart`;
  });
  const buttonLabel = $derived(
    owned ? 'Owned' : unavailable ? 'Unavailable' : capped ? 'Cart full' : inCart ? 'Remove' : 'Add to cart'
  );

  function toggle(): void {
    if (disabled) return;
    if (inCart) cart.remove(titleId);
    else cart.add(titleId);
  }
</script>

<button
  class="cart-toggle"
  type="button"
  disabled={disabled}
  aria-label={accessibleName}
  onclick={toggle}
>{buttonLabel}</button>

<style>
  .cart-toggle {
    min-height: 38px;
    padding: 8px 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--raised);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .cart-toggle:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .cart-toggle:focus-visible {
    outline: 3px solid color-mix(in oklab, var(--accent) 65%, white);
    outline-offset: 3px;
  }

  .cart-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.62;
  }
</style>
