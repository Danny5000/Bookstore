<script lang="ts">
  import type { ActionData, PageData } from './$types';

  interface Props {
    data: PageData;
    form: ActionData;
  }

  let { data, form }: Props = $props();
  const users = $derived(form?.users ?? data.users);
  const adminCount = $derived(users.filter((entry) => entry.roles.includes('admin')).length);
</script>

<svelte:head><title>Users · Pale Orbit Admin</title></svelte:head>

<header class="page-heading">
  <div>
    <p class="mono">Access control</p>
    <h2 class="display">Users</h2>
  </div>
  <p>{users.length} {users.length === 1 ? 'account' : 'accounts'}</p>
</header>

{#if form?.message}
  <p class:error={(form as { status?: number }).status !== undefined} class="notice" role="status">
    {form.message}
  </p>
{/if}

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Email</th>
        <th>Verified</th>
        <th>Roles</th>
        <th><span class="sr-only">Role action</span></th>
      </tr>
    </thead>
    <tbody>
      {#each users as entry (entry.id)}
        {@const isAdmin = entry.roles.includes('admin')}
        {@const protectsFinalSelf = isAdmin && adminCount === 1 && entry.id === data.user?.id}
        <tr>
          <td>{entry.name || 'Unnamed reader'}</td>
          <td>{entry.email}</td>
          <td>{entry.emailVerified ? 'Yes' : 'No'}</td>
          <td><span class="role">{entry.roles.join(' · ')}</span></td>
          <td class="action-cell">
            <form method="POST" action="?/setAdmin">
              <input type="hidden" name="userId" value={entry.id} />
              <input type="hidden" name="enabled" value={isAdmin ? 'false' : 'true'} />
              <button class="role-button" disabled={protectsFinalSelf}>
                {isAdmin ? 'Revoke admin' : 'Grant admin'}
              </button>
            </form>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .page-heading {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 24px;
  }

  h2 {
    margin: 4px 0 0;
    font-size: 44px;
  }

  .page-heading > p {
    color: var(--muted);
  }

  .notice {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--accent);
  }

  .notice.error {
    color: oklch(0.72 0.17 25);
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: 6px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th,
  td {
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    white-space: nowrap;
  }

  th {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  .role {
    color: var(--accent);
  }

  .action-cell {
    text-align: right;
  }

  .role-button {
    padding: 7px 10px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--raised);
    cursor: pointer;
    font-size: 12px;
  }

  .role-button:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .role-button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
