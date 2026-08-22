<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type {
    FinancialAdminCommandReferenceDto,
    FinancialAdminCommandStatusDto
  } from '$lib/types/financial-reporting';
  import {
    financialCommandStatusPresentation,
    pollFinancialCommandStatus,
    readFinancialCommandStatus,
    waitForFinancialCommandPoll
  } from './financial-command-status';

  interface Props {
    command: FinancialAdminCommandReferenceDto | FinancialAdminCommandStatusDto;
  }

  let { command }: Props = $props();
  let status = $state<FinancialAdminCommandReferenceDto | FinancialAdminCommandStatusDto>(
    untrack(() => command)
  );
  let presentation = $derived(financialCommandStatusPresentation(status));
  let announcement = $state(untrack(() => {
    const initial = financialCommandStatusPresentation(command);
    return `${initial.label}. ${initial.summary ?? initial.guidance}`;
  }));

  onMount(() => {
    const controller = new AbortController();
    const endpoint = resolve('/admin/sales/commands/[commandId]', {
      commandId: command.commandId
    });
    void pollFinancialCommandStatus({
      signal: controller.signal,
      pollPending: command.status === 'pending',
      read: () => readFinancialCommandStatus(endpoint, controller.signal),
      wait: waitForFinancialCommandPoll,
      update: (next) => {
        status = next;
        const current = financialCommandStatusPresentation(next);
        announcement = `${current.label}. ${current.summary ?? current.guidance}`;
      },
      announceUnavailable: () => {
        announcement = 'Command status is temporarily unavailable. Reload current facts.';
      },
      invalidate: invalidateAll
    });
    return () => controller.abort();
  });
</script>

<div class="financial-command-status" role="status" aria-live="polite" aria-atomic="true">
  <p><strong>Status:</strong> {presentation.label}</p>
  <p>
    {#if presentation.summary !== null}{presentation.summary} {/if}{presentation.guidance}
  </p>
  <p class="visually-hidden">{announcement}</p>
</div>
