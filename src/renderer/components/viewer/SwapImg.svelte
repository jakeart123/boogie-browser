<script lang="ts">
  import { untrack } from 'svelte';
  // An <img> that never blinks when `src` changes: the new picture loads invisibly on top of the
  // old one and takes over once it is ready (an edit bumps the URL's version even though the
  // pixels are the same, and a 100 MB JPEG must not flash empty while it re-decodes).
  interface Props {
    src: string;
    /** 'contain' for thumbnails whose shape may differ a little from the item's size. */
    fit?: 'fill' | 'contain';
    draggable?: boolean;
    ondragstart?: (e: DragEvent) => void;
    onload?: (img: HTMLImageElement) => void;
    onerror?: (src: string) => void;
    hidden?: boolean;
  }
  let {
    src,
    fit = 'fill',
    draggable = false,
    ondragstart,
    onload,
    onerror,
    hidden = false,
  }: Props = $props();

  interface Layer {
    src: string;
    ok: boolean;
  }
  let layers = $state.raw<Layer[]>([]);
  const els = new Map<string, HTMLImageElement>();

  /** A URL that failed once is not retried just because the effect ran again. */
  const bad = new Set<string>();

  $effect(() => {
    const s = src;
    untrack(() => {
      if (!s || bad.has(s) || layers.some((l) => l.src === s)) return;
      layers = [...layers, { src: s, ok: false }];
    });
  });

  /** The picture currently on screen (for snapshots). */
  export function current(): HTMLImageElement | null {
    const shownLayer = layers.find((l) => l.ok);
    return (shownLayer && els.get(shownLayer.src)) || null;
  }

  function loaded(layer: Layer, e: Event) {
    const at = layers.indexOf(layer);
    if (at < 0) return;
    // Drop everything older than the newcomer; keep newer ones that are still loading.
    layers = layers.slice(at).map((l) => (l === layer ? { ...l, ok: true } : l));
    onload?.(e.currentTarget as HTMLImageElement);
  }
  function failed(layer: Layer) {
    bad.add(layer.src);
    layers = layers.filter((l) => l !== layer);
    onerror?.(layer.src);
  }
  function track(node: HTMLImageElement, layerSrc: string) {
    els.set(layerSrc, node);
    return () => void els.delete(layerSrc);
  }
</script>

{#each layers as layer (layer.src)}
  <img
    {@attach (node) => track(node, layer.src)}
    src={layer.src}
    alt=""
    class:pending={!layer.ok}
    class:contain={fit === 'contain'}
    style:visibility={hidden ? 'hidden' : undefined}
    decoding="async"
    draggable={draggable ? 'true' : 'false'}
    {ondragstart}
    onload={(e) => loaded(layer, e)}
    onerror={() => failed(layer)}
  />
{/each}

<style>
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  img.contain {
    object-fit: contain;
  }
  img.pending {
    opacity: 0;
  }
</style>
