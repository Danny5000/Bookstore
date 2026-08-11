<script lang="ts">
  import { resolve } from '$app/paths';
  import CartToggle from '$lib/components/CartToggle.svelte';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import { formatMinorCurrency } from '$lib/commerce/money';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const title = $derived(data.title);
  const price = $derived(formatMinorCurrency(title.priceMinor, title.currency));
</script>

<svelte:head><title>{title.title} · Pale Orbit Press</title></svelte:head>

<section class="detail">
  <div class="left">
    <div class="art">
      <CoverArt src={title.cover?.url} alt={title.title} width="286px" height="420px" />
    </div>

    <div class="buttons" id="purchase">
      <div class="purchase-row">
        <span class="price">{price}</span>
        <CartToggle titleId={title.id} titleLabel={title.title} />
      </div>
      <p class="tax-note mono">Tax calculated at checkout</p>
      <a class="btn ghost" href={resolve('/read/[id]', { id: title.slug })}>Read the free preview</a>
    </div>

    <dl>
      <div><dt>FORMAT</dt><dd>{title.format === 'comic' ? 'CBZ / ZIP' : 'EPUB'}</dd></div>
      <div><dt>READING</dt><dd>In-browser preview</dd></div>
      <div><dt>LENGTH</dt><dd>{title.extentCount} {title.extentUnit}</dd></div>
    </dl>
  </div>

  <div class="right">
    <div class="mono accent">{title.format === 'comic' ? 'Comic' : 'Book'}</div>
    <h1 class="display">{title.title}</h1>
    {#if title.subtitle}<p class="subtitle">{title.subtitle}</p>{/if}
    <div class="author">by {title.creatorName}</div>
    <p class="summary">{title.description}</p>

    <div class="contents">
      <div class="mono">Publication</div>
      <div class="row">
        <span>Complete original retained for download</span>
        <span class="mono plain">after purchase</span>
      </div>
      <div class="row">
        <span>Reviewed browser preview</span>
        <span class="mono plain">free</span>
      </div>
    </div>
  </div>
</section>

<style>
  .detail { display: grid; grid-template-columns: 0.9fr 1.1fr; gap: 64px; max-width: 1240px; margin: 0 auto; padding: 60px 48px 110px; }
  .buttons { display: grid; gap: 10px; margin-top: 26px; }
  .buttons .btn { text-align: center; }
  .purchase-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 0; }
  .price { font-family: var(--font-mono); color: var(--ink); }
  .tax-note { margin: -2px 0 2px; font-size: 10px; color: var(--muted); }
  .art { display: flex; align-items: center; justify-content: center; min-height: 430px; }
  dl { display: grid; gap: 8px; margin: 22px 0 0; font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
  dl > div { display: flex; justify-content: space-between; }
  dt, dd { margin: 0; }
  .accent { color: var(--accent); }
  h1 { font-size: 54px; line-height: 1.02; margin: 14px 0 10px; }
  .subtitle { margin: -2px 0 12px; font-family: var(--font-display); font-size: 24px; color: var(--muted); }
  .author { font-size: 15px; color: var(--muted); margin-bottom: 30px; }
  .summary { font-family: var(--font-display); font-size: 21px; line-height: 1.55; margin: 0 0 22px; white-space: pre-line; }
  .contents { margin-top: 34px; border-top: 1px solid var(--line); padding-top: 22px; }
  .row { display: flex; justify-content: space-between; gap: 18px; padding: 11px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
  .plain { letter-spacing: 0.1em; text-transform: none; color: var(--muted); }
  @media (max-width: 900px) { .detail { grid-template-columns: 1fr; gap: 34px; padding: 30px 20px 80px; } h1 { font-size: 38px; } }
</style>
