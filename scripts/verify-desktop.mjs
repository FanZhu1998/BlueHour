import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(path.join(artifacts, 'desktop-check-'));
const entry = path.join(temporary, 'check.cjs');

try {
  await build({
    absWorkingDir: root,
    tsconfig: path.join(root, 'tsconfig.json'),
    stdin: {
      resolveDir: root,
      contents: `
        import { app } from 'electron';
        import { mkdir, readFile, writeFile } from 'node:fs/promises';
        import path from 'node:path';
        import { loadApiKey, saveApiKey, readApiKeyFile, validateApiKey, loadPreferences, savePreferences } from './electron/private-config';
        const dir = process.env.BLUE_HOUR_TEST_DIRECTORY;
        app.setPath('userData', dir);
        app.whenReady().then(async () => {
          const sentinel = 'BLUE_HOUR_FAKE_DESKTOP_CREDENTIAL_012345';
          await mkdir(dir, { recursive: true });
          const file = path.join(dir, 'fixture.env');
          await writeFile(file, 'UNRELATED_VALUE=unused\\nNASA_API_KEY="' + sentinel + '" # a private runtime value\\n');
          const parsed = await readApiKeyFile(file);
          const saved = await saveApiKey(dir, sentinel);
          const ciphertext = await readFile(path.join(dir, 'secret.bin'));
          const restored = await loadApiKey(dir);
          const display = { brightness: 62, reducedMotion: true, interval: 2000, panelSize: '3.4' };
          await savePreferences(dir, { provider: 'nasa', autoStart: false, display, secret: sentinel });
          const preferences = await loadPreferences(dir, true);
          const serialized = await readFile(path.join(dir, 'preferences.json'), 'utf8');
          const checks = {
            parsedOnlyNamedKey: parsed === sentinel,
            osEncryptionAvailable: saved,
            encryptedRoundTrip: restored === sentinel,
            ciphertextContainsNoPlaintext: !ciphertext.includes(Buffer.from(sentinel)),
            preferencesExcludePrivateFields: !serialized.includes(sentinel) && preferences.provider === 'nasa',
            displayPreferencesPersisted: JSON.stringify(preferences.display) === JSON.stringify(display),
            invalidCredentialRejected: validateApiKey('invalid value with whitespace') === undefined,
            missingPrivateFileIsSafe: await readApiKeyFile(path.join(dir, 'missing.env')) === undefined,
          };
          process.stdout.write(JSON.stringify(checks) + '\\n');
          app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
        }).catch(() => {
          process.stdout.write('Desktop private-storage verification failed.\\n');
          app.exit(1);
        });
      `,
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  });
  const environment = { ...process.env, BLUE_HOUR_TEST_DIRECTORY: path.join(temporary, 'profile') };
  delete environment.NASA_API_KEY;
  delete environment.BLUE_HOUR_PRIVATE_ENV_FILE;
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [entry], {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output, errorOutput }));
  });
  if (result.code !== 0) {
    // Raw process diagnostics are deliberately not replayed: this check deals in
    // credential handling, so even failure output is a fixed message.
    throw new Error('Desktop private-storage checks did not pass.');
  }
  const json = result.output.split(/\r?\n/).find((line) => line.startsWith('{'));
  if (!json) throw new Error('Desktop private-storage checks produced no result.');
  const checks = JSON.parse(json);
  for (const [name, passed] of Object.entries(checks)) {
    if (passed !== true) throw new Error('Desktop private-storage checks did not pass.');
    console.log(`PASS ${name}`);
  }
} finally {
  // Recursive cleanup is limited to the verified, generated workspace directory.
  const relative = path.relative(artifacts, temporary);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    await rm(temporary, { recursive: true, force: true });
  }
}
