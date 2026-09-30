// Vite (vitest, electron-vite) inlines `?raw` imports as strings. schema.sql is imported this way so the
// index never has to find the file on disk at runtime, packaged or not.
declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
