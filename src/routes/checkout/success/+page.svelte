<script>
  import { page } from '$app/stores';
  import { titles } from '$lib/stores/titles.svelte.js';
  import { library } from '$lib/stores/library.svelte.js';

  const id = $derived($page.url.searchParams.get('title'));
  const title = $derived(id ? titles.get(id) : null);

  // If the reader came back from Stripe, the webhook has already granted the
  // purchase server-side; mirror it locally so the shelf updates immediately.
  $effect(() => {
    if (id) library.grant(id);
  });
</script>

<svelte:head><title>Thank you · Pale Orbit Press</title></svelte:head>

<section>
  <div class="mono accent">Payment received</div>
  <h1 class="display">It's on your shelf.</h1>
  <p>Receipt and files are on their way. Your place is saved as you read.</p>
  <div class="acts">
    {#if title}
      <a class="btn" href="/read/{title.id}">Start reading {title.title}</a>
    {/if}
    <a class="btn ghost" href="/library">Go to my shelf</a>
  </div>
</section>

<style>
  section {
    max-width: 620px;
    margin: 120px auto;
    padding: 0 24px;
    text-align: center;
  }

  h1 {
    font-size: 42px;
    margin: 14px 0;
  }

  p {
    color: var(--muted);
    line-height: 1.6;
  }

  .acts {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 28px;
  }

  .accent {
    color: var(--accent);
  }
</style>
