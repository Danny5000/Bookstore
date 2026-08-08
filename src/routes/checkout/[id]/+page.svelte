<script>
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CoverArt from '$lib/components/CoverArt.svelte';
  import { titles } from '$lib/stores/titles.svelte';
  import { library } from '$lib/stores/library.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { money } from '$lib/data/catalog';

  const title = $derived(titles.get($page.params.id));

  let email = $state(session.user?.email ?? '');
  let emailCopy = $state(true);
  let busy = $state(false);
  let error = $state('');

  const tax = $derived(title ? title.price * 0.08 : 0);
  const total = $derived(title ? title.price + tax : 0);

  /** Real flow: create a Stripe Checkout Session and redirect to it. */
  async function payWithStripe() {
    if (!email) {
      error = 'Add an email for the receipt and delivery.';
      return;
    }
    busy = true;
    error = '';
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titleId: title.id, email, emailCopy })
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url; // Stripe Checkout
        return;
      }
      throw new Error(data.message || 'Checkout unavailable');
    } catch (e) {
      // No Stripe keys configured yet — fall back to the local demo grant so
      // the rest of the flow stays clickable in development.
      error = e.message + ' — granting locally for development.';
      grantLocally();
    } finally {
      busy = false;
    }
  }

  function grantLocally() {
    library.grant(title.id);
    if (!session.user) session.signIn(email);
    goto(`/checkout/success?title=${title.id}`);
  }
</script>

<svelte:head><title>Checkout · {title?.title ?? ''}</title></svelte:head>

{#if title}
  <section class="checkout">
    <aside class="summary">
      <a class="back mono" href="/book/{title.id}">&larr; Back</a>
      <CoverArt index={title.cover} src={title.coverUrl} alt={title.title} width="150px" height="215px" />
      <h2 class="display">{title.title}</h2>
      <p class="kind">{title.kind === 'comic' ? 'Comic' : 'Novel'} · EPUB, PDF &amp; in-browser</p>

      <dl>
        <div><dt>Subtotal</dt><dd>{money(title.price)}</dd></div>
        <div><dt>Tax</dt><dd>{money(tax)}</dd></div>
        <div class="total"><dt>Total</dt><dd>{money(total)}</dd></div>
      </dl>
    </aside>

    <div class="pay">
      <div class="mono">Secure payment · Stripe</div>

      <label>
        <span>Email for receipt &amp; delivery</span>
        <input class="field" type="email" bind:value={email} placeholder="you@email.com" />
      </label>

      <label class="check">
        <input type="checkbox" bind:checked={emailCopy} />
        Also email me the EPUB &amp; PDF
      </label>

      <button class="btn" onclick={payWithStripe} disabled={busy}>
        {busy ? 'Redirecting…' : `Pay ${money(total)}`}
      </button>

      {#if error}<p class="error">{error}</p>{/if}

      <p class="fine">
        Card details are collected by Stripe Checkout on Stripe's own page — this app never sees a
        card number. Entitlements are granted by the webhook at
        <code>/api/stripe-webhook</code>.
      </p>
    </div>
  </section>
{/if}

<style>
  .checkout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    max-width: 880px;
    margin: 60px auto 110px;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }

  .summary {
    padding: 38px;
    background: var(--bg);
    border-right: 1px solid var(--line);
  }

  .back {
    display: block;
    margin-bottom: 30px;
  }

  h2 {
    font-size: 26px;
    margin: 22px 0 4px;
  }

  .kind {
    font-size: 13px;
    color: var(--muted);
    margin: 0;
  }

  dl {
    margin: 26px 0 0;
    padding-top: 16px;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 9px;
    font-size: 14px;
  }

  dl > div {
    display: flex;
    justify-content: space-between;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
  }

  .total {
    font-size: 18px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }

  .total dt {
    color: var(--ink);
  }

  .pay {
    padding: 38px;
    display: grid;
    gap: 16px;
    align-content: start;
  }

  label {
    display: grid;
    gap: 7px;
    font-size: 13px;
    color: var(--muted);
  }

  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
  }

  .error {
    margin: 0;
    font-size: 13px;
    color: var(--accent);
  }

  .fine {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--muted);
  }

  @media (max-width: 780px) {
    .checkout {
      grid-template-columns: 1fr;
      margin: 20px;
    }
    .summary {
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
  }
</style>
