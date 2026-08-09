<script lang="ts">
  import { untrack } from 'svelte';
  import type { ComicPageDto } from '$lib/types/publication';
  import {
    movePanelBox,
    normalizeDragBox,
    parsePanelBoxes,
    resizePanelBox,
    serializePanelBoxes,
    type NormalizedPanelBox,
    type Point,
    type ResizeHandle
  } from './panel-geometry';

  interface DraftPanel extends NormalizedPanelBox {
    key: string;
    pageId: string;
  }
  interface Gesture {
    mode: 'create' | 'move' | 'resize';
    start: Point;
    bounds: { width: number; height: number };
    key?: string;
    handle?: ResizeHandle;
    initial?: NormalizedPanelBox;
  }
  interface Props { pages: readonly ComicPageDto[]; }

  let { pages }: Props = $props();
  let pageId = $state(untrack(() => pages[0]?.id ?? ''));
  let selectedKey = $state<string | null>(null);
  let gesture = $state<Gesture | null>(null);
  let draft = $state<NormalizedPanelBox | null>(null);
  let frame = $state<HTMLDivElement | null>(null);
  let regions = $state<DraftPanel[]>(untrack(() => pages.flatMap((page) => page.panels.map((panel) => ({
    key: panel.id,
    pageId: page.id,
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height
  })))));

  const page = $derived(pages.find((candidate) => candidate.id === pageId) ?? pages[0]);
  const visible = $derived(regions.filter((region) => region.pageId === pageId));
  const panelsJson = $derived.by(() => JSON.stringify(pages.flatMap((candidate) => {
    const pageRegions = regions.filter((region) => region.pageId === candidate.id);
    const rounded = parsePanelBoxes(serializePanelBoxes(pageRegions));
    return rounded.map((box, index) => ({ pageId: candidate.id, ordinal: index + 1, ...box }));
  })));

  function point(event: PointerEvent, rect: DOMRect): Point {
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function boxOf(region: DraftPanel): NormalizedPanelBox {
    return { x: region.x, y: region.y, width: region.width, height: region.height };
  }
  function beginCreate(event: PointerEvent): void {
    if (!(event.currentTarget instanceof HTMLDivElement)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = point(event, rect);
    gesture = { mode: 'create', start, bounds: { width: rect.width, height: rect.height } };
    draft = null;
  }
  function beginExisting(event: PointerEvent, region: DraftPanel, handle?: ResizeHandle): void {
    event.stopPropagation();
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    frame.setPointerCapture(event.pointerId);
    selectedKey = region.key;
    gesture = {
      mode: handle ? 'resize' : 'move',
      start: point(event, rect),
      bounds: { width: rect.width, height: rect.height },
      key: region.key,
      ...(handle ? { handle } : {}),
      initial: boxOf(region)
    };
  }
  function move(event: PointerEvent): void {
    if (!gesture || !frame) return;
    const rect = frame.getBoundingClientRect();
    const current = point(event, rect);
    if (gesture.mode === 'create') {
      draft = normalizeDragBox(gesture.start, current, gesture.bounds);
      return;
    }
    if (!gesture.key || !gesture.initial) return;
    const delta = { x: current.x - gesture.start.x, y: current.y - gesture.start.y };
    const next = gesture.mode === 'move'
      ? movePanelBox(gesture.initial, delta, gesture.bounds)
      : resizePanelBox(gesture.initial, gesture.handle ?? 'se', delta, gesture.bounds);
    regions = regions.map((region) => region.key === gesture?.key ? { ...region, ...next } : region);
  }
  function finish(): void {
    if (gesture?.mode === 'create' && draft && pageId) {
      const key = crypto.randomUUID();
      regions = [...regions, { key, pageId, ...draft }];
      selectedKey = key;
    }
    gesture = null;
    draft = null;
  }
  function removeSelected(): void {
    if (!selectedKey) return;
    regions = regions.filter((region) => region.key !== selectedKey);
    selectedKey = null;
  }
  function reorder(direction: -1 | 1): void {
    if (!selectedKey) return;
    const pageIndexes = regions.flatMap((region, index) => region.pageId === pageId ? [index] : []);
    const current = pageIndexes.findIndex((index) => regions[index]?.key === selectedKey);
    const other = current + direction;
    if (current < 0 || other < 0 || other >= pageIndexes.length) return;
    const next = [...regions];
    const left = pageIndexes[current];
    const right = pageIndexes[other];
    if (left === undefined || right === undefined) return;
    [next[left], next[right]] = [next[right]!, next[left]!];
    regions = next;
  }
  function nudge(event: KeyboardEvent, region: DraftPanel): void {
    const vector: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }
    };
    const delta = vector[event.key];
    if (!delta || !frame) return;
    event.preventDefault();
    const scale = event.shiftKey ? 10 : 1;
    const rect = frame.getBoundingClientRect();
    const next = movePanelBox(region, { x: delta.x * scale, y: delta.y * scale }, rect);
    regions = regions.map((candidate) => candidate.key === region.key ? { ...candidate, ...next } : candidate);
  }
</script>

<section class="editor">
  <input type="hidden" name="panels" value={panelsJson} />
  <div class="page-tabs" aria-label="Comic pages">
    {#each pages as candidate (candidate.id)}
      <button type="button" class:on={candidate.id === pageId} onclick={() => { pageId = candidate.id; selectedKey = null; }}>Page {candidate.ordinal}</button>
    {/each}
  </div>
  {#if page}
    <div
      class="frame"
      role="application"
      aria-label="Panel region editor"
      bind:this={frame}
      style:aspect-ratio={`${page.width} / ${page.height}`}
      onpointerdown={beginCreate}
      onpointermove={move}
      onpointerup={finish}
      onpointercancel={finish}
    >
      <img src={page.url} alt="Comic page {page.ordinal}" draggable="false" />
      {#each visible as region, index (region.key)}
        <div
          role="button"
          tabindex="0"
          class="region"
          class:selected={selectedKey === region.key}
          style:left={`${region.x * 100}%`}
          style:top={`${region.y * 100}%`}
          style:width={`${region.width * 100}%`}
          style:height={`${region.height * 100}%`}
          aria-label="Panel {index + 1}"
          onpointerdown={(event) => beginExisting(event, region)}
          onkeydown={(event) => nudge(event, region)}
        >
          <span>{index + 1}</span>
          {#each ['nw', 'ne', 'se', 'sw'] as handle (handle)}
            <button type="button" class={handle} aria-label="Resize panel {index + 1} from {handle}" onpointerdown={(event) => beginExisting(event, region, handle as ResizeHandle)}></button>
          {/each}
        </div>
      {/each}
      {#if draft}<span class="draft" style:left={`${draft.x * 100}%`} style:top={`${draft.y * 100}%`} style:width={`${draft.width * 100}%`} style:height={`${draft.height * 100}%`}></span>{/if}
    </div>
  {/if}
  <div class="tools">
    <button type="button" disabled={!selectedKey} onclick={() => reorder(-1)}>Earlier</button>
    <button type="button" disabled={!selectedKey} onclick={() => reorder(1)}>Later</button>
    <button type="button" disabled={!selectedKey} onclick={removeSelected}>Delete panel</button>
    <span>Drag empty space to add. Drag a box or corner to adjust.</span>
  </div>
</section>

<style>
  .editor { display: grid; gap: 12px; }
  .page-tabs { display: flex; gap: 6px; overflow-x: auto; }
  .page-tabs button, .tools button { padding: 7px 10px; border: 1px solid var(--line); background: none; color: var(--muted); cursor: pointer; }
  .page-tabs button.on { border-color: var(--accent); color: var(--accent); }
  .frame { position: relative; width: min(100%, 620px); max-height: 72vh; overflow: hidden; touch-action: none; background: #111; }
  .frame > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
  .region, .draft { position: absolute; border: 2px solid #ffd166; background: rgba(255, 209, 102, 0.12); }
  .region { padding: 0; cursor: move; }
  .region.selected { border-color: #5ef0c5; background: rgba(94, 240, 197, 0.14); }
  .region span { position: absolute; left: 3px; top: 2px; color: #fff; font: 11px var(--font-mono); text-shadow: 0 1px 2px #000; }
  .region > button { position: absolute; width: 10px; height: 10px; padding: 0; border: 0; background: #5ef0c5; }
  .nw { left: -5px; top: -5px; cursor: nw-resize; } .ne { right: -5px; top: -5px; cursor: ne-resize; }
  .se { right: -5px; bottom: -5px; cursor: se-resize; } .sw { left: -5px; bottom: -5px; cursor: sw-resize; }
  .tools { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 12px; color: var(--muted); }
</style>
