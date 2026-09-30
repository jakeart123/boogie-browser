// The MCP bearer token: 32 random bytes as hex in a 0600 file. Agents' configs point at the file
// (`claude mcp add ... $(cat api-token)`), so creation must be race safe and must never overwrite
// a token that exists. (The Eagle-compatible HTTP API has no token; it checks origins instead.)
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function readToken(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8').trim();
    return t.length >= 16 && !/\s/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Reads the token, creating the file (mode 0600) when it is missing. */
export function ensureToken(file: string): string {
  const existing = readToken(file);
  if (existing) {
    // A token that anyone else on the machine can read is no token: tighten it.
    try {
      if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    return existing;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Another process (a second app instance) created it a moment ago: use theirs. If it is empty
    // or garbage, replace it.
    const theirs = readToken(file);
    if (theirs) return theirs;
    writeFileSync(file, token + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return token;
}

/** Cached view of the token file that notices when it is rotated (deleted or rewritten). */
export class TokenStore {
  private token = '';
  private stamp = '';

  constructor(private file: string) {}

  current(): string {
    let stamp = '';
    try {
      const st = statSync(this.file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* missing: ensureToken below recreates it, which is how a token is rotated */
    }
    if (!this.token || stamp !== this.stamp) {
      this.token = ensureToken(this.file);
      try {
        const st = statSync(this.file);
        this.stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        this.stamp = '';
      }
    }
    return this.token;
  }

  /** Constant-time check of an `Authorization` header value. */
  accepts(header: string | undefined): boolean {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!m) return false;
    const digest = (s: string) => createHash('sha256').update(s).digest();
    return timingSafeEqual(digest(m[1]), digest(this.current()));
  }
}
