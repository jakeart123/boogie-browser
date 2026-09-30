import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimPlayer, looksAnimated } from './anim.svelte';

// A fake decoder with frames of 100, 100 and 40 ms (a delay under 20 ms would be shown as 100 ms),
// and a canvas that counts draws.
function fakeEnvironment(frames: number, animated = true) {
  const drawn: number[] = [];
  const durations = [100_000, 100_000, 40_000];
  class FakeDecoder {
    tracks = { ready: Promise.resolve(), selectedTrack: { animated, frameCount: frames } };
    completed = Promise.resolve();
    async decode({ frameIndex }: { frameIndex: number }) {
      return {
        image: {
          displayWidth: 8,
          displayHeight: 6,
          duration: durations[frameIndex % 3],
          close() {},
        },
      };
    }
    close() {}
  }
  vi.stubGlobal('ImageDecoder', FakeDecoder);
  // A server without ranges: the one answer is the whole file, starting like a looping GIF.
  const file = new Blob([new TextEncoder().encode('GIF89a!\xff\x0bNETSCAPE2.0')]);
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, blob: async () => file }));
  const ctx = { clearRect() {}, drawImage: () => drawn.push(1) };
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, drawn };
}

describe('AnimPlayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('plays frames on their own delays, pauses on the frame it is on, and steps from there', async () => {
    const { canvas } = fakeEnvironment(3);
    const p = new AnimPlayer(canvas);
    await p.load('x', 'image/gif');
    expect([p.ready, p.count, p.index]).toEqual([true, 3, 0]);

    await vi.advanceTimersByTimeAsync(100);
    expect(p.index).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(p.index).toBe(2);
    await vi.advanceTimersByTimeAsync(40); // frame 2 lasts 40 ms, then it wraps to the start
    expect(p.index).toBe(0);

    p.toggle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect([p.playing, p.index]).toEqual([false, 0]); // held, not restarted

    p.step(-1); // wraps back past the first frame
    await vi.advanceTimersByTimeAsync(0);
    expect(p.index).toBe(2);
    p.step(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.index).toBe(0);
    p.destroy();
  });

  it('paces frames at the chosen speed', async () => {
    const { canvas } = fakeEnvironment(3);
    const p = new AnimPlayer(canvas);
    await p.load('x', 'image/gif');
    p.toggle(); // pause
    p.nudgeSpeed(1);
    p.nudgeSpeed(1);
    p.nudgeSpeed(1);
    expect(p.speed).toBe(2); // 1.25, 1.5, 2
    p.toggle(); // resume: shows the next frame at once, then waits 100 ms / 2 for the one after
    await vi.advanceTimersByTimeAsync(0);
    expect(p.index).toBe(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(p.index).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.index).toBe(2);
    p.destroy();
  });

  it('decodes a play-once GIF whose first frame is bigger than the header it reads', async () => {
    const { canvas } = fakeEnvironment(2);
    const file = gif(2, { frameBytes: 70_000 }); // no loop block, second frame past 64 KB
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: { headers?: Record<string, string> }) => {
      const range = init?.headers?.Range;
      asked.push(range ?? 'all');
      const body = range ? file.subarray(0, 64 * 1024) : file;
      return {
        ok: true,
        status: range ? 206 : 200,
        arrayBuffer: async () => body.slice().buffer,
        blob: async () => new Blob([body.slice()]),
      };
    });
    const p = new AnimPlayer(canvas);
    await p.load('x', 'image/gif');
    expect(asked).toEqual(['bytes=0-65535', 'all']);
    expect([p.kind, p.ready, p.count]).toEqual(['animated', true, 2]);
    p.destroy();
  });

  it('leaves a still picture to the <img>', async () => {
    const { canvas } = fakeEnvironment(1, false);
    const p = new AnimPlayer(canvas);
    await p.load('x', 'image/webp');
    expect(p.ready).toBe(false);
    p.destroy();
  });
});

describe('looksAnimated', () => {
  it('tells animated files from still ones by their first bytes', () => {
    const bytes = (...parts: (string | number[])[]) =>
      Uint8Array.from(
        parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
      );
    const webp = (flags: number) =>
      bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [flags]);
    expect(looksAnimated(webp(0x02), 'image/webp')).toBe('yes');
    expect(looksAnimated(webp(0x10), 'image/webp')).toBe('no'); // alpha only
    expect(looksAnimated(bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 '), 'image/webp')).toBe('no');

    const head = (b: Uint8Array) => b.subarray(0, 64 * 1024);
    expect(looksAnimated(gif(3, { loop: true }), 'image/gif', true)).toBe('yes');
    expect(looksAnimated(gif(2), 'image/gif', true)).toBe('yes'); // plays once: no loop block
    expect(looksAnimated(gif(1), 'image/gif', true)).toBe('no');
    // Pixel data full of 0x21 0xF9 pairs is not a second frame (the bytes a naive scan counted).
    expect(looksAnimated(gif(1, { frameBytes: 5000, trap: true }), 'image/gif', true)).toBe('no');
    // A first frame bigger than the bytes read: can't tell yet, so the caller decodes the file.
    const bigOnce = gif(2, { frameBytes: 70_000 });
    expect(looksAnimated(head(bigOnce), 'image/gif')).toBe('unknown');
    expect(looksAnimated(head(gif(1, { frameBytes: 70_000 })), 'image/gif')).toBe('unknown');
  });
});

/**
 * A structurally valid GIF: `frames` images of `frameBytes` pixel-data bytes each. `trap` fills the
 * pixel data with 0x21 0xF9 pairs, the bytes that start a frame's control block.
 */
function gif(
  frames: number,
  o: { loop?: boolean; frameBytes?: number; trap?: boolean } = {},
): Uint8Array {
  const out: number[] = [...'GIF89a'].map((c) => c.charCodeAt(0));
  out.push(8, 0, 8, 0, 0x80, 0, 0, ...[0, 0, 0, 255, 255, 255]); // 8x8, a 2-color global table
  if (o.loop)
    out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  for (let f = 0; f < frames; f++) {
    out.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0); // graphic control: 100 ms
    out.push(0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0, 2); // image descriptor, LZW code size 2
    let left = o.frameBytes ?? 4;
    while (left > 0) {
      const n = Math.min(255, left);
      out.push(
        n,
        ...Array.from({ length: n }, (_, i) => (!o.trap ? i & 0x7f : i % 2 ? 0xf9 : 0x21)),
      );
      left -= n;
    }
    out.push(0);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
