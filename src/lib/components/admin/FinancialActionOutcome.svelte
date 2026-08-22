<script lang="ts">
  import type { FinancialAdminCommandReferenceDto } from '$lib/types/financial-reporting';
  import FinancialCommandStatus from './FinancialCommandStatus.svelte';

  interface Props {
    command: FinancialAdminCommandReferenceDto;
    reloadHref: string;
  }

  let { command, reloadHref }: Props = $props();
</script>

<section class="financial-action-outcome" aria-labelledby="financial-command-heading">
  <h2 id="financial-command-heading">Submitted financial command</h2>
  <p>
    Reference:
    <code>{command.commandId}</code>
  </p>
  <FinancialCommandStatus {command} />
  <!-- The target is built by the parent from the fixed refund route and validated cursor only. -->
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
  <a href={reloadHref}>Reload current refund facts</a>
</section>
