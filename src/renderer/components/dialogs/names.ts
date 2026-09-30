// Path and name helpers for the dialogs.
/** Split a path so the middle can be squeezed and the end always stays visible. */
export function splitPath(path: string, tailChars = 30): { head: string; tail: string } {
  if (path.length <= tailChars) return { head: '', tail: path };
  return {
    head: path.slice(0, path.length - tailChars),
    tail: path.slice(path.length - tailChars),
  };
}

/** Characters Windows won't allow in a folder name (the partner's Eagle syncs through Dropbox). */
export function libraryNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the library a name.';
  if (n === '.' || n === '..') return 'That name isn’t allowed.';
  const bad = n.match(/[\\/:*?"<>|]/);
  if (bad)
    return `Names can’t contain ${bad[0]}. Windows doesn’t allow it, so Eagle on Windows couldn’t open it.`;
  return null;
}
