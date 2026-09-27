import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Frontend builds must never load any private environment file.
  envDir: false,
  envPrefix: 'BLUE_HOUR_PUBLIC_',
  base: '/',
  build: { outDir: 'dist/web', emptyOutDir: true, sourcemap: false },
});
