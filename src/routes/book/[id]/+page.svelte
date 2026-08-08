<script>
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import BookVolume from '$lib/components/BookVolume.svelte';
  import { titles } from '$lib/stores/titles.svelte';
  import { library } from '$lib/stores/library.svelte';
  import { money } from '$lib/data/catalog';

  const title = $derived(titles.get($page.params.id));
  const owned = $derived(title ? library.owns(title.id) : false);
  const excerpt = $derived(title?.chapters?.[0]?.paras.slice(0, 2) || []);

  function buy() {
    if (owned) return goto(`/read/${title.id}`);
    goto(`/checkout/${title.id}`);
  }
</script>

<svelte:head><title>{title?.title ?? 'Title'} · Pale Orbit Press</title></svelte:head>

{#if title}
  <section class="detail">
    <div class="left">
      <div class="art">
        <BookVolume {title} width={286} height={420} interactive />
      </div>

      <div class="buttons">
        <button class="btn" onclick={buy}>
          {owned ? 'In your shelf — read now' : `Buy · ${money(title.price)}`}
        </button>
        <a class="btn ghost" href="/read/{title.id}?sample=1">
          {title.kind === 'comic' ? 'Preview first pages' : 'Read chapter one free'}
        </a>
      </div>

      <dl>
        <div><dt>FORMAT</dt><dd>EPUB · PDF · in-browser</dd></div>
        <div><dt>RELEASED</dt><dd>{title.released}</dd></div>
        <div>
          <dt>LENGTH</dt>
          <dd>{title.kind === 'comic' ? `${title.pages} pages` : `${title.chapters?.length ?? 0} chapters`}</dd>
        </div>
      </dl>
    </div>

    <div class="right">
      <div class="mono accent">{title.kind === 'comic' ? 'Comic · Issue #1' : 'Novel'}</div>
      <h1 class="display">{title.title}</h1>
      <div class="author">{title.author}</div>
      <p class="summary">{title.summary}</p>

      {#each excerpt as para}
        <p class="excerpt">{para}</p>
      {/each}

      {#if title.chapters}
        <div class="toc">
          <div class="mono">Contents</div>
          {#each title.chapters as ch, i}
            <div class="row">
              <span>{ch.title}</span>
              <span class="mono plain">{i === 0 ? 'free' : `chapter ${i + 1}`}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>
{:else}
  <p class="missing">No such title. <a href="/catalog">Back to the catalog</a></p>
{/if}

<style>
  .detail {
    display: grid;
    grid-template-columns: 0.9fr 1.1fr;
    gap: 64px;
    max-width: 1240px;
    margin: 0 auto;
    padding: 60px 48px 110px;
  }

  .buttons {
    display: grid;
    gap: 10px;
    margin-top: 26px;
  }

  .art {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 460px;
    perspective: 2200px;
    perspective-origin: 50% 45%;
  }

  dl {
    display: grid;
    gap: 8px;
    margin: 22px 0 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }

  dl > div {
    display: flex;
    justify-content: space-between;
  }

  dt,
  dd {
    margin: 0;
  }

  .accent {
    color: var(--accent);
  }

  h1 {
    font-size: 54px;
    line-height: 1.02;
    margin: 14px 0 10px;
  }

  .author {
    font-size: 15px;
    color: var(--muted);
    margin-bottom: 30px;
  }

  .summary {
    font-family: var(--font-display);
    font-size: 21px;
    line-height: 1.55;
    margin: 0 0 22px;
  }

  .excerpt {
    font-size: 15.5px;
    line-height: 1.75;
    color: var(--muted);
    margin: 0 0 16px;
  }

  .toc {
    margin-top: 34px;
    border-top: 1px solid var(--line);
    padding-top: 22px;
  }

  .row {
    display: flex;
    justify-content: space-between;
    padding: 11px 0;
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }

  .plain {
    letter-spacing: 0.1em;
    text-transform: none;
  }

  .missing {
    padding: 80px 48px;
  }

  @media (max-width: 900px) {
    .detail {
      grid-template-columns: 1fr;
      gap: 34px;
      padding: 30px 20px 80px;
    }
    h1 {
      font-size: 38px;
    }
  }
</style>
