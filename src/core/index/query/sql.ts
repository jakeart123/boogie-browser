// Tiny SQL-fragment helpers shared by the keyword, filter and smart folder compilers.

/** A boolean SQL expression over the `items` table (alias `i`) plus its positional parameters. */
export interface SqlFrag {
  sql: string;
  params: unknown[];
}

export const frag = (sql: string, ...params: unknown[]): SqlFrag => ({ sql, params });

export const TRUE: SqlFrag = frag('1');
export const FALSE: SqlFrag = frag('0');

export function joinFrags(parts: SqlFrag[], glue: 'AND' | 'OR'): SqlFrag {
  if (parts.length === 0) return glue === 'AND' ? TRUE : FALSE;
  if (parts.length === 1) return parts[0];
  return {
    sql: `(${parts.map((p) => p.sql).join(` ${glue} `)})`,
    params: parts.flatMap((p) => p.params),
  };
}

export const not = (f: SqlFrag): SqlFrag => ({ sql: `NOT (${f.sql})`, params: f.params });

/** Eagle's Date Created / Date Modified: the source file's time (btime / mtime), else the import time. */
export const timeOrImport = (col: 'btime' | 'mtime'): string =>
  `(CASE WHEN i.${col} <> 0 THEN i.${col} ELSE i.imported_at END)`;

/**
 * User text headed for an FTS MATCH or instr(): NUL can't be in an SQLite string literal (the
 * MATCH parser stops there and throws), and nothing in a library contains one anyway.
 */
export const cleanText = (s: string): string => s.replace(/\0/g, '');

/** `?,?,?` for an IN list. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');
