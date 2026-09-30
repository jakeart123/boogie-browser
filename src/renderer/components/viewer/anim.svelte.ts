// Plays an animated GIF or WebP from decoded frames on a canvas, so pause and frame stepping
// land on the frame you are really looking at. (An <img> can't be paused, and drawImage() of an
// animated <img> always returns frame 0, so a "snapshot" pause would jump back to the start.)
// Most WebPs (and some GIFs) are still pictures, so the first 64 KB are read to find out before
// anything else. A file that is (or may be) animated is then downloaded once, and the <img> shows
// that same copy while the frames decode.
import { nextSpeed } from './media';

/** The decoder keeps the whole encoded file in memory; past this we leave the <img> playing. */
export const MAX_ANIM_BYTES = 150 * 1024 * 1024;

/** Browsers show a GIF frame with a 0 or 10 ms delay as 100 ms, so we do too. */
export function frameMs(durationMicros: number | null | undefined): number {
  const ms = (durationMicros ?? 0) / 1000;
  return ms < 20 ? 100 : ms;
}

/** Wraps a frame number into 0..count-1 (also for negative steps). */
export function wrapFrame(i: number, count: number): number {
  return count > 0 ? ((i % count) + count) % count : 0;
}

export function animMime(ext: string): string | null {
  const e = ext.toLowerCase();
  return e === 'gif' ? 'image/gif' : e === 'webp' ? 'image/webp' : null;
}

const HEAD_BYTES = 64 * 1024;

export type AnimGuess = 'yes' | 'no' | 'unknown';

/**
 * From the start of a file: is it animated? WebP says so in its VP8X header (flag 0x02). A GIF is
 * walked block by block: a looping one has a NETSCAPE2.0 block before the second frame, a play-once
 * one just has a second image. When the first frame runs past the bytes we have (a big first frame),
 * the answer is 'unknown' and the caller decodes the whole file to find out. `whole` says the bytes
 * are the entire file, so running out of them means a broken GIF, which the <img> may still show.
 */
export function looksAnimated(head: Uint8Array, type: string, whole = false): AnimGuess {
  const ascii = (at: number, n: number) => String.fromCharCode(...head.subarray(at, at + n));
  if (type === 'image/webp')
    return ascii(12, 4) === 'VP8X' && (head[20] & 0x02) !== 0 ? 'yes' : 'no';
  if (ascii(0, 3) !== 'GIF') return 'no';
  const text = new TextDecoder('latin1').decode(head);
  if (text.includes('NETSCAPE2.0') || text.includes('ANIMEXTS1.0')) return 'yes';
  const out: AnimGuess = whole ? 'no' : 'unknown';
  const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  let p = 13 + table(head[10] ?? 0); // header, screen descriptor, global color table
  // Data sub-blocks: a length byte, that many bytes, until a zero length. False if cut off.
  const skipBlocks = () => {
    while (p < head.length) {
      const n = head[p++];
      if (n === 0) return true;
      p += n;
    }
    return false;
  };
  let images = 0;
  while (p < head.length) {
    const b = head[p];
    if (b === 0x3b) return 'no'; // the trailer after a single image
    if (b === 0x21) {
      p += 2; // extension introducer and label
      if (!skipBlocks()) return out;
    } else if (b === 0x2c) {
      if (++images > 1) return 'yes';
      if (p + 10 > head.length) return out;
      p += 10 + table(head[p + 9]) + 1; // descriptor, local color table, LZW code size
      if (!skipBlocks()) return out;
    } else return 'no'; // not a GIF block: broken, the <img> deals with it
  }
  return out;
}

export class AnimPlayer {
  /**
   * What the header said: until then the picture waits; a still one loads the usual way. 'animated'
   * means the whole file was fetched (it is, or may be, animated) and the <img> shows that copy.
   */
  kind = $state<'checking' | 'still' | 'animated'>('checking');
  /** The downloaded file, for the <img> to show while the frames decode (no second download). */
  src = $state<string | null>(null);
  /** True once the first frame is on the canvas and this player is in charge of the animation. */
  ready = $state(false);
  playing = $state(true);
  /** Frame on screen, and how many there are. */
  index = $state(0);
  count = $state(0);
  speed = $state(1);

  private dec: ImageDecoder | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dead = false;
  private download = new AbortController();
  private shownMs = 100;
  /** Frames are drawn one at a time, in the order they were asked for. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private canvas: HTMLCanvasElement) {}

  /** Check, fetch and decode. Resolves quietly (ready stays false) for a still picture or an error. */
  async load(url: string, type: string): Promise<void> {
    const signal = this.download.signal;
    let file: Blob;
    try {
      const res = await fetch(url, { signal, headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
      if (!res.ok) return void (this.kind = 'still');
      if (res.status === 206) {
        const head = new Uint8Array(await res.arrayBuffer());
        if (looksAnimated(head, type, head.length < HEAD_BYTES) === 'no')
          return void (this.kind = 'still');
        const full = await fetch(url, { signal });
        if (!full.ok) return void (this.kind = 'still');
        file = await full.blob();
      } else {
        // No ranges here, so this was the whole file anyway: the <img> gets this copy either way.
        file = await res.blob();
        const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
        if (looksAnimated(head, type, file.size <= HEAD_BYTES) === 'no') {
          if (!this.dead) ((this.src = URL.createObjectURL(file)), (this.kind = 'still'));
          return;
        }
      }
    } catch {
      if (!this.dead) this.kind = 'still';
      return;
    }
    if (this.dead) return;
    this.src = URL.createObjectURL(file);
    this.kind = 'animated';
    if (typeof ImageDecoder === 'undefined') return;
    try {
      const dec = new ImageDecoder({ data: file.stream(), type });
      this.dec = dec;
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      if (this.dead || !track?.animated) return; // a still picture after all: the <img> shows it
      await dec.completed;
      if (this.dead || track.frameCount < 2) return;
      this.count = track.frameCount;
      await this.draw(0);
      if (this.dead) return;
      this.ready = true;
      if (this.playing) this.schedule();
    } catch {
      /* the <img> keeps playing; there is just no pause */
    }
  }

  destroy(): void {
    this.dead = true;
    this.download.abort(); // stop reading a big file nobody is looking at any more
    clearTimeout(this.timer);
    if (this.src) URL.revokeObjectURL(this.src);
    try {
      this.dec?.close();
    } catch {
      /* already closed */
    }
    this.dec = null;
    this.ready = false;
  }

  toggle(): void {
    if (!this.ready) return;
    this.playing = !this.playing;
    clearTimeout(this.timer);
    if (this.playing) this.schedule(0);
  }

  /** Pause and move by `n` frames (wraps around the ends). */
  step(n: number): void {
    if (!this.ready) return;
    this.playing = false;
    clearTimeout(this.timer);
    void this.draw(wrapFrame(this.index + n, this.count));
  }

  /** Move to the next (1) or previous (-1) preset speed. */
  nudgeSpeed(dir: 1 | -1): void {
    this.speed = nextSpeed(this.speed, dir);
  }

  private schedule(after = this.shownMs / this.speed): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.advance(), Math.max(0, after));
  }

  private async advance(): Promise<void> {
    if (this.dead || !this.playing) return;
    const t0 = performance.now();
    await this.draw(wrapFrame(this.index + 1, this.count));
    if (this.dead || !this.playing) return;
    this.schedule(this.shownMs / this.speed - (performance.now() - t0));
  }

  private draw(i: number): Promise<unknown> {
    return (this.queue = this.queue.then(async () => {
      const dec = this.dec;
      if (this.dead || !dec) return;
      try {
        const { image } = await dec.decode({ frameIndex: i });
        if (this.dead) return image.close();
        const cv = this.canvas;
        if (cv.width !== image.displayWidth || cv.height !== image.displayHeight) {
          cv.width = image.displayWidth;
          cv.height = image.displayHeight;
        }
        const g = cv.getContext('2d');
        g?.clearRect(0, 0, cv.width, cv.height);
        g?.drawImage(image, 0, 0);
        this.shownMs = frameMs(image.duration);
        image.close();
        this.index = i;
      } catch {
        /* a bad frame: keep the last good one on screen */
      }
    }));
  }
}
