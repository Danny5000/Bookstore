<script lang="ts">
  import { formatSignedMinorCurrency } from '$lib/commerce/money';

  interface Props {
    amountMinor: number | null;
    currency: string | null;
    unavailableLabel?: string;
  }

  let {
    amountMinor,
    currency,
    unavailableLabel = 'Amount unavailable'
  }: Props = $props();
</script>

{#if amountMinor === null || currency === null}
  <span class="financial-amount unavailable">
    <span>{unavailableLabel}</span>
    <span class="financial-currency">{currency ?? 'Settlement currency pending'}</span>
  </span>
{:else}
  <span class="financial-amount">{formatSignedMinorCurrency(amountMinor, currency)}</span>
{/if}
