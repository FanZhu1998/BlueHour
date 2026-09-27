// Capture the real desktop UI with a fresh public-provider profile and no credentials.
import { _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'blue-hour-readme-'));
const profile = path.join(temporary, 'profile');
const fixture = path.join(temporary, 'empty.env');
const output = path.join(root, 'docs', 'images', 'blue-hour-observatory.png');
await mkdir(profile, { recursive: true });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(fixture, '# Public-provider screenshot profile. No credentials.\n');
const environment = { ...process.env, BLUE_HOUR_PRIVATE_ENV_FILE: fixture };
delete environment.NASA_API_KEY;
delete environment.ELECTRON_RUN_AS_NODE;
const executable = path.join(root, 'release', 'win-unpacked', 'Blue Hour.exe');
const packaged = existsSync(executable);
let application;

try {
  application = await electron.launch({
    ...(packaged ? { executablePath: executable } : {}),
    args: packaged ? [`--user-data-dir=${profile}`] : [root, `--user-data-dir=${profile}`],
    cwd: root,
    env: environment,
  });
  const page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.blueHour));
  const safeProfile = await page.evaluate(async () => {
    const preferences = await window.blueHour.getPreferences();
    return !preferences.hasApiKey && preferences.provider === 'public';
  });
  if (!safeProfile) throw new Error('Screenshot profile must have no credential.');
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960);
  });
  console.log('Capturing a fresh public-provider profile; waiting for NASA imagery.');
  await page.waitForFunction(
    async () => {
      const status = await fetch('/api/status').then((response) => response.json());
      const manifest = await fetch('/api/frames?collection=natural').then((response) =>
        response.json(),
      );
      return manifest.frames.length >= 12 && !status.collections.natural.refreshing;
    },
    undefined,
    { timeout: 180000 },
  );
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await page.waitForFunction(() => {
    const image = document.querySelector('.earth-image');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  await page
    .getByRole('button', { name: 'Check for updates', exact: true })
    .waitFor({ timeout: 60000 });
  await page.locator('.filmstrip img').evaluateAll((images) => {
    for (const image of images) image.loading = 'eager';
  });
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete && image.naturalWidth > 0),
  );
  await page.locator('.frame-tile.selected').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  if (await page.locator('input').count())
    throw new Error('Screenshot must not contain input fields.');
  await page.screenshot({ path: output, fullPage: true, animations: 'disabled' });
  console.log('Saved docs/images/blue-hour-observatory.png (public imagery; no private profile).');
} catch {
  console.error(
    'Screenshot capture failed. No credential values or raw network errors are printed.',
  );
  process.exitCode = 1;
} finally {
  await application?.close().catch(() => undefined);
  const relative = path.relative(tmpdir(), temporary);
  if (
    relative.startsWith('blue-hour-readme-') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep)
  ) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
