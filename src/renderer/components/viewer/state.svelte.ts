// State the viewer modes share: the view-only toggles (flip, grayscale, rotate, background),
// compare/present settings, and hooks that let the key commands reach whatever is on screen
// (the stages for zoom, the media bar for playback). None of this is ever written to a library.

import { readJSON, writeJSON } from '../../lib/storage';

export type Bg = 'dark' | 'checker' | 'light';
export const BGS: Bg[] = ['dark', 'checker', 'light'];
export type CompareMode = 'side' | 'split' | 'overlay';

/** What the zoom keys and the zoom menu can ask a stage to do. */
export interface StageApi {
  /** Multiply the zoom (about the stage center). */
  zoomBy(factor: number): void;
  fit(): void;
  /** 100%: one picture pixel per CSS pixel. */
  actual(): void;
  /** Double-click behaviour: fit <-> 100% (or 200% for pictures smaller than the stage). */
  toggle(): void;
  /** Set an absolute scale (1 = 100%). */
  toScale(scale: number): void;
}

/** What Space, the seek keys and friends can ask the playing item to do. */
export interface Player {
  kind: 'video' | 'audio' | 'gif';
  toggle(): void;
  seek?(seconds: number): void;
  frame?(n: number): void;
  speed?(dir: 1 | -1): void;
  volume?(delta: number): void;
  mute?(): void;
  loop?(): void;
  fullscreen?(): void;
  /** Video only: the frame on screen to the clipboard, to a file, or as the item's thumbnail. */
  copyFrame?(): void;
  saveFrame?(): void;
  frameAsThumbnail?(): void;
}

const BG_KEY = 'viewer.bg';

function loadBg(): Bg {
  const v = readJSON<unknown>(BG_KEY, 'dark');
  return (BGS as unknown[]).includes(v) ? (v as Bg) : 'dark';
}

class ViewerState {
  bg = $state<Bg>(loadBg());
  flip = $state(false);
  gray = $state(false);
  /** Degrees, a multiple of 90. Resets when you move to another item. */
  rotate = $state(0);

  /** Compare: panes share zoom and pan. */
  sync = $state(true);
  compareMode = $state<CompareMode>('side');
  /** Compare overlay: how much of the top picture shows (0 to 1). */
  overlay = $state(0.5);

  /** Presentation: seconds per picture, and whether the timer is paused. */
  interval = $state(5);
  paused = $state(false);

  /** Zoom of the main stage, for the zoom button label. */
  zoom = $state({ scale: 1, atFit: true });

  /** Set by the media bar / GIF toggle while one is on screen. */
  player = $state.raw<Player | null>(null);
  /** Live stages (plain set: the commands only need it at key time). */
  stages = new Set<StageApi>();
  /** True when all live stages share one view (compare with sync on, split, overlay). */
  linked = $state(true);

  setBg(bg: Bg): void {
    this.bg = bg;
    writeJSON(BG_KEY, bg);
  }

  cycleBg(): void {
    this.setBg(BGS[(BGS.indexOf(this.bg) + 1) % BGS.length]);
  }

  turn(): void {
    this.rotate = (this.rotate + 90) % 360;
  }

  /** Run a zoom action on the stages. Linked stages share one view, so once is enough. */
  eachStage(fn: (s: StageApi) => void): void {
    const all = [...this.stages];
    if (this.linked) all.slice(0, 1).forEach(fn);
    else all.forEach(fn);
  }
}

export const viewer = new ViewerState();
