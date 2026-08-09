<script lang="ts">
  import { resolve } from '$app/paths';
</script>

<svelte:head><title>Admin · Pale Orbit Press</title></svelte:head>

<section class="overview">
  <p class="mono">Plan 3 · Authentication</p>
  <h2 class="display">Admin foundation</h2>
  <p>
    Authentication, administrator access, and audited role management are active. Catalog,
    audit-trail, and sales reporting screens arrive in their dedicated backend phases.
  </p>
  <a class="btn" href={resolve('/admin/users')}>Manage users</a>
</section>

<style>
  .overview {
    max-width: 700px;
  }

  h2 {
    margin: 5px 0 12px;
    font-size: clamp(38px, 6vw, 58px);
  }

  p:not(.mono) {
    max-width: 620px;
    margin: 0 0 28px;
    color: var(--muted);
    line-height: 1.7;
  }
</style>
