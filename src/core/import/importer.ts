// The import front doors: files and folders, URLs, bytes and bookmarks. Each decides names,
// folders, tags and dates, then hands every file to the per-file pipeline (ingest.ts).
// Everything that writes inside the library goes through `deps.lib` (the Eagle adapter).
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { EagleRootRecord, ImportOptions, ImportResult } from '../../shared/types';
import type {
  ChangeContext,
  ImportDeps,
  Importer,
  ImporterFactory,
  ProbeResult,
  ScanProgress,
} from '../contracts';
import { autoTagsFor, findFolder, normalizeTags } from '../eagle';
import { dropFileExt, downloadUrl, filenameFromUrl, saveDataUrl, WebPageLink } from './download';
import { ensureFolders, FOLDER_GONE } from './folders';
import { Pipeline, type Job, type Outcome } from './ingest';
import { clipboardName, isInside, nameWithoutExt, reasonOf } from './util';
import { buildPlan, type Plan } from './walk';

const CONCURRENCY = 4;
/** A page's preview picture is only a thumbnail: anything bigger is not worth waiting for. */
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** The size of Eagle's page screenshots (its hidden capture window). */
const CARD = { width: 1440, height: 900 };

/** The folders every new item goes in (the target plus any extra ones) and their auto-tags. */
interface Target {
  folders: string[];
  autoTags: string[];
}

class ImporterImpl implements Importer {
  private lastStamp = 0;
  private readonly pipeline: Pipeline;

  constructor(private readonly deps: ImportDeps) {
    if (isInside(deps.tmpDir, deps.lib.root))
      throw new Error('The import temp folder must be outside the library.');
    this.pipeline = new Pipeline(deps);
  }

  // ───────────────────────── Front doors ─────────────────────────

  async importPaths(
    paths: string[],
    opts: ImportOptions,
    ctx: ChangeContext,
    onProgress?: (p: ScanProgress) => void,
    signal?: AbortSignal,
  ): Promise<ImportResult> {
    this.requireWritable();
    const result: ImportResult = { added: [], duplicates: [], failed: [] };
    const plan = await buildPlan(paths, !!opts.keepFolderStructure, this.deps.lib.root, signal);
    result.failed.push(...plan.failed);
    if (signal?.aborted) {
      // Cancelled while still looking at the paths: none of them was imported.
      const failed = new Set(plan.failed.map((f) => f.source));
      result.skipped = paths.filter((p) => !failed.has(p));
      return result;
    }
    if (!plan.files.length) return result;

    const extra = await this.target({ folderIds: opts.folderIds });
    const base = await this.target({ folderId: opts.folderId });
    // New folders go into the root BEFORE any item, so every item is newer than the root change
    // and the partner's Eagle doesn't "repair" items back to unfiled (format-spec 19.4 #18).
    await this.prepareFolders(plan.roots, opts, ctx);

    const total = plan.files.length;
    // An explicit name only makes sense for a single file.
    const named = total === 1 ? opts.name?.trim() : undefined;
    const first = this.stamps(opts, total);
    const outcomes: (Outcome | undefined)[] = new Array(total);
    let next = 0;
    let done = 0;

    const worker = async () => {
      while (!signal?.aborted) {
        const i = next++;
        if (i >= total) return;
        const { src, dir } = plan.files[i];
        const here: Target = dir ? { folders: [dir.folderId!], autoTags: dir.autoTags! } : base;
        outcomes[i] = await this.pipeline.ingest(
          {
            src,
            moveSource: false, // never move a file the user gave us
            name: named || nameWithoutExt(src),
            stripNameExt: !!named,
            ...this.filing(opts, here, extra),
            modificationTime: first + i,
            ...details(opts),
            thumb: 'auto',
            signal,
          },
          opts,
          ctx,
        );
        done++;
        try {
          onProgress?.({ done, total });
        } catch {
          /* a broken progress listener must not stop the import */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

    const skipped: string[] = [];
    plan.files.forEach((f, i) => {
      const outcome = outcomes[i];
      if (outcome && outcome.kind !== 'cancelled') collect(result, outcome, f.src);
      else skipped.push(f.src); // never started, or stopped part way: the import was cancelled
    });
    if (skipped.length) result.skipped = skipped;
    result.added = [...new Set(result.added)]; // "use existing" can name one item twice
    return result;
  }

  async importUrl(
    url: string,
    opts: ImportOptions & { referer?: string; headers?: Record<string, string> },
    ctx: ChangeContext,
    signal?: AbortSignal,
  ): Promise<ImportResult> {
    this.requireWritable();
    const target = await this.target(opts);
    const isData = /^data:/i.test(url);
    let tmp: string | null = null;
    try {
      let headerName: string | null = null;
      if (isData) {
        tmp = (await saveDataUrl(url, this.deps.tmpDir)).path;
      } else {
        const got = await downloadUrl(url, this.deps.tmpDir, {
          referer: opts.referer,
          headers: opts.headers,
          signal,
        });
        tmp = got.path;
        headerName = got.headerName;
      }
      // Name (unless the caller gave one): the server's file name, else the URL's last segment.
      const fromUrl = isData ? null : filenameFromUrl(url);
      const name = dropFileExt(headerName ?? fromUrl ?? '') || 'image';
      // Eagle stores the PAGE address, not the image's. Only fall back to the image address for
      // plain web links (a data: URL would bloat the record).
      const pageUrl = opts.url ?? (isData ? '' : url);
      return await this.single(tmp, url, { ...opts, url: pageUrl }, ctx, target, { name });
    } catch (e) {
      // A page, not a file: saved as a bookmark, like Eagle's "add links", with the page's own
      // preview picture as its thumbnail when it has one.
      if (e instanceof WebPageLink && !signal?.aborted)
        return this.pageAsBookmark(e, opts, ctx, signal);
      return failure(url, reasonOf(e));
    } finally {
      await this.removeTemp(tmp);
    }
  }

  private async pageAsBookmark(
    page: WebPageLink,
    opts: ImportOptions & { referer?: string; headers?: Record<string, string> },
    ctx: ChangeContext,
    signal?: AbortSignal,
  ): Promise<ImportResult> {
    let thumbnailPng: Uint8Array | undefined;
    if (page.imageUrl) {
      let shot: string | null = null;
      try {
        shot = (
          await downloadUrl(page.imageUrl, this.deps.tmpDir, {
            referer: page.url,
            maxBytes: PREVIEW_MAX_BYTES,
            idleTimeoutMs: 20_000,
            signal,
            // The page picked this address: a public page can't point Boogie at local ones.
            chosenBy: page.url,
          })
        ).path;
        thumbnailPng = new Uint8Array(await readFile(shot));
      } catch {
        // No preview picture: the bookmark gets the plain card instead.
      } finally {
        await this.removeTemp(shot);
      }
    }
    // The bookmark points at the page itself (opts.url, where a link was found, would be wrong).
    const { referer: _r, headers: _h, ...rest } = opts;
    return this.importBookmark(
      page.url,
      page.title ?? '',
      { ...rest, url: page.url, thumbnailPng },
      ctx,
    );
  }

  async importBytes(
    bytes: Uint8Array,
    fileName: string,
    opts: ImportOptions,
    ctx: ChangeContext,
  ): Promise<ImportResult> {
    this.requireWritable();
    const target = await this.target(opts);
    const file = basename(fileName || '') || `${clipboardName()}.png`;
    let tmp: string | null = null;
    try {
      await mkdir(this.deps.tmpDir, { recursive: true });
      const ext = extname(file).replace(/[^.a-z0-9]/gi, '');
      tmp = join(this.deps.tmpDir, `bytes-${randomUUID()}${ext}`);
      await writeFile(tmp, bytes);
      return await this.single(tmp, file, opts, ctx, target, { name: dropFileExt(file) });
    } catch (e) {
      return failure(file, reasonOf(e));
    } finally {
      await this.removeTemp(tmp);
    }
  }

  async importBookmark(
    url: string,
    title: string,
    opts: ImportOptions & { thumbnailPng?: Uint8Array },
    ctx: ChangeContext,
  ): Promise<ImportResult> {
    this.requireWritable();
    const target = await this.target(opts);
    const link = url.replace(/[\r\n]+/g, '').trim();
    const temps: string[] = [];
    try {
      if (!link) throw new Error('a bookmark needs a web address');
      await mkdir(this.deps.tmpDir, { recursive: true });
      const shortcut = join(this.deps.tmpDir, `bookmark-${randomUUID()}.url`);
      temps.push(shortcut);
      // Byte for byte what Eagle writes: LF line ends and five trailing spaces.
      await writeFile(shortcut, `[InternetShortcut]\nURL=${link}\n     `);

      // A screenshot, if the caller has one, becomes the thumbnail. Without one Eagle takes its own
      // (1440x900); Boogie can't, so it draws a plain card with the site's name at that size.
      let thumb: Job['thumb'] = 'none';
      let width: number | null = null;
      let height: number | null = null;
      if (opts.thumbnailPng?.length) {
        const png = join(this.deps.tmpDir, `bookmark-${randomUUID()}.png`);
        temps.push(png);
        try {
          await writeFile(png, opts.thumbnailPng);
          const shot = await this.deps.media.probe(png);
          width = shot.width;
          height = shot.height;
          thumb = { src: png, probe: shot };
        } catch {
          // A screenshot we can't read shouldn't lose the bookmark: it gets the card below.
        }
      }
      if (thumb === 'none') {
        const card = join(this.deps.tmpDir, `bookmark-${randomUUID()}.svg`);
        temps.push(card);
        await writeFile(card, bookmarkCard(link, title));
        ({ width, height } = CARD);
        thumb = {
          src: card,
          probe: { ext: 'svg', ...CARD, duration: null, animated: false, kind: 'image' },
        };
      }
      const probe: ProbeResult = {
        ext: 'url',
        width,
        height,
        duration: null,
        animated: false,
        kind: 'other',
      };
      const name = title.trim() || hostOf(link) || 'Bookmark';
      return await this.single(shortcut, link, { ...opts, url: opts.url ?? link }, ctx, target, {
        name,
        probe,
        thumb,
      });
    } catch (e) {
      return failure(link || url, reasonOf(e));
    } finally {
      for (const t of temps) await this.removeTemp(t);
    }
  }

  // ───────────────────────── Shared plumbing ─────────────────────────

  private requireWritable(): void {
    if (this.deps.lib.readOnly)
      throw new Error('This library is read-only, so nothing can be imported into it.');
  }

  /**
   * "Date added" for `n` items: the caller's (the Eagle API passes one), else now. Unique across
   * everything this importer does, the way Eagle numbers a batch (now + index).
   */
  private stamps(opts: ImportOptions, n: number): number {
    if (Number.isFinite(opts.modificationTime)) return opts.modificationTime!;
    const start = Math.max(Date.now(), this.lastStamp + 1);
    this.lastStamp = start + n - 1;
    return start;
  }

  /** Current root: the index's copy, or straight from disk if the index has none yet. */
  private async currentRoot(fresh = false): Promise<EagleRootRecord> {
    const cached = fresh ? null : this.deps.index.getRoot();
    return cached ?? (await this.deps.lib.readRoot()).value;
  }

  /** The requested folders (folderId, then folderIds) and their auto-tags. Throws if one is gone. */
  private async target(opts: Pick<ImportOptions, 'folderId' | 'folderIds'>): Promise<Target> {
    const folders = [
      ...new Set([opts.folderId, ...(opts.folderIds ?? [])].filter((f): f is string => !!f)),
    ];
    if (!folders.length) return { folders, autoTags: [] };
    let root = await this.currentRoot();
    if (folders.some((id) => !findFolder(root, id))) root = await this.currentRoot(true);
    if (folders.some((id) => !findFolder(root, id))) throw new Error(FOLDER_GONE);
    return { folders, autoTags: normalizeTags(folders.flatMap((id) => autoTagsFor(root, id))) };
  }

  /** Folders and tags for one item: its own target, the extra folders, and all their auto-tags. */
  private filing(opts: ImportOptions, own: Target, extra: Target) {
    return {
      folders: [...new Set([...own.folders, ...extra.folders])],
      tags: normalizeTags([...(opts.tags ?? []), ...own.autoTags, ...extra.autoTags]),
    };
  }

  /** Create every folder the batch needs in ONE root write, under the target folder. */
  private async prepareFolders(roots: Plan['roots'], opts: ImportOptions, ctx: ChangeContext) {
    if (!roots.length) return;
    // Work from the fresh root the adapter hands us, so the partner's folder edits are kept.
    const written = await this.deps.lib.updateRoot(
      (root) => ensureFolders(root, opts.folderId ?? null, roots) > 0,
      ctx,
    );
    // The index needs the new tree before items that point at these folders are added to it.
    if (written) {
      try {
        this.deps.index.setRoot(JSON.parse(written.after) as EagleRootRecord);
      } catch {
        /* the index is disposable; the next refresh reads the root again */
      }
    }
  }

  /** One-item import (URL, bytes, bookmark): build the job, run it, shape the result. */
  private async single(
    src: string,
    source: string,
    opts: ImportOptions,
    ctx: ChangeContext,
    target: Target,
    how: { name: string; probe?: ProbeResult; thumb?: Job['thumb'] },
  ): Promise<ImportResult> {
    const named = opts.name?.trim();
    const outcome = await this.pipeline.ingest(
      {
        src,
        moveSource: true, // our own temp file
        name: named || how.name,
        stripNameExt: !!named,
        ...this.filing(opts, target, { folders: [], autoTags: [] }),
        modificationTime: this.stamps(opts, 1),
        ...details(opts),
        probe: how.probe,
        thumb: how.thumb ?? 'auto',
      },
      opts,
      ctx,
    );
    const result: ImportResult = { added: [], duplicates: [], failed: [] };
    collect(result, outcome, source);
    return result;
  }

  private async removeTemp(path: string | null): Promise<void> {
    // Only ever delete our own temp files.
    if (path && isInside(path, this.deps.tmpDir)) await rm(path, { force: true }).catch(() => {});
  }
}

/** The per-item fields every import takes straight from the caller's options. */
function details(opts: ImportOptions) {
  const star = Math.round(opts.star ?? 0);
  return {
    url: (opts.url ?? '').slice(0, 2000), // Eagle cuts urls at 2000 chars
    annotation: opts.annotation ?? '',
    star: star >= 1 && star <= 5 ? star : 0,
  };
}

function failure(source: string, reason: string): ImportResult {
  return { added: [], duplicates: [], failed: [{ source, reason }] };
}

function collect(result: ImportResult, outcome: Outcome, source: string): void {
  if (outcome.kind === 'added') {
    result.added.push(outcome.id);
    if (outcome.warning) (result.warnings ??= []).push({ source, reason: outcome.warning });
  } else if (outcome.kind === 'duplicate')
    result.duplicates.push({ source, existingId: outcome.existingId });
  else if (outcome.kind === 'failed') result.failed.push({ source, reason: outcome.reason });
  else (result.skipped ??= []).push(source);
}

const xml = (t: string) =>
  t
    .replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const clip = (t: string, n: number) =>
  [...t].length > n ? `${[...t].slice(0, n - 1).join('')}…` : t;

/** A plain page card for a bookmark without a screenshot: the site's name, the page title, the link. */
export function bookmarkCard(url: string, title: string): string {
  const host = hostOf(url).replace(/^www\./, '') || 'Web page';
  const name = clip(title.trim(), 60);
  const link = clip(url, 90);
  const { width: w, height: h } = CARD;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="#eef0f3"/>`,
    `<rect x="120" y="150" width="${w - 240}" height="${h - 300}" rx="36" fill="#ffffff"/>`,
    `<text x="${w / 2}" y="${name ? 400 : 470}" font-family="sans-serif" font-size="96" font-weight="600" fill="#1f2328" text-anchor="middle">${xml(clip(host, 24))}</text>`,
    name
      ? `<text x="${w / 2}" y="510" font-family="sans-serif" font-size="44" fill="#57606a" text-anchor="middle">${xml(name)}</text>`
      : '',
    `<text x="${w / 2}" y="${h - 210}" font-family="sans-serif" font-size="30" fill="#8c959f" text-anchor="middle">${xml(link)}</text>`,
    '</svg>',
  ].join('');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export const importers: ImporterFactory = {
  create: (deps: ImportDeps): Importer => new ImporterImpl(deps),
};
