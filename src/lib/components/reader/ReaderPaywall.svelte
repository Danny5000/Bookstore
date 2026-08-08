<script lang="ts">
  interface Props {
    isComic: boolean;
    title: string;
    price: string;
    onbuy: () => void;
    onclose: () => void;
  }

  let { isComic, title, price, onbuy, onclose }: Props = $props();
</script>

<div class="paywall">
  <div class="card">
    <div class="mono accent">End of the free {isComic ? 'preview' : 'chapter'}</div>
    <h3 class="display">{title}</h3>
    <p>Keep going for {price}. Yours forever, in the browser or as a file.</p>
    <button class="btn" type="button" onclick={onbuy}>Buy the whole {isComic ? 'issue' : 'book'}</button>
    <button class="link" type="button" onclick={onclose}>Not now</button>
  </div>
</div>

<style>
  .paywall {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in oklab, var(--bg) 78%, transparent);
    backdrop-filter: blur(6px);
  }

  .card {
    width: 420px;
    max-width: 90vw;
    padding: 34px;
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
  }

  .card h3 {
    font-size: 30px;
    margin: 12px 0;
  }

  .card p {
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--muted);
    margin: 0 0 24px;
  }

  .card .btn {
    width: 100%;
  }

  .accent {
    color: var(--accent);
  }

  .link {
    margin-top: 12px;
    border: 0;
    background: none;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
  }
</style>
