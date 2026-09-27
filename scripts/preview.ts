// Developer preview; the shipped desktop app has its own supervised service.
// Configuration is consumed here at runtime and never emitted to the console.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { startServer } from '../server/index';

async function main() {
  let apiKey: string | undefined;
  try {
    apiKey = parseEnv(await readFile('.env', 'utf8')).NASA_API_KEY;
  } catch {
    /* Public prototype. */
  }
  const service = await startServer({
    dataDir: path.resolve('.test-data/preview-cache'),
    staticDir: path.resolve('dist/web'),
    apiKey,
    provider: apiKey ? 'nasa' : 'public',
    port: 4173,
  });
  console.log('Blue Hour preview ready at http://127.0.0.1:4173');
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void service.close().then(() => process.exit());
    });
}
main().catch(() => {
  console.error('Preview could not start.');
  process.exitCode = 1;
});
