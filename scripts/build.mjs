import { build as viteBuild } from 'vite';
import { build as bundle } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateIcon } from './generate-icon.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// No dotenv loading here. Personal configuration is read only by the running
// desktop main process, never by the bundler or browser build.
await generateIcon();
await viteBuild();
await bundle({
  absWorkingDir: root,
  tsconfig: path.join(root, 'tsconfig.json'),
  entryPoints: ['electron/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: false,
  legalComments: 'none',
});
await bundle({
  absWorkingDir: root,
  tsconfig: path.join(root, 'tsconfig.json'),
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: false,
  legalComments: 'none',
});
console.log('Blue Hour desktop and interface built. Private configuration was not loaded.');
