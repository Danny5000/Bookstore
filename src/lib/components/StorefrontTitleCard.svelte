<script lang="ts">
  import { resolve } from '$app/paths';
  import CartToggle from './CartToggle.svelte';
  import CoverArt from './CoverArt.svelte';

  interface Props {
    titleId: string;
    slug: string;
    title: string;
    creatorName: string;
    subtitle?: string | null;
    format: 'prose' | 'comic';
    coverUrl: string | null;
    priceMinor: number;
    currency: string;
    coverHeight?: string;
  }

  let {
    titleId,
    slug,
    title,
    creatorName,
    subtitle = null,
    format,
    coverUrl,
    priceMinor,
    currency,
    coverHeight = '300px'
  }: Props = $props();

  const price = $derived(
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(priceMinor / 100)
  );
</script>

<article class="card">
  <a class="title-link" href={resolve('/book/[id]', { id: slug })}>
    <CoverArt src={coverUrl} alt={title} height={coverHeight} />
    <div class="line">
      <span class="name">{title}</span>
      <span class="price">{price}</span>
    </div>
    <p>{subtitle ?? `${format === 'comic' ? 'Comic' : 'Book'} · ${creatorName}`}</p>
  </a>
  <div class="cart-action">
    <CartToggle {titleId} titleLabel={title} />
  </div>
</article>

<style>
  .card {
    min-width: 0;
    color: var(--ink);
  }

  .title-link {
    display: block;
    color: var(--ink);
  }

  .title-link:focus-visible {
    outline: 3px solid color-mix(in oklab, var(--accent) 65%, white);
    outline-offset: 5px;
    border-radius: 4px;
  }

  .line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-top: 14px;
  }

  .name {
    font-family: var(--font-display);
    font-size: 19px;
    line-height: 1.2;
  }

  .price {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }

  p {
    margin: 8px 0 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--muted);
  }

  .cart-action {
    display: flex;
    margin-top: 12px;
  }
</style>
