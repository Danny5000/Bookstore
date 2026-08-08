<script lang="ts">
  import CoverArt from '$lib/components/CoverArt.svelte';
  import { parseManuscript } from '$lib/data/manuscript';
  import { titles } from '$lib/stores/titles.svelte';
  import { SWATCHES } from '$lib/data/catalog';
  import type { PanelMode, ReadingDirection, Title, TitleKind } from '$lib/types/catalog';

  type NovelSource = 'paste' | 'file';
  type NovelRenderMode = 'reflow' | 'fixed';

  interface StudioForm {
    kind: TitleKind;
    title: string;
    price: string;
    summary: string;
    cover: number;
    source: NovelSource;
    body: string;
    file: string;
    render: NovelRenderMode;
    samplePages: string;
    pages: string[];
    direction: ReadingDirection;
    panelMode: PanelMode;
    coverUrl: string;
    coverName: string;
  }

  interface Choice<Value extends string> {
    id: Value;
    label: string;
    note: string;
  }

  interface SimpleChoice<Value extends string> {
    id: Value;
    label: string;
  }

  let form = $state<StudioForm>({
    kind: 'novel',
    title: '',
    price: '',
    summary: '',
    cover: 0,
    // novel
    source: 'paste', // 'paste' | 'file'
    body: '',
    file: '',
    render: 'reflow', // 'reflow' | 'fixed'
    samplePages: '10',
    // comic
    pages: [],
    direction: 'ltr',
    panelMode: 'auto', // 'auto' | 'manual' | 'off'
    // cover
    coverUrl: '',
    coverName: ''
  });

  let note = $state('');

  const KINDS: Choice<TitleKind>[] = [
    {
      id: 'novel',
      label: 'Novel',
      note: 'Prose. Reflows to the reader’s type size, or keeps your PDF pages exactly as designed.'
    },
    {
      id: 'comic',
      label: 'Comic',
      note: 'Page art. Turns like a print issue, with an optional panel-by-panel guided view.'
    }
  ];

  const RENDER_MODES: Choice<NovelRenderMode>[] = [
    {
      id: 'reflow',
      label: 'Reflowable',
      note: 'Extract the text. Readers can change type size, typeface and paper — best on phones.'
    },
    {
      id: 'fixed',
      label: 'Fixed pages',
      note: 'Keep your PDF pages exactly as laid out. Type controls turn off; for illustrated or poetry-set books.'
    }
  ];

  const MANUSCRIPT_SOURCES: SimpleChoice<NovelSource>[] = [
    { id: 'paste', label: 'Paste manuscript' },
    { id: 'file', label: 'Upload a file' }
  ];

  const READING_DIRECTIONS: SimpleChoice<ReadingDirection>[] = [
    { id: 'ltr', label: 'Left to right' },
    { id: 'rtl', label: 'Right to left' }
  ];

  const PANEL_MODES: SimpleChoice<PanelMode>[] = [
    { id: 'auto', label: 'Auto-detect' },
    { id: 'manual', label: 'Draw later' },
    { id: 'off', label: 'Page only' }
  ];

  const PANEL_HINTS: Record<PanelMode, string> = {
    auto: 'Gutters are found automatically and become the guided-view sequence. You can correct any page afterwards.',
    manual: 'Pages publish now; draw panel regions per page whenever you like. Guided view stays off until then.',
    off: 'No guided view — readers turn whole pages, like a print issue.'
  };

  function inputFrom(event: Event): HTMLInputElement | null {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null;
  }

  function onManuscriptFile(event: Event): void {
    const input = inputFrom(event);
    const file = input?.files?.[0];
    if (!file) return;
    form.file = file.name;
    // Only PDFs can be kept as fixed pages; EPUB/DOCX are always reflowable.
    if (!/\.pdf$/i.test(file.name)) form.render = 'reflow';
    // Production: POST to /api/ingest — pdf.js or pdftotext for extraction,
    // or store the PDF and rasterize page images for fixed-page reading.
  }

  function onCoverFile(event: Event): void {
    const input = inputFrom(event);
    const file = input?.files?.[0];
    if (!file) return;
    // Preview locally; production uploads to object storage and stores the URL.
    form.coverUrl = URL.createObjectURL(file);
    form.coverName = file.name;
  }

  function onComicFiles(event: Event): void {
    const input = inputFrom(event);
    const names = Array.from(input?.files ?? []).map((file) => file.name);
    if (names.length > 0) form.pages = [...form.pages, ...names];
  }

  function publish(): void {
    if (!form.title) {
      note = 'A title is required.';
      return;
    }
    if (form.kind === 'comic' && !form.pages.length) {
      note = 'Upload at least one page of art.';
      return;
    }
    if (form.kind === 'novel' && form.source === 'file' && !form.file) {
      note = 'Choose a manuscript file, or paste the text instead.';
      return;
    }

    const fixed = form.kind === 'novel' && form.source === 'file' && form.render === 'fixed';
    const common = {
      id: 'u' + Date.now(),
      title: form.title,
      author: 'R. Vale Okonjo',
      price: Number.parseFloat(form.price) || 0,
      released: new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      cover: form.cover,
      coverUrl: form.coverUrl || null,
      summary: form.summary || '—'
    };
    const nextTitle: Title =
      form.kind === 'comic'
        ? {
            ...common,
            kind: 'comic',
            pages: form.pages.length,
            pageNames: [...form.pages],
            direction: form.direction,
            panelMode: form.panelMode
          }
        : {
            ...common,
            kind: 'novel',
            fixed,
            ...(form.source === 'file' ? { sourceFile: form.file } : {}),
            ...(fixed
              ? {
                  pages: 24,
                  samplePages: Math.max(1, Number.parseInt(form.samplePages, 10) || 10)
                }
              : { chapters: parseManuscript(form.body) })
          };

    titles.publish(nextTitle);

    note =
      form.kind === 'comic'
        ? `Published — ${form.pages.length} pages${form.panelMode === 'auto' ? ', panels detected.' : '.'}`
        : fixed
          ? `Published — fixed-page edition from ${form.file}.`
          : "Published — it's live in the catalog.";

    form = { ...form, title: '', price: '', summary: '', body: '', file: '', pages: [], cover: 0, coverUrl: '', coverName: '' };
  }
</script>

<svelte:head><title>Studio · Pale Orbit Press</title></svelte:head>

<section class="wrap">
  <h1 class="display">Studio</h1>
  <p class="lede">
    Novels and comics take in different material. Pick what you're publishing and the intake changes
    to suit it.
  </p>

  <div class="cols">
    <div class="form">
      <div class="kinds">
        {#each KINDS as k (k.id)}
          <button class="kind" class:on={form.kind === k.id} onclick={() => (form.kind = k.id)}>
            <span class="kind-title">{k.label}</span>
            <span class="kind-note">{k.note}</span>
          </button>
        {/each}
      </div>

      <div class="pair">
        <label>
          <span class="mono">Title</span>
          <input class="field" bind:value={form.title} placeholder="The Salt Harvest" />
        </label>
        <label>
          <span class="mono">Price</span>
          <input class="field" bind:value={form.price} placeholder="9.99" inputmode="decimal" />
        </label>
      </div>

      <label>
        <span class="mono">Summary</span>
        <textarea class="field" rows="3" bind:value={form.summary} placeholder="One paragraph that sells it."></textarea>
      </label>

      {#if form.kind === 'novel'}
        <div class="block">
          <div class="tabs">
            {#each MANUSCRIPT_SOURCES as source (source.id)}
              <button class="tab" class:on={form.source === source.id} onclick={() => (form.source = source.id)}>
                {source.label}
              </button>
            {/each}
          </div>

          {#if form.source === 'paste'}
            <label>
              <span class="mono">Manuscript — use “## Chapter title” to start a chapter</span>
              <textarea
                class="field manuscript"
                rows="12"
                bind:value={form.body}
                placeholder="## One&#10;&#10;The tide came in grey..."
              ></textarea>
            </label>
          {:else}
            <label class="drop">
              <input type="file" accept=".pdf,.epub,.docx" onchange={onManuscriptFile} hidden />
              <span class="drop-title">{form.file || 'Drop your manuscript here'}</span>
              <span class="mono">PDF · EPUB · DOCX — drop or click to choose</span>
            </label>

            <div class="mono">How should it read?</div>
            <div class="choices">
              {#each RENDER_MODES as r (r.id)}
                <button
                  class="choice"
                  class:on={form.render === r.id}
                  disabled={r.id === 'fixed' && !!form.file && !/\.pdf$/i.test(form.file)}
                  onclick={() => (form.render = r.id)}
                >
                  <span class="choice-title">{r.label}</span>
                  <span class="choice-note">{r.note}</span>
                </button>
              {/each}
            </div>

            {#if form.render === 'fixed'}
              <label class="sample">
                <span class="mono">Free preview — pages before the paywall</span>
                <input class="field" bind:value={form.samplePages} placeholder="10" inputmode="numeric" />
              </label>
            {/if}
          {/if}
        </div>
      {:else}
        <div class="block">
          <label class="drop">
            <input type="file" accept="image/*,.pdf" multiple onchange={onComicFiles} hidden />
            <span class="drop-title">
              {form.pages.length ? `${form.pages.length} pages ready` : 'Drop your page art here'}
            </span>
            <span class="mono">PNG · JPG · TIFF · or a print-ready PDF</span>
          </label>

          {#if form.pages.length}
            <div class="thumbs">
              {#each form.pages as name, i (i)}
                <div class="thumb">
                  <span class="hatch"></span>
                  <span class="label">{i + 1} · {name}</span>
                  <button
                    class="x"
                    aria-label="Remove page {i + 1}"
                    onclick={() => (form.pages = form.pages.filter((_, n) => n !== i))}>×</button
                  >
                </div>
              {/each}
            </div>
          {/if}

          <div class="pair">
            <div>
              <div class="mono">Reading direction</div>
              <div class="segs">
                {#each READING_DIRECTIONS as direction (direction.id)}
                  <button
                    class="seg"
                    class:on={form.direction === direction.id}
                    onclick={() => (form.direction = direction.id)}>{direction.label}</button
                  >
                {/each}
              </div>
            </div>
            <div>
              <div class="mono">Guided view panels</div>
              <div class="segs">
                {#each PANEL_MODES as mode (mode.id)}
                  <button class="seg" class:on={form.panelMode === mode.id} onclick={() => (form.panelMode = mode.id)}>
                    {mode.label}
                  </button>
                {/each}
              </div>
            </div>
          </div>

          <p class="hint">{PANEL_HINTS[form.panelMode]}</p>
        </div>
      {/if}

      <div class="submit">
        <button class="btn" onclick={publish}>Publish title</button>
        <span class="hint">{note}</span>
      </div>
    </div>

    <aside>
      <div class="mono">Cover</div>
      <CoverArt index={form.cover} src={form.coverUrl || null} alt="" height="230px" />

      <label class="upload" class:on={!!form.coverUrl}>
        <input type="file" accept="image/*" onchange={onCoverFile} hidden />
        {form.coverUrl ? 'Replace cover art' : 'Upload cover art'}
      </label>

      {#if form.coverUrl}
        <div class="filename">
          <span>{form.coverName}</span>
          <button class="remove" onclick={() => { form.coverUrl = ''; form.coverName = ''; }}>remove</button>
        </div>
      {:else}
        <div>
          <div class="mono">Or use a placeholder</div>
          <div class="swatches">
            {#each SWATCHES as sw, i (i)}
              <button
                class="sw"
                class:on={form.cover === i}
                aria-label="Cover palette {i + 1}"
                style:background="linear-gradient(140deg, {sw[1]} 45%, {sw[0]} 55%)"
                onclick={() => (form.cover = i)}
              ></button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="list">
        <div class="list-head mono">
          <span>Published titles</span>
          {#if titles.hidden.length}
            <button class="remove" onclick={() => titles.restoreAll()}>restore {titles.hidden.length}</button>
          {/if}
        </div>
        {#each titles.all as t (t.id)}
          <div class="item">
            <span>{t.title}</span>
            <button class="remove" onclick={() => titles.remove(t.id)}>remove</button>
          </div>
        {:else}
          <p class="hint">No titles yet — publish one and it appears here.</p>
        {/each}
      </div>
    </aside>
  </div>
</section>

<style>
  section {
    padding-top: 52px;
    padding-bottom: 110px;
    max-width: 1240px;
  }

  h1 {
    font-size: 44px;
    margin: 0 0 6px;
  }

  .lede {
    color: var(--muted);
    font-size: 15px;
    margin: 0 0 38px;
    max-width: 62ch;
  }

  .cols {
    display: grid;
    grid-template-columns: 1fr 340px;
    gap: 40px;
    align-items: start;
  }

  .form {
    display: grid;
    gap: 18px;
  }

  .kinds {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }

  .kind {
    display: grid;
    gap: 6px;
    padding: 18px 20px;
    text-align: left;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }

  .kind.on {
    border-color: var(--accent);
    background: var(--surface);
  }

  .kind-title {
    font-family: var(--font-display);
    font-size: 22px;
    color: var(--ink);
  }

  .kind.on .kind-title {
    color: var(--accent);
  }

  .kind-note {
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted);
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }

  label {
    display: grid;
    gap: 7px;
  }

  textarea {
    resize: vertical;
    line-height: 1.6;
  }

  .manuscript {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.7;
  }

  .block {
    display: grid;
    gap: 14px;
    border-top: 1px solid var(--line);
    padding-top: 20px;
  }

  .tabs {
    display: flex;
    gap: 8px;
  }

  .tab {
    padding: 9px 18px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
  }

  .tab.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .drop {
    display: grid;
    gap: 6px;
    justify-items: center;
    padding: 34px 20px;
    text-align: center;
    background: var(--surface);
    border: 1px dashed var(--line);
    border-radius: 5px;
    cursor: pointer;
  }

  .drop:hover {
    border-color: var(--accent);
  }

  .drop-title {
    font-family: var(--font-display);
    font-size: 22px;
  }

  .choices {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .choice {
    display: grid;
    gap: 6px;
    padding: 16px 18px;
    text-align: left;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }

  .choice.on {
    border-color: var(--accent);
    background: var(--surface);
  }

  .choice:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .choice-title {
    font-size: 15px;
    font-weight: 500;
    color: var(--ink);
  }

  .choice.on .choice-title {
    color: var(--accent);
  }

  .choice-note {
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted);
  }

  .sample {
    max-width: 320px;
  }

  .thumbs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 10px;
  }

  .thumb {
    position: relative;
    display: flex;
    align-items: flex-end;
    aspect-ratio: 0.72;
    padding: 8px;
    border: 1px solid var(--line);
    background: var(--surface);
    overflow: hidden;
  }

  .hatch {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      135deg,
      color-mix(in oklab, var(--ink) 7%, transparent) 0 8px,
      transparent 8px 16px
    );
  }

  .thumb .label {
    position: relative;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
    word-break: break-all;
  }

  .x {
    position: absolute;
    top: 4px;
    right: 6px;
    border: 0;
    background: none;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
  }

  .segs {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }

  .seg {
    flex: 1;
    padding: 10px 8px;
    border: 1px solid var(--line);
    border-radius: 3px;
    background: none;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
  }

  .seg.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .submit {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .hint {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--muted);
  }

  aside {
    display: grid;
    gap: 16px;
    padding: 20px;
    border: 1px solid var(--line);
  }

  .swatches {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }

  .upload {
    display: block;
    padding: 13px;
    text-align: center;
    border: 1px solid var(--line);
    border-radius: 3px;
    font-size: 13px;
    cursor: pointer;
  }

  .upload:hover {
    border-color: var(--ink);
  }

  .upload.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .filename {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--muted);
  }

  .filename span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sw {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--line);
    cursor: pointer;
  }

  .sw.on {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .list {
    display: grid;
    gap: 10px;
    border-top: 1px solid var(--line);
    padding-top: 16px;
  }

  .list-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }

  .item {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: var(--muted);
  }

  .remove {
    border: 0;
    background: none;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
    cursor: pointer;
  }

  .remove:hover {
    color: var(--accent);
  }

  @media (max-width: 900px) {
    .cols,
    .kinds,
    .pair,
    .choices {
      grid-template-columns: 1fr;
    }
  }
</style>
