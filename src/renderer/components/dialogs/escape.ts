// Escape inside a dialog. The global key handler swallows Escape before any element sees it, so
// anything inside a dialog that wants to eat Escape first (cancel an inline rename, close a
// little panel) registers here. The modal closes only when nobody claims the key.
const handlers: (() => boolean)[] = [];

/** Register while active. Return true from the handler when it used the key. Returns the unregister function. */
export function onEscape(handler: () => boolean): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.lastIndexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** True if an inner handler used the key. Newest first. */
export function runEscapeHandlers(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i]()) return true;
  return false;
}
