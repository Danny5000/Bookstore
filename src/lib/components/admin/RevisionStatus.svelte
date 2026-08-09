<script lang="ts">
  import { untrack } from 'svelte';
  interface Status {
    state: string;
    processingStartedAt: Date | string | null;
    processedAt: Date | string | null;
    failure: { code: string; message: string } | null;
    warnings: readonly { code: string; message: string }[];
  }

  interface Props {
    url: string;
    initial: Status;
    onstatus?: (status: Status) => void;
  }

  let { url, initial, onstatus }: Props = $props();
  let snapshot = $state(untrack(() => initial));

  $effect(() => {
    if (!['uploaded', 'processing'].includes(untrack(() => snapshot.state))) return;
    const controller = new AbortController();
    let stopped = false;
    let delay = 500;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
        if (stopped) return;
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Status polling failed');
        snapshot = await response.json() as Status;
        onstatus?.(snapshot);
        if (!['uploaded', 'processing'].includes(snapshot.state)) return;
        delay = Math.min(5_000, delay * 1.7);
      }
    };
    void poll().catch((cause: unknown) => {
      if (!controller.signal.aborted) console.error('[catalog] revision status polling failed', cause);
    });
    return () => {
      stopped = true;
      controller.abort();
    };
  });
</script>

<section class="status" aria-live="polite">
  <div><span class="pulse" class:done={!['uploaded', 'processing'].includes(snapshot.state)}></span><strong>{snapshot.state.replaceAll('_', ' ')}</strong></div>
  {#if snapshot.failure}<p class="failure">{snapshot.failure.message} <span class="mono">{snapshot.failure.code}</span></p>{/if}
  {#each snapshot.warnings as warning (`${warning.code}:${warning.message}`)}
    <p class="warning">{warning.message}</p>
  {/each}
</section>

<style>
  .status { display: grid; gap: 8px; padding: 16px; border: 1px solid var(--line); background: var(--surface); }
  .status > div { display: flex; align-items: center; gap: 9px; text-transform: capitalize; }
  .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite; }
  .pulse.done { animation: none; background: var(--muted); }
  p { margin: 0; font-size: 13px; }
  .failure { color: var(--accent); }
  .warning { color: var(--muted); }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>
