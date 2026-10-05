// Small pure helpers for the status strip (kept out of the component so they can be tested).
import type { AppStatus, HistoryEntry } from '../../../shared/types';

const SYNC_WORDS: Record<AppStatus['sync']['state'], string> = {
  idle: 'Synced with Dropbox',
  syncing: 'Syncing…',
  offline: 'Dropbox is offline',
  unknown: 'Dropbox status unknown',
};

/** The core's plain-English detail wins; the fixed words are the fallback. */
export function syncText(sync: AppStatus['sync'] | null): string {
  if (!sync) return 'Dropbox status unknown';
  return sync.detail.trim() || SYNC_WORDS[sync.state];
}

/**
 * "Sam added 12 items to “Prix de Rome versions”". Only a partner's name is put in front: a shared
 * library without one gets the core's stand-in actor ("Dropbox"), which is not a person.
 */
export function externalText(e: HistoryEntry, partnerName: string | null): string {
  const who = e.actor.name;
  if (!who || who !== partnerName || e.label.startsWith(who)) return e.label;
  return `${who} ${e.label.charAt(0).toLowerCase()}${e.label.slice(1)}`;
}

/** One line per thing that is listening, or why nothing is. */
export function portLines(ports: AppStatus['ports'] | null): string[] {
  if (!ports) return ['Connections unknown'];
  const lines: string[] = [];
  if (ports.eagleApi) lines.push(`Eagle extension API on ${ports.eagleApi}`);
  if (ports.extension) lines.push(`Extension link on ${ports.extension}`);
  if (ports.mcp) lines.push(`MCP on ${ports.mcp}`);
  if (ports.reason) lines.push(ports.reason);
  if (!lines.length) lines.push('Nothing is listening');
  return lines;
}

/**
 * "Sam's Eagle is open · 3 of your changes waiting". Null when there's nothing worth saying
 * (the partner's Eagle isn't open and nothing of yours is waiting for it).
 */
export function partnerText(p: AppStatus['partner'], name: string | null): string | null {
  if (!p || (!p.active && !p.pending)) return null;
  const who = name ? `${name}’s Eagle` : 'The other Eagle';
  const parts = [p.active ? `${who} is open` : `${who} isn’t open`];
  if (p.pending) parts.push(`${p.pending.toLocaleString()} of your changes waiting`);
  return parts.join(' · ');
}

/**
 * "3 of your changes may have been overwritten by Sam’s Eagle". Null when there are none. Each
 * counts until you decide it in History ("Put my change back" or "Keep theirs"), or for 7 days.
 * The words are calm: Boogie can't be sure it was an old copy rather than the partner's own edit.
 */
export function oldCopiesText(p: AppStatus['partner'], name: string | null): string | null {
  const n = p?.oldCopies ?? 0;
  if (n <= 0) return null;
  const who = name ? `${name}’s Eagle` : 'your partner’s Eagle';
  return `${n.toLocaleString()} of your changes may have been overwritten by ${who}`;
}

/**
 * The warning for a shared library while Dropbox isn't syncing: edits made now can clash with the
 * partner's later (that is what makes conflicted copies). Null when there is nothing to warn about:
 * the library isn't shared, Dropbox is fine or just not known, or it can't be edited anyway.
 */
export function offlineWarning(
  sync: AppStatus['sync'] | null,
  shared: boolean,
  readOnly: boolean,
  partnerName: string | null,
): string | null {
  if (!shared || readOnly || sync?.state !== 'offline') return null;
  const who = partnerName ? `${partnerName}’s` : 'your partner’s';
  return `Dropbox isn’t syncing. Anything you change now may clash with ${who} changes later.`;
}
