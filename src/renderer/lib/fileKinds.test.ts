import { describe, expect, it } from 'vitest';
import { canRenderLocally } from '../../core/media/formats';
import { boogieDraws, canPlayVideo, fileKind, viewKind, wantsBadge } from './fileKinds';

describe('file kinds', () => {
  it('sends web images, PSDs and RAW files to the image stage, and the rest to their own views', () => {
    expect(['JPG', 'psd', 'heic', 'cr3', 'gif', 'kra'].map(viewKind)).toEqual(
      Array(6).fill('image'),
    );
    expect(['mp4', 'mts', 'mp3', 'ttf', 'pdf', 'zip', 'blend'].map(viewKind)).toEqual([
      'video',
      'video',
      'audio',
      'font',
      'pdf',
      'other',
      'other',
    ]);
  });
  it('agrees with the core on what Boogie draws itself, and shows those as pictures', () => {
    const exts = `jpg png gif webp psd psb kra clip cr2 cr3 nef dng heic tga exr svg ico ai eps pdf
      mp4 mov webm mkv avi ttf otf woff woff2 mp3 wav docx pptx xlsx txt md zip 7z blend obj
      glb sketch fig indd html`.split(/\s+/);
    for (const e of exts) expect([e, boogieDraws(e)]).toEqual([e, canRenderLocally(e)]);
    expect(['ai', 'eps', 'kra'].map(viewKind)).toEqual(['image', 'image', 'image']);
    expect(viewKind('clip')).toBe('other'); // nothing can draw it: the file panel, not a broken picture
  });
  it('keeps .ts as a plain file (TypeScript), not a video', () => {
    expect(fileKind('ts')).toBe('other');
  });
  it('only tries to play containers Chromium can open', () => {
    expect(canPlayVideo('MP4')).toBe(true);
    expect(canPlayVideo('avi')).toBe(false);
  });
  it('badges everything but everyday pictures', () => {
    expect(['jpg', 'PNG', 'webp'].map(wantsBadge)).toEqual([false, false, false]);
    expect(['gif', 'psd', 'mp4', 'cr2'].map(wantsBadge)).toEqual([true, true, true, true]);
  });
});
