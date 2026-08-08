<script>
  import CoverArt from '$lib/components/CoverArt.svelte';
  import BookVolume from '$lib/components/BookVolume.svelte';
  import { titles } from '$lib/stores/titles.svelte.js';
  import { money } from '$lib/data/catalog';

  const featured = $derived(titles.all[0]);
</script>

<svelte:head><title>Pale Orbit Press</title></svelte:head>

<section class="hero wrap">
  <div class="copy">
    <div class="mono accent">Science fiction &amp; true stories</div>
    <h1 class="display">Books that still<br />turn like books.</h1>
    <p>
      Every title on Pale Orbit opens in a real reader — paper that bends under your thumb, spreads
      that breathe, comics that read like a stapled issue. Buy once, read anywhere, or have the file
      mailed to you.
    </p>
    <div class="actions">
      <a class="btn" href="/read/{featured.id}?sample=1">
        {featured.kind === 'comic' ? 'Preview first pages' : 'Read chapter one free'}
      </a>
      <a class="btn ghost" href="/catalog">Browse the catalog</a>
    </div>
  </div>

  <a class="art" href="/book/{featured.id}">
    <BookVolume title={featured} width={296} height={430} interactive tilt={-16} />
  </a>
</section>

<section class="wrap">
  <div class="section-head">
    <h2 class="display">Recent releases</h2>
    <a class="mono" href="/catalog">All titles &rarr;</a>
  </div>

  <div class="grid">
    {#each titles.all as t}
      <a class="card" href="/book/{t.id}">
        <CoverArt index={t.cover} src={t.coverUrl} alt={t.title} height="300px" />
        <div class="line">
          <span class="name">{t.title}</span>
          <span class="price">{money(t.price)}</span>
        </div>
        <div class="mono">{t.kind === 'comic' ? 'Comic · Issue #1' : 'Novel'}</div>
      </a>
    {/each}
  </div>
</section>

<section class="wrap features">
  <div>
    <div class="mono accent">01 / Reader</div>
    <p>Drag from the corner and the sheet bends — shading, spine shadow and all. Swipe on a phone, arrow keys on a desk.</p>
  </div>
  <div>
    <div class="mono accent">02 / Comics</div>
    <p>Read a full page like a print issue, or flip to guided view and let it walk you panel by panel.</p>
  </div>
  <div>
    <div class="mono accent">03 / Delivery</div>
    <p>Your shelf keeps every purchase and your place in it. Want the file? Have it emailed in one tap.</p>
  </div>
</section>

<style>
  .hero {
    display: grid;
    grid-template-columns: 1.05fr 0.95fr;
    gap: 40px;
    align-items: center;
    padding-top: 84px;
    padding-bottom: 72px;
  }

  .copy {
    animation: fade-up 0.7s ease both;
  }

  h1 {
    font-size: clamp(44px, 6vw, 82px);
    line-height: 0.98;
    margin: 24px 0;
  }

  .copy p {
    max-width: 46ch;
    font-size: 17px;
    line-height: 1.65;
    color: var(--muted);
    margin: 0 0 36px;
    text-wrap: pretty;
  }

  .actions {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .accent {
    color: var(--accent);
  }

  .art {
    display: flex;
    justify-content: center;
    align-items: center;
    perspective: 2200px;
    perspective-origin: 50% 45%;
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    border-top: 1px solid var(--line);
    padding-top: 22px;
    margin-bottom: 26px;
  }

  .section-head h2 {
    font-size: 26px;
    font-weight: 400;
    margin: 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 30px 26px;
  }

  .card {
    color: var(--ink);
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
    font-size: 18px;
    line-height: 1.2;
  }

  .price {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }

  .features {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    margin: 64px auto 96px;
  }

  .features > div {
    background: var(--bg);
    padding: 30px;
  }

  .features p {
    margin: 12px 0 0;
    font-size: 15px;
    line-height: 1.6;
    color: var(--muted);
  }

  @media (max-width: 900px) {
    .hero,
    .features {
      grid-template-columns: 1fr;
    }
  }
</style>
