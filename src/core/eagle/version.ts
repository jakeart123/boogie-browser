// Eagle refuses to open, or to save, a library whose applicationVersion is newer than its own,
// and treats a missing one as damage. So do we: we never write such a library, and never change
// the version we find.

/** The newest Eagle version whose library format we know. */
export const SUPPORTED_APP_VERSION = '4.0.0';

function parts(v: string): number[] | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** Numeric dotted compare: 4.0.1 > 4.0.0, 4.10.0 > 4.9.0. Anything unparseable counts as unsupported. */
export function isSupportedVersion(v: unknown, max: string = SUPPORTED_APP_VERSION): boolean {
  if (typeof v !== 'string') return false;
  const a = parts(v);
  const b = parts(max);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}
