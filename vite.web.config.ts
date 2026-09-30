// The renderer in a plain browser (no Electron), backed by the real core on a throwaway copy of
// a library. Used for UI work:
//   PORT=5201 npm run dev:web   then open http://127.0.0.1:5201
// See scripts/dev-backend.ts for the env switches (other library, read-only, reuse the copy).
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { devBackend } from './scripts/dev-backend';

export default defineConfig({
  root: 'src/renderer',
  plugins: [svelte(), devBackend()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5200), strictPort: true },
});
