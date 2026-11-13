import { defineConfig } from 'vite';

// Relative base so the build works from any path, e.g. https://user.github.io/webtone/
export default defineConfig({
  base: './',
  worker: { format: 'es' },
});
