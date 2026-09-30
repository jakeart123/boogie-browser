// probe(): what is this file, and how big. Header reads only, no pixel decoding.

import type { ProbeResult } from '../contracts';
import type { MediaContext } from './context';
import { AUDIO_SIZE, FONT_SIZE, kindOfExt } from './formats';
import { headerSaysAnimated, sniffFile } from './sniff';
import { vipsHeader } from './vips';
import { readZipEntry } from './zip';

interface Dims {
  width: number;
  height: number;
}

/** PSD and PSB keep their size at a fixed spot: height then width, 4 bytes each, big endian. */
function psdDims(h: Buffer): Dims | null {
  if (h.length < 22) return null;
  const height = h.readUInt32BE(14);
  const width = h.readUInt32BE(18);
  return width && height ? { width, height } : null;
}

/** A Krita file's size is the size of its flattened `mergedimage.png` (PNG header, IHDR chunk). */
async function kraDims(path: string): Promise<Dims | null> {
  const head = await readZipEntry(path, 'mergedimage.png');
  if (!head || head.length < 24 || head.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/**
 * PDF page 1 size in points, truncated, the way Eagle's canvas gets it (A4 is 595 x 841). vips
 * rounds instead (842), and pdfinfo is the only tool that tells us the fraction. If pdfinfo is
 * missing we settle for vips.
 */
async function pdfDims(ctx: MediaContext, path: string): Promise<Dims | null> {
  try {
    const { stdout } = await ctx.runner.run('pdfinfo', ['-f', '1', '-l', '1', path], {
      timeoutMs: ctx.imageTimeoutMs,
    });
    const text = stdout.toString('utf8');
    const size = /Page\s+1 size:\s+([\d.]+) x ([\d.]+) pts/.exec(text);
    if (size) {
      const rot = Number(/Page\s+1 rot:\s+(\d+)/.exec(text)?.[1] ?? 0);
      const [w, h] = [Math.trunc(Number(size[1])), Math.trunc(Number(size[2]))];
      if (w && h)
        return rot === 90 || rot === 270 ? { width: h, height: w } : { width: w, height: h };
    }
  } catch (e) {
    if ((e as { reason?: string }).reason === 'closed') throw e;
  }
  const v = await vipsHeader(ctx, path);
  return v ? { width: v.width, height: v.height } : null;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

async function ffprobe(
  ctx: MediaContext,
  path: string,
): Promise<{ duration: number | null; hasVideo: boolean; hasAudio: boolean; dims: Dims | null }> {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=width,height,codec_type:stream_side_data=rotation:stream_tags=rotate:stream_disposition=attached_pic',
    '-of',
    'json',
    path,
  ];
  const { stdout } = await ctx.runner.run('ffprobe', args, { timeoutMs: ctx.videoTimeoutMs });
  const json = JSON.parse(stdout.toString('utf8')) as {
    format?: { duration?: string };
    streams?: FfprobeStream[];
  };
  const streams = json.streams ?? [];
  // Cover art in an mp3 shows up as a video stream; it is not a video.
  const video = streams.find(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.width && s.height,
  );
  const duration = Number(json.format?.duration);
  let dims: Dims | null = null;
  if (video) {
    // The file's display rotation: what a player (and Eagle's <video>) shows is upright.
    const rot =
      Math.abs(
        video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
          Number(video.tags?.rotate ?? 0),
      ) % 360;
    dims =
      rot === 90 || rot === 270
        ? { width: video.height!, height: video.width! }
        : { width: video.width!, height: video.height! };
  }
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    hasVideo: !!video,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    dims,
  };
}

export async function probeFile(ctx: MediaContext, path: string): Promise<ProbeResult> {
  // Unreadable or missing file: let the error through, the caller has a bigger problem.
  const { ext, header } = await sniffFile(path);
  const result: ProbeResult = {
    ext,
    width: null,
    height: null,
    duration: null,
    animated: false,
    kind: kindOfExt(ext),
  };
  result.animated = headerSaysAnimated(header);

  try {
    let dims: Dims | null = null;
    if (ext === 'psd' || ext === 'psb') {
      dims = psdDims(header);
    } else if (ext === 'kra') {
      dims = await kraDims(path);
    } else if (ext === 'pdf' || ext === 'ai') {
      dims = await pdfDims(ctx, path);
    } else if (result.kind === 'image' || ext === 'eps') {
      const h = await vipsHeader(ctx, path);
      if (h) {
        dims = { width: h.width, height: h.height };
        if ((ext === 'gif' || ext === 'webp' || ext === 'avif') && h.pages > 1)
          result.animated = true;
      }
    } else if (result.kind === 'video' || result.kind === 'audio') {
      const p = await ffprobe(ctx, path);
      result.duration = p.duration;
      dims = p.dims;
      // The container says what's inside: a .webm or .mp4 with no picture is audio, and an
      // .ogg or .m4a with a real video stream is video.
      if (result.kind === 'video' && !p.hasVideo && p.hasAudio) result.kind = 'audio';
      else if (result.kind === 'audio' && p.hasVideo) result.kind = 'video';
    }
    // Audio and fonts have no pixels; Eagle stores the size of the picture it draws for them.
    if (result.kind === 'audio') dims = AUDIO_SIZE;
    else if (result.kind === 'font') dims = FONT_SIZE;
    if (dims) {
      result.width = dims.width;
      result.height = dims.height;
    }
  } catch (e) {
    if ((e as { reason?: string }).reason === 'closed') throw e;
    // vips/ffprobe couldn't read it (corrupt, timeout, tool missing): no dimensions. The
    // importer treats that as a file without a preview.
  }
  return result;
}
