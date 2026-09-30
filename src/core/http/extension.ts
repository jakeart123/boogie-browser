// Port 41593: where the Eagle browser extension sends its saves (form-encoded POST, `type`
// picks the action) and its old-API "is Eagle open" probe. The exact replies of real Eagle's
// 41593 are unknown (compiled code), so ours are minimal: `{status:"success"}` right away, with
// the import running as a job. Needs a live test with the real extension.
import {
  bookmarkEntry,
  bytesEntry,
  checkSourceUrl,
  decodeImageData,
  pickFolders,
  readSpec,
  startAdd,
  urlEntry,
} from './add';
import type { Ctx, Req, RouteTable } from './context';
import type { Args } from './util';
import { HttpError, Reply, str } from './util';

const MAX_IMAGES = 1000;

export function extensionRoutes(ctx: Ctx): RouteTable {
  return {
    '/': {
      // The extension reads showCollectModal from the top level; the data copy matches the
      // other port's envelope.
      GET: () =>
        new Reply(200, {
          status: 'success',
          showCollectModal: ctx.prefs.showCollectModal,
          data: { showCollectModal: ctx.prefs.showCollectModal },
        }),
      POST: (r) => save(ctx, r),
    },
  };
}

async function save(ctx: Ctx, r: Req): Promise<undefined> {
  const a = r.args;
  const type = str(a.type);
  // The page the item came from is `url`; `title` is the name the extension suggests.
  const common = { ...a, name: a.title, website: a.url };
  const folders = await pickFolders(ctx, a);

  if (type === 'image') {
    const src = str(a.src);
    if (!src) throw new HttpError(400, 'src is required.');
    await startAdd(ctx, r, [await urlEntry(r, src, readSpec(common), folders)]);
  } else if (type === 'screen capture') {
    const data = str(a.base64);
    if (!data) throw new HttpError(400, 'base64 is required.');
    const spec = readSpec(common);
    const { bytes, ext } = decodeImageData(data);
    const name = `${spec.name ?? 'Screen capture'}.${ext}`;
    await startAdd(ctx, r, [bytesEntry(bytes, name, spec, folders)]);
  } else if (type === 'save-url') {
    const url = str(a.url) ?? str(a.src);
    if (!url) throw new HttpError(400, 'url is required.');
    const spec = readSpec({ ...common, website: url });
    const image = str(a.base64);
    const title = spec.name ?? (checkSourceUrl(url).hostname || url);
    const thumb = image ? decodeImageData(image, 'jpg').bytes : undefined;
    await startAdd(ctx, r, [bookmarkEntry(url, title, spec, folders, thumb)]);
  } else if (type === 'import-images') {
    // "Save all images on this page": every source is checked first, then ONE job saves them all.
    const entries = [];
    for (const img of readImages(a.images)) {
      const spec = readSpec({ ...common, name: img.title ?? a.title });
      entries.push(await urlEntry(r, img.src, spec, folders));
    }
    await startAdd(ctx, r, entries);
  } else {
    throw new HttpError(400, `Unknown type: ${type ?? '(none)'}`);
  }
  return undefined;
}

/** `images` is a JSON string of `[{src, title, ...}]` (already an array if sent as JSON). */
function readImages(raw: unknown): { src: string; title?: string }[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'images must be a JSON list.');
    }
  }
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'images must be a JSON list.');
  if (v.length > MAX_IMAGES) throw new HttpError(400, `Too many images (max ${MAX_IMAGES}).`);
  return v.map((x: unknown) => {
    const o = (x && typeof x === 'object' ? x : {}) as Args;
    // Some page images come as "url 1.5x"; only the url part is wanted.
    const src = str(o.src)?.split(/\s+/)[0];
    if (!src) throw new HttpError(400, 'Every image needs a src.');
    return { src, title: str(o.title) };
  });
}
