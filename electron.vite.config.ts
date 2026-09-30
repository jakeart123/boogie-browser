import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/app/main.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/app/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [svelte()],
    server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5210), strictPort: true },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          reference: resolve('src/renderer/reference.html'),
        },
      },
    },
  },
});
