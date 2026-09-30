// tags.json: the library's starred tags and Eagle's recent-tags list (historyTags, newest first).
// Boogie reads both and edits starred tags; it doesn't add to the recent list on every tag edit
// (a write per action means Dropbox churn, and a running Eagle rewrites the file from memory anyway).
import type { Actor, MutationResult } from '../../shared/types';
import type { ChangeContext, EagleTagsFile } from '../contracts';
import { normalizeTags } from '../eagle';
import { stringList } from '../index/project';
import { ensureWritable, runGroup, toResult } from './group';
import { listText, quoted } from './labels';
import { buildLibraryState } from './state';
import type { Session, Touch } from './types';

function remember(s: Session, text: string | null): void {
  if (text === null) {
    s.tagsFile = null;
    return;
  }
  try {
    const v = JSON.parse(text) as Partial<EagleTagsFile>;
    s.tagsFile = { starred: stringList(v.starredTags), recent: stringList(v.historyTags) };
  } catch {
    /* we just wrote it, so it parses; if not, the next read sorts it out */
  }
}

/** Read tags.json into the session. Returns true when what the UI shows changed. */
export async function loadTagsFile(s: Session): Promise<boolean> {
  if (!s.lib.readTagsFile) return false;
  const before = JSON.stringify(s.tagsFile);
  try {
    remember(s, (await s.lib.readTagsFile())?.text ?? null);
  } catch (e) {
    // Half-synced or damaged: keep what we had; it is never written over (the adapter refuses).
    if (!s.closed) console.error('[boogie] could not read tags.json', e);
    return false;
  }
  return JSON.stringify(s.tagsFile) !== before;
}

/** A running Eagle never re-reads tags.json and saves its own copy over it. */
function tagsFileWarning(s: Session): string | undefined {
  if (!s.shared) return undefined;
  const who = s.partnerName ? `${s.partnerName}'s` : "your partner's";
  return `If Eagle is open on ${who} computer, it won't see this until it restarts, and may put its own list back.`;
}

/**
 * One tags.json write inside a group. The file is optional in the adapter contract, so a library
 * adapter without it just skips (nothing to keep in step).
 */
export async function writeTagsFile(
  s: Session,
  ctx: ChangeContext,
  t: Touch,
  mutate: (file: EagleTagsFile) => boolean | void,
): Promise<boolean> {
  if (!s.lib.updateTagsFile) return false;
  const done = await s.lib.updateTagsFile(mutate, ctx);
  if (!done) return false;
  remember(s, done.after);
  t.warning ??= tagsFileWarning(s);
  return true;
}

/** `from` becomes `to` in a tags.json list; if `to` is already there, `from` just goes (Eagle's rule). */
export function renameInList(list: string[], from: string, to: string): boolean {
  const i = list.indexOf(from);
  if (i < 0) return false;
  if (list.includes(to)) list.splice(i, 1);
  else list[i] = to;
  return true;
}

export function removeFromList(list: string[], tag: string): boolean {
  const i = list.indexOf(tag);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** Star or unstar tags. Like Eagle, newly starred tags go to the front in the order given. */
export async function setTagStarred(
  s: Session,
  actor: Actor,
  rawNames: string[],
  starred: boolean,
): Promise<MutationResult> {
  ensureWritable(s);
  if (!s.lib.updateTagsFile) throw new Error("This library can't keep starred tags.");
  const names = normalizeTags(rawNames);
  if (!names.length) throw new Error('Pick a tag first.');
  const label = `${starred ? 'Starred' : 'Unstarred'} ${names.length === 1 ? 'tag' : 'tags'} ${listText(names.map(quoted))}`;

  const { entry, t } = await runGroup(s, actor, label, 'other', async (ctx, t) => {
    const wrote = await writeTagsFile(s, ctx, t, (file) => {
      const before = JSON.stringify(file.starredTags);
      const rest = file.starredTags.filter((x) => !names.includes(x));
      file.starredTags = starred ? [...names, ...rest] : rest;
      return JSON.stringify(file.starredTags) !== before;
    });
    t.count = wrote ? 1 : 0;
    if (!wrote) t.warning = undefined;
  });
  if (t.count) s.env.emit('library', buildLibraryState(s));
  return toResult(entry, t);
}
