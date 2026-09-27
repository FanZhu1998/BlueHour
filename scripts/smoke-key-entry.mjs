import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// This check uses only fake credentials and an isolated profile. It never reads
// the workspace .env or the current user's private application configuration.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const temporary = await mkdtemp(path.join(tmpdir(), 'blue-hour-key-smoke-'));
const profile = path.join(temporary, 'profile');
const fixture = path.join(temporary, 'fake.env');
const firstKey = 'BLUE_HOUR_FAKE_ENTRY_CREDENTIAL_012345';
const replacementKey = 'BLUE_HOUR_FAKE_REPLACEMENT_CREDENTIAL_67890';
const seedKey = 'BLUE_HOUR_FAKE_BOOT_SEED_123456789';
const fakeValues = [firstKey, replacementKey, seedKey];
await mkdir(profile, { recursive: true });
await writeFile(fixture, '# Intentionally empty, isolated test configuration.\n');
const environment = { ...process.env, BLUE_HOUR_PRIVATE_ENV_FILE: fixture };
delete environment.NASA_API_KEY;
delete environment.ELECTRON_RUN_AS_NODE;
const launchOptions = {
  ...(packaged
    ? { executablePath: path.join(root, 'release', 'win-unpacked', 'Blue Hour.exe') }
    : {}),
  args: packaged ? [`--user-data-dir=${profile}`] : [root, `--user-data-dir=${profile}`],
  cwd: root,
  env: environment,
};
let application;
let requestLeak = false;
let remoteRendererRequest = false;
let diagnosticLeak = false;

function check(condition, name) {
  if (!condition) throw new Error(`Key-entry check failed: ${name}`);
  console.log(`PASS ${name}`);
}

function observe(page) {
  page.on('request', (request) => {
    const value = request.url() + (request.postData() ?? '');
    requestLeak ||= fakeValues.some((key) => value.includes(key));
    remoteRendererRequest ||= new URL(request.url()).hostname !== '127.0.0.1';
  });
  page.on('console', (message) => {
    diagnosticLeak ||= fakeValues.some((key) => message.text().includes(key));
  });
  page.on('pageerror', (error) => {
    diagnosticLeak ||= fakeValues.some((key) => error.message.includes(key));
  });
}

async function stubNasa() {
  // The backend receives harmless synthetic responses. Fake keys are never
  // transmitted to NASA, and authenticated URLs are never printed or retained.
  await application.evaluate(() => {
    globalThis.fetch = async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

async function openPreferences(page) {
  await page.getByRole('button', { name: 'Open preferences', exact: true }).click();
  const input = page.getByLabel('NASA API key', { exact: true });
  await expect(input).toBeVisible();
  return input;
}

async function verifyNoReadback(page) {
  const clean = await page.evaluate(async (values) => {
    const preferences = await window.blueHour.getPreferences();
    const surfaces = [
      document.documentElement.outerHTML,
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
      JSON.stringify(preferences),
      JSON.stringify(await fetch('/api/status').then((response) => response.json())),
    ];
    return surfaces.every((surface) => values.every((key) => !surface.includes(key)));
  }, fakeValues);
  check(clean, 'saved credentials absent from DOM, browser storage, preferences and status');
}

async function verifyEncrypted(expectedKey) {
  const ciphertext = await readFile(path.join(profile, 'secret.bin'));
  check(
    fakeValues.every((key) => !ciphertext.includes(Buffer.from(key))),
    'private store contains no plaintext credential',
  );
  const matches = await application.evaluate(
    async ({ safeStorage }, { bytes, expected }) => {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(bytes));
      return decrypted.result === expected;
    },
    { bytes: [...ciphertext], expected: expectedKey },
  );
  check(matches, 'OS-encrypted store contains the intended fake credential');
  const preferences = await readFile(path.join(profile, 'preferences.json'), 'utf8');
  check(
    fakeValues.every((key) => !preferences.includes(key)) &&
      Object.keys(JSON.parse(preferences)).sort().join(',') === 'autoStart,display,provider',
    'disk preferences contain only non-secret fields',
  );
}

try {
  application = await electron.launch(launchOptions);
  let page = await application.firstWindow();
  observe(page);
  await page.waitForFunction(() => Boolean(window.blueHour));
  const isolated = await application.evaluate(({ app }) => app.getPath('userData'));
  check(path.resolve(isolated) === path.resolve(profile), 'isolated temporary profile');
  await stubNasa();
  const initial = await page.evaluate(async () => ({
    preferences: await window.blueHour.getPreferences(),
    methods: Object.keys(window.blueHour).sort().join(','),
  }));
  check(
    initial.methods === 'getPreferences,importKey,saveKey,updatePreferences',
    'restricted desktop bridge exposes no credential readback',
  );
  check(!initial.preferences.hasApiKey, 'new profile has no saved credential');
  let input = await openPreferences(page);
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('type', 'password');
  await expect(input).toHaveAttribute('autocomplete', 'off');
  check(true, 'key entry starts empty, masked and without autocomplete');
  await input.fill(firstKey);
  await page.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Replace API key', exact: true })).toBeVisible();
  check(
    await page.evaluate(async () => (await window.blueHour.getPreferences()).hasApiKey),
    'direct entry saves and clears the draft',
  );
  await verifyNoReadback(page);
  await verifyEncrypted(firstKey);

  await input.fill('INVALID FAKE KEY WITH SPACES');
  await page.getByRole('button', { name: 'Replace API key', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(
    page.getByText('Enter a NASA API key with 4–160 letters, numbers, underscores, or hyphens.', {
      exact: true,
    }),
  ).toBeVisible();
  const rejected = await page.evaluate(async () => {
    const errors = [];
    for (const value of ['INVALID FAKE KEY WITH SPACES', 'ANOTHER INVALID FAKE VALUE']) {
      try {
        await window.blueHour.saveKey(value);
        return false;
      } catch (error) {
        const message = String(error?.message ?? '');
        if (message.includes(value)) return false;
        errors.push(message);
      }
    }
    return Boolean(errors[0]) && errors[0] === errors[1];
  });
  check(rejected, 'invalid entry is rejected with a fixed error and no value echo');
  await verifyEncrypted(firstKey);

  await input.fill(replacementKey);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  input = await openPreferences(page);
  await expect(input).toHaveValue('');
  check(true, 'closing preferences discards an unsaved key draft');
  await input.fill(replacementKey);
  await page.getByRole('button', { name: 'Replace API key', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Replace API key', exact: true })).toBeEnabled();
  await verifyEncrypted(replacementKey);
  await verifyNoReadback(page);

  // Keep the stored provider public for startup so the test can install the
  // fetch stub before any fake authenticated configuration could be used.
  await page.evaluate(() => window.blueHour.updatePreferences({ provider: 'public' }));
  await application.close();
  application = undefined;
  await writeFile(fixture, `NASA_API_KEY=${seedKey}\n`);
  application = await electron.launch(launchOptions);
  page = await application.firstWindow();
  observe(page);
  await page.waitForFunction(() => Boolean(window.blueHour));
  await stubNasa();
  const restored = await page.evaluate(() => window.blueHour.getPreferences());
  check(
    restored.hasApiKey && restored.provider === 'public',
    'saved key presence persists after a full restart',
  );
  await verifyEncrypted(replacementKey);
  check(true, 'saved replacement takes precedence over launcher seed configuration');
  input = await openPreferences(page);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Replace API key', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Metadata source', exact: true }).selectOption('nasa');
  await expect(page.getByRole('combobox', { name: 'Metadata source', exact: true })).toBeEnabled();
  await verifyNoReadback(page);
  check(
    !requestLeak && !remoteRendererRequest,
    'renderer requests stay local and contain no credentials',
  );
  check(!diagnosticLeak, 'renderer diagnostics contain no credentials');
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await page.getByRole('button', { name: 'Replace API key', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, packaged ? 'key-entry-packaged-smoke.png' : 'key-preferences.png'),
    fullPage: true,
  });
} finally {
  await application?.close().catch(() => undefined);
  // Delete only this generated direct child of the OS temporary directory.
  const relative = path.relative(tmpdir(), temporary);
  if (
    relative.startsWith('blue-hour-key-smoke-') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep)
  ) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
