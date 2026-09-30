// Plain-English history labels. Short, no em dashes.
import type { ItemPatch } from '../../shared/types';
import { plural } from './util';

export const itemsText = (n: number): string => plural(n, 'item');

/** A name someone chose (folder, tag, filter, item, library) inside a label: “name”, like the UI's toasts. */
export const quoted = (name: string): string => `“${name}”`;

/** "A", "A, B", "A, B, C", "A, B and 3 more". */
export function listText(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** What an updateItems patch did, as one label. Several kinds of edits at once become "Edited N items". */
export function patchLabel(
  patch: ItemPatch,
  n: number,
  folderName: (id: string) => string | undefined,
): string {
  const labels: string[] = [];
  const who = itemsText(n);
  const folders = (ids: string[]) =>
    listText(
      ids.map((id) => {
        const name = folderName(id);
        return name === undefined ? 'a folder' : quoted(name);
      }),
    );
  const tags = (names: string[]) => listText(names.map(quoted));

  if (patch.addTags?.length) labels.push(`Tagged ${who} ${tags(patch.addTags)}`);
  if (patch.removeTags?.length) {
    labels.push(
      `Removed ${patch.removeTags.length === 1 ? 'tag' : 'tags'} ${tags(patch.removeTags)} from ${who}`,
    );
  }
  if (patch.setTags) labels.push(`Set the tags on ${who}`);
  if (patch.star !== undefined) {
    labels.push(
      patch.star === 0
        ? `Cleared the rating on ${who}`
        : `Rated ${who} ${plural(patch.star, 'star')}`,
    );
  }
  if (patch.annotation !== undefined) labels.push(`Edited the notes on ${who}`);
  if (patch.url !== undefined) labels.push(`Changed the source link on ${who}`);
  if (patch.name !== undefined) labels.push(`Renamed ${who}`);

  const add = patch.addFolders ?? [];
  const remove = patch.removeFolders ?? [];
  if (patch.setFolders?.length === 0) {
    labels.push(`Took ${who} out of every folder`);
  } else if (patch.setFolders || (add.length && remove.length)) {
    labels.push(`Moved ${who} to ${folders(patch.setFolders ?? add)}`);
  } else if (add.length) {
    labels.push(`Added ${who} to ${folders(add)}`);
  } else if (remove.length) {
    labels.push(`Removed ${who} from ${folders(remove)}`);
  }

  return labels.length === 1 ? labels[0] : `Edited ${who}`;
}
