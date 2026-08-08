<script lang="ts">
  import { coverBackground } from '$lib/data/catalog';

  /**
   * A cover. Uses the uploaded artwork when there is one, otherwise falls back
   * to a placeholder palette so the layout never has a hole in it.
   */
  interface Props {
    index?: number;
    src?: string | null | undefined;
    alt?: string;
    width?: string;
    height?: string;
    radius?: string;
  }

  let {
    index = 0,
    src = null,
    alt = '',
    width = '100%',
    height = '300px',
    radius = '2px 4px 4px 2px'
  }: Props = $props();

</script>

<div class="cover" style:width style:height style:border-radius={radius}>
  {#if src}
    <img {src} {alt} />
  {:else}
    <div class="placeholder" style:background={coverBackground(index)}></div>
  {/if}
</div>

<style>
  .cover {
    position: relative;
    overflow: hidden;
    box-shadow:
      inset 12px 0 22px -18px rgba(0, 0, 0, 0.9),
      inset -1px 0 0 rgba(255, 255, 255, 0.06),
      0 18px 40px -20px rgba(0, 0, 0, 0.65);
  }

  img,
  .placeholder {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
