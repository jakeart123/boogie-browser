<script lang="ts">
  // A horizontal slider drawn with divs. A native <input type=range> would keep keyboard focus
  // after a click and swallow the viewer's arrow and Escape keys (the key handler skips inputs).
  interface Props {
    value: number;
    min?: number;
    max?: number;
    label: string;
    /** Second, lighter fill (how much of a video is downloaded). Same scale as value. */
    buffered?: number;
    /** Text for a hover tooltip at the pointer. */
    tip?: (v: number) => string;
    onchange: (v: number) => void;
  }
  let { value, min = 0, max = 1, label, buffered, tip, onchange }: Props = $props();

  let el = $state<HTMLDivElement>();
  let dragging = $state(false);
  let hover = $state<{ v: number; x: number } | null>(null);

  const pct = (v: number) =>
    max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0;

  function at(e: PointerEvent): { v: number; x: number } {
    const r = el!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return { v: min + f * (max - min), x: f * r.width };
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    el!.setPointerCapture(e.pointerId);
    dragging = true;
    onchange(at(e).v);
  }
  function move(e: PointerEvent) {
    const p = at(e);
    hover = tip ? p : null;
    if (dragging) onchange(p.v);
  }
  function up(e: PointerEvent) {
    dragging = false;
    el?.releasePointerCapture(e.pointerId);
  }
</script>

<div
  class="slider"
  class:dragging
  bind:this={el}
  role="slider"
  tabindex="-1"
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onpointerleave={() => (hover = null)}
>
  <div class="track">
    {#if buffered !== undefined}<div class="buf" style:width="{pct(buffered)}%"></div>{/if}
    <div class="fill" style:width="{pct(value)}%"></div>
  </div>
  <div class="knob" style:left="{pct(value)}%"></div>
  {#if hover && tip}<div class="tip" style:left="{hover.x}px">{tip(hover.v)}</div>{/if}
</div>

<style>
  .slider {
    position: relative;
    flex: 1;
    min-width: 40px;
    height: 20px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
    outline: none;
  }
  .track {
    position: relative;
    width: 100%;
    height: 3px;
    border-radius: 3px;
    background: var(--chip-line);
    overflow: hidden;
  }
  .buf,
  .fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
  }
  .buf {
    background: var(--fa);
    opacity: 0.55;
  }
  .fill {
    background: var(--tx);
  }
  .knob {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px;
    border-radius: 50%;
    background: var(--tx);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    transform: scale(0);
    transition: transform 100ms ease-out;
  }
  .slider:hover .knob,
  .slider.dragging .knob {
    transform: scale(1);
  }
  .tip {
    position: absolute;
    bottom: 22px;
    transform: translateX(-50%);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    color: var(--tx);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
  }
</style>
