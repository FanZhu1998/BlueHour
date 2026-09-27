import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  deviceScaleFactor: 1,
});
const errors = [];
const remoteRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (!request.url().startsWith('http://127.0.0.1:4173/'))
    remoteRequests.push(new URL(request.url()).origin);
});
try {
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.locator('.earth-image').first().waitFor({ timeout: 90_000 });
  await page.screenshot({ path: 'artifacts/observatory.png', fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Desktop must not overflow horizontally',
  );
  assert.equal(
    await page
      .locator('.earth-image')
      .first()
      .evaluate((image) => image.complete && image.naturalWidth > 0),
    true,
  );
  assert.match(await page.locator('body').innerText(), /UTC/);
  const frames = page.locator('.frame-tile');
  if ((await frames.count()) > 1) {
    await frames.first().click();
    await page.waitForFunction(() => {
      const first = document.querySelector('.frame-tile');
      return (
        first?.getAttribute('aria-pressed') === 'true' &&
        first.querySelector('img')?.getAttribute('src')?.replace('/thumbnails/', '/images/') ===
          document.querySelector('.earth-image')?.getAttribute('src')
      );
    });
    const selected = await page.locator('.earth-image').first().getAttribute('src');
    await page.waitForTimeout(7500);
    assert.equal(
      await page.locator('.earth-image').first().getAttribute('src'),
      selected,
      'Refresh must not interrupt selected historical frame',
    );
    await page.getByRole('button', { name: 'Play recorded sequence (space)', exact: true }).click();
    await page
      .getByRole('button', { name: 'Pause recorded sequence (space)', exact: true })
      .waitFor();
    await page.waitForTimeout(1500);
    await page
      .getByRole('button', { name: 'Pause recorded sequence (space)', exact: true })
      .click();
  }
  await page.getByLabel('Sequence', { exact: true }).selectOption('daily');
  await page.getByLabel('UTC observation date', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Latest', exact: true }).click();
  await page.screenshot({ path: 'artifacts/daily.png', fullPage: true });
  await page.getByRole('button', { name: 'Enhanced', exact: true }).click();
  const availability = page.getByRole('button', { name: 'View this observation' });
  if (await availability.isVisible()) await availability.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.collection-control button:last-child')
        ?.getAttribute('aria-pressed') === 'true',
  );
  await page.getByRole('button', { name: 'Open preferences', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('Interface brightness').focus();
  await page.getByLabel('Interface brightness').press('End');
  await page
    .getByRole('dialog')
    .locator('select')
    .filter({ has: page.locator('option[value="3.4"]') })
    .selectOption('3.4');
  await page.screenshot({ path: 'artifacts/preferences.png', fullPage: true });
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Desk view', exact: true }).click();
  await page.locator('.desk-circle').waitFor();
  const safe = await page.evaluate(() => {
    const circle = document.querySelector('.desk-circle').getBoundingClientRect();
    const cx = circle.x + circle.width / 2,
      cy = circle.y + circle.height / 2;
    return [
      ...document.querySelectorAll(
        '.desk-caption,.desk-freshness,.desk-controls button,.desk-identity',
      ),
    ].map((element) => {
      const b = element.getBoundingClientRect();
      const radius = Math.max(
        ...[b.left, b.right].flatMap((x) =>
          [b.top, b.bottom].map((y) => Math.hypot(x - cx, y - cy)),
        ),
      );
      return {
        element: element.className || element.getAttribute('aria-label'),
        ratio: radius / circle.width,
      };
    });
  });
  await page.screenshot({ path: 'artifacts/desk.png', fullPage: true });
  await page.getByRole('button', { name: 'Desk view modes and information', exact: true }).click();
  const modeBounds = await page.locator('.desk-mode-sheet').evaluate((element) => {
    const c = document.querySelector('.desk-circle').getBoundingClientRect(),
      b = element.getBoundingClientRect();
    return (
      Math.max(
        ...[b.left, b.right].flatMap((x) =>
          [b.top, b.bottom].map((y) => Math.hypot(x - c.x - c.width / 2, y - c.y - c.height / 2)),
        ),
      ) / c.width
    );
  });
  assert.ok(modeBounds <= 0.44, 'Open mode sheet stays inside circular safe area');
  await page.getByRole('button', { name: 'Close desk modes', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(8500);
  assert.equal(
    await page.locator('.desk-controls').evaluate((element) => element.inert),
    true,
    'Desk controls hide after inactivity',
  );
  assert.equal(
    await page.locator('.desk-caption').isVisible(),
    true,
    'Observation caption remains visible',
  );
  await page.mouse.move(40, 45);
  await page.getByRole('button', { name: 'Back to observatory' }).click();
  await page.locator('.observatory').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Mobile must not overflow horizontally',
  );
  console.log(
    JSON.stringify({
      browserErrors: errors,
      remoteRequests,
      circularBounds: safe,
      screenshots: ['observatory.png', 'daily.png', 'desk.png'],
    }),
  );
  assert.equal(errors.length, 0, 'Browser runtime errors');
  assert.equal(remoteRequests.length, 0, 'Browser must only request local origin');
  assert.ok(
    safe.every((item) => item.ratio <= 0.44),
    'Controls and caption must fit safe radius',
  );
} finally {
  await browser.close();
}
