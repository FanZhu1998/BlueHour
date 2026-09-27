import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const temporary = await mkdtemp(path.join(tmpdir(), 'blue-hour-desktop-smoke-'));
const profile = path.join(temporary, 'profile');
const fixture = path.join(temporary, 'empty.env');
const artifacts = path.join(root, 'artifacts');
await mkdir(profile, { recursive: true });
await mkdir(artifacts, { recursive: true });
await writeFile(fixture, '# Intentionally unconfigured desktop smoke profile.\n');
const environment = { ...process.env, BLUE_HOUR_PRIVATE_ENV_FILE: fixture };
delete environment.NASA_API_KEY;
delete environment.ELECTRON_RUN_AS_NODE;
let application;
const launchOptions = {
  ...(packaged
    ? { executablePath: path.join(root, 'release', 'win-unpacked', 'Blue Hour.exe') }
    : {}),
  args: packaged ? [`--user-data-dir=${profile}`] : [root, `--user-data-dir=${profile}`],
  cwd: root,
  env: environment,
};

function check(condition, name) {
  if (!condition) throw new Error(`Desktop check failed: ${name}`);
  console.log(`PASS ${name}`);
}

try {
  application = await electron.launch(launchOptions);
  let page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.blueHour));

  const native = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    return {
      profile: app.getPath('userData'),
      local: new URL(window.webContents.getURL()).hostname === '127.0.0.1',
      isolated: preferences.contextIsolation,
      sandboxed: preferences.sandbox,
      noNode: preferences.nodeIntegration === false,
      noWebviews: preferences.webviewTag === false,
    };
  });
  check(path.resolve(native.profile) === path.resolve(profile), 'isolated temporary user profile');
  check(
    native.local && native.isolated && native.sandboxed && native.noNode && native.noWebviews,
    'local sandboxed desktop renderer',
  );

  const initial = await page.evaluate(async () => ({
    preferences: await window.blueHour.getPreferences(),
    noRequire: typeof window.require === 'undefined',
    methods: Object.keys(window.blueHour).sort().join(','),
  }));
  check(
    initial.noRequire && initial.methods === 'getPreferences,importKey,saveKey,updatePreferences',
    'narrow isolated preload bridge',
  );
  check(
    initial.preferences.hasApiKey === false && initial.preferences.provider === 'public',
    'unconfigured profile uses explicit public provider',
  );
  check(
    initial.preferences.display === null,
    'display defaults follow the interface until a user change',
  );

  const changed = await page.evaluate(() =>
    window.blueHour.updatePreferences({ provider: 'nasa' }),
  );
  const afterChange = await page.evaluate(() =>
    fetch('/api/status').then((response) => response.json()),
  );
  check(
    changed.provider === 'nasa' &&
      afterChange.provider === 'nasa' &&
      afterChange.configured === false,
    'native provider transition retains local origin',
  );
  const rejected = await page.evaluate(() =>
    window.blueHour.updatePreferences({ unexpected: true }).then(
      () => false,
      () => true,
    ),
  );
  check(rejected, 'unexpected native settings rejected');
  const display = { brightness: 62, reducedMotion: true, interval: 2000, panelSize: '3.4' };
  const savedDisplay = await page.evaluate(
    (display) => window.blueHour.updatePreferences({ display }),
    display,
  );
  check(
    JSON.stringify(savedDisplay.display) === JSON.stringify(display),
    'native display preferences accepted',
  );
  const invalidDisplay = await page.evaluate(() =>
    window.blueHour
      .updatePreferences({
        display: { brightness: 200, reducedMotion: false, interval: 1, panelSize: '7' },
      })
      .then(
        () => false,
        () => true,
      ),
  );
  check(invalidDisplay, 'out-of-range display settings rejected');
  await page.evaluate(() => window.blueHour.updatePreferences({ provider: 'public' }));
  const restored = await page.evaluate(() =>
    fetch('/api/status').then((response) => response.json()),
  );
  check(restored.provider === 'public', 'provider can return to public after restart');

  const blockedWindow = await page.evaluate(() => window.open('https://example.com') === null);
  check(blockedWindow && application.windows().length === 1, 'external windows blocked');
  const stored = JSON.parse(await readFile(path.join(profile, 'preferences.json'), 'utf8'));
  check(
    Object.keys(stored).sort().join(',') === 'autoStart,display,provider',
    'only non-secret preferences persisted',
  );

  await application.close();
  application = await electron.launch(launchOptions);
  page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.blueHour));
  const afterRestart = await page.evaluate(() => window.blueHour.getPreferences());
  check(
    JSON.stringify(afterRestart.display) === JSON.stringify(display),
    'display preferences survive a full desktop restart',
  );
  await page.waitForFunction(
    () =>
      document.documentElement.style.getPropertyValue('--interface-opacity') === '0.62' &&
      document.documentElement.dataset.reducedMotion === 'true',
  );
  check(true, 'renderer restores native display settings at a fresh loopback origin');
  if (packaged) {
    const deadline = Date.now() + 120000;
    let nextStatusAt = Date.now() + 30000;
    const reportStatus = async () => {
      const status = await page.evaluate(async () => {
        const value = await fetch('/api/status').then((response) => response.json());
        return {
          provider: value.provider,
          natural: value.collections.natural,
          enhanced: value.collections.enhanced,
        };
      });
      console.log('Sanitized packaged service status:', JSON.stringify(status));
    };
    let frameId = null;
    while (!frameId && Date.now() < deadline) {
      frameId = await page.evaluate(async () => {
        const manifest = await fetch('/api/frames?collection=natural').then((response) =>
          response.json(),
        );
        return manifest.frames[0]?.id ?? null;
      });
      if (!frameId && Date.now() >= nextStatusAt) {
        await reportStatus();
        nextStatusAt = Date.now() + 30000;
      }
      if (!frameId) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!frameId) {
      await reportStatus();
    }
    check(Boolean(frameId), 'packaged service saves a real NASA observation');
    const thumbnail = await page.evaluate(async (id) => {
      const response = await fetch(`/thumbnails/${id}`);
      const bytes = await response.arrayBuffer();
      const view = new DataView(bytes);
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        png: bytes.byteLength >= 24 && view.getUint32(0) === 0x89504e47,
        width: bytes.byteLength >= 24 ? view.getUint32(16) : 0,
        height: bytes.byteLength >= 24 ? view.getUint32(20) : 0,
      };
    }, frameId);
    check(
      thumbnail.status === 200 &&
        thumbnail.type === 'image/png' &&
        thumbnail.png &&
        thumbnail.width === 128 &&
        thumbnail.height === 128,
      'packaged worker creates a 128-pixel PNG thumbnail',
    );
  }
  const screenshot = packaged ? 'desktop-packaged-smoke.png' : 'desktop-smoke.png';
  await page.screenshot({ path: path.join(artifacts, screenshot), fullPage: true });
  console.log(`Desktop screenshot: artifacts/${screenshot}`);
} finally {
  await application?.close().catch(() => undefined);
  // Remove only the generated, verified directory below the OS temporary root.
  const relative = path.relative(tmpdir(), temporary);
  if (
    relative.startsWith('blue-hour-desktop-smoke-') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep)
  ) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
