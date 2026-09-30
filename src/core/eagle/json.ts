// Every Eagle JSON file is plain JSON.stringify output: no spacing, no BOM, no trailing newline.
// Parsing with JSON.parse and re-serializing an untouched record reproduces the original bytes.

export function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/** JSON.parse that also tolerates a leading BOM (Eagle never writes one, but a tool might). */
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True for an empty file, or one that is only NUL bytes / whitespace (Dropbox and crashes leave these). */
export function isBlankOrNul(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0 && c !== 32 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}
