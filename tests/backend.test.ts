import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { EarthService } from '../server/service.js';
import { NasaAdapter, parseMetadata, parseObservationDate, verifyPng } from '../server/nasa.js';
import { startServer } from '../server/index.js';
import { ThumbnailCache } from '../server/thumbnails.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const fixturePng = new PNG({ width: 64, height: 64 });
fixturePng.data.fill(240);
const png = PNG.sync.write(fixturePng);
const record = (date: string, image = `epic_${date.replace(/[- :]/g, '')}`) => ({
  date,
  image,
  identifier: image,
  version: '03',
});
const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const imageResponse = (bytes: Buffer = png) =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });
type FetchHandler = (url: URL, init?: RequestInit) => Promise<Response> | Response;
const fakeFetch = (handler: FetchHandler): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      handler(
        new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
        init,
      ),
    )) as typeof fetch;
const directory = () => mkdtempSync(join(tmpdir(), 'blue-hour-test-'));

test('a newly saved key checks promptly while configuration changes preserve rate-limit backoff', async () => {
  const dir = directory();
  let metadataCalls = 0;
  let limited = false;
  const fetcher = fakeFetch((url) => {
    if (url.pathname.includes('/archive/')) return imageResponse();
    metadataCalls++;
    if (limited) return jsonResponse({}, 429, { 'retry-after': '7200' });
    return jsonResponse(url.pathname.endsWith('/all') ? [] : [record('2026-09-27 10:00:00')]);
  });
  let service = new EarthService({
    dataDir: dir,
    provider: 'public',
    fetch: fetcher,
    now: () => NOW,
    autoRefresh: false,
  });
  try {
    await service.refresh('natural');
    await service.idle();
    const latest = service.frames('natural').latestId;
    const callsBeforeNewKey = metadataCalls;
    await service.close();
    service = new EarthService({
      dataDir: dir,
      provider: 'nasa',
      apiKey: 'FAKE_NEW_USER_KEY',
      fetch: fetcher,
      now: () => NOW,
      autoRefresh: false,
    });
    assert.equal(service.status().collections.natural.lastSuccessfulCheck, null);
    assert.equal(service.frames('natural').latestId, latest);
    assert.equal(await service.refresh('natural'), 'started');
    await service.idle();
    assert.ok(metadataCalls > callsBeforeNewKey);
    await service.close();
    limited = true;
    service = new EarthService({
      dataDir: dir,
      provider: 'nasa',
      apiKey: 'FAKE_SECOND_USER_KEY',
      fetch: fetcher,
      now: () => NOW,
      autoRefresh: false,
    });
    await service.refresh('natural');
    await service.idle();
    const callsBeforeReplacement = metadataCalls;
    await service.close();
    service = new EarthService({
      dataDir: dir,
      provider: 'nasa',
      apiKey: 'FAKE_THIRD_USER_KEY',
      fetch: fetcher,
      now: () => NOW,
      autoRefresh: false,
    });
    assert.equal(await service.refresh('natural'), 'backoff');
    assert.equal(metadataCalls, callsBeforeReplacement);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UTC dates reject rollovers and shuffled metadata uses observation timestamp, with deduplication', () => {
  assert.equal(parseObservationDate('2026-02-30 01:00:00'), null);
  assert.equal(parseObservationDate('2026-09-26T20:00:00-04:00'), null);
  assert.equal(parseObservationDate('2026-09-27 00:00:00'), '2026-09-27T00:00:00.000Z');
  const records = parseMetadata(
    [
      record('2026-09-27 00:00:00', 'filename_19990101000000'),
      record('2026-09-26 23:59:59'),
      record('2026-09-26 23:59:59'),
      record('2026-02-30 00:00:00'),
      record('2026-09-27 02:00:00', '../../etc'),
    ],
    'natural',
  );
  assert.equal(records.length, 2);
  assert.equal(records.at(-1)!.observedAt, '2026-09-27T00:00:00.000Z');
  assert.equal(
    records.at(-1)!.provenance,
    'https://epic.gsfc.nasa.gov/archive/natural/2026/09/27/png/filename_19990101000000.png',
  );
});

test('full PNG decode rejects corrupt, truncated, HTML, and oversized dimensions', () => {
  assert.deepEqual(verifyPng(png), { width: 64, height: 64 });
  assert.throws(() => verifyPng(Buffer.from('<html>not imagery</html>')), /invalid-image/);
  assert.throws(() => verifyPng(png.subarray(0, png.length - 18)), /invalid-image/);
  const corrupted = Buffer.from(png);
  corrupted[45] ^= 0xff;
  assert.throws(() => verifyPng(corrupted), /invalid-image/);
  const huge = Buffer.from(png);
  huge.writeUInt32BE(200000, 16);
  assert.throws(() => verifyPng(huge), /invalid-image/);
});

test('newest unavailable image retains a verified frame and truthful newest-known metadata', async () => {
  const dir = directory();
  const newest = record('2026-09-27 10:00:00');
  const older = record('2026-09-27 09:00:00');
  const service = new EarthService({
    dataDir: dir,
    now: () => NOW,
    autoRefresh: false,
    fetch: fakeFetch((url) =>
      url.pathname.endsWith('/all')
        ? jsonResponse([])
        : url.pathname.includes('/archive/')
          ? imageResponse(url.pathname.includes(newest.image) ? Buffer.from('corrupt') : png)
          : jsonResponse([newest, older]),
    ),
  });
  try {
    assert.equal(await service.refresh('natural'), 'started');
    await service.idle();
    assert.equal(service.frames('natural').frames.length, 1);
    assert.equal(service.frames('natural').frames[0].observedAt, '2026-09-27T09:00:00.000Z');
    assert.equal(
      service.status().collections.natural.newestKnownObservedAt,
      '2026-09-27T10:00:00.000Z',
    );
    assert.equal(service.status().collections.natural.errorCode, 'image-unavailable');
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache survives offline restart, empty/malformed metadata cannot erase it, and manual backoff is enforced', async () => {
  const dir = directory();
  let mode = 'valid';
  let calls = 0;
  let clock = NOW;
  const fetcher = fakeFetch((url) => {
    calls++;
    if (mode === 'offline') throw new Error('private network exception');
    if (mode === 'empty') return jsonResponse([]);
    if (mode === 'malformed') return jsonResponse({ unexpected: true });
    return url.pathname.endsWith('/all')
      ? jsonResponse([])
      : url.pathname.includes('/archive/')
        ? imageResponse()
        : jsonResponse([record('2026-09-27 10:00:00')]);
  });
  let service = new EarthService({
    dataDir: dir,
    fetch: fetcher,
    now: () => clock,
    autoRefresh: false,
  });
  try {
    await service.refresh('natural');
    await service.idle();
    const saved = service.frames('natural').latestId;
    const before = calls;
    assert.equal(await service.refresh('natural'), 'backoff');
    assert.equal(calls, before);
    await service.close();
    mode = 'offline';
    clock += 3600000;
    service = new EarthService({
      dataDir: dir,
      fetch: fetcher,
      now: () => clock,
      autoRefresh: false,
    });
    assert.equal(service.frames('natural').latestId, saved);
    await service.refresh('natural');
    await service.idle();
    assert.equal(service.frames('natural').latestId, saved);
    assert.equal(service.status().collections.natural.errorCode, 'network');
    assert.equal(await service.refresh('natural'), 'backoff');
    mode = 'empty';
    clock += 3600000;
    await service.refresh('natural');
    await service.idle();
    assert.equal(service.status().collections.natural.errorCode, 'empty');
    assert.equal(service.frames('natural').latestId, saved);
    mode = 'malformed';
    clock += 3600000;
    await service.refresh('natural');
    await service.idle();
    assert.equal(service.status().collections.natural.errorCode, 'invalid-data');
    assert.equal(service.frames('natural').latestId, saved);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('429 retry instructions persist across restarts, affect both collections, and never fall back to public metadata', async () => {
  const dir = directory();
  let calls = 0;
  const fetcher = fakeFetch((url) => {
    calls++;
    assert.equal(url.host, 'api.nasa.gov');
    return jsonResponse({}, 429, { 'retry-after': '7200' });
  });
  let service = new EarthService({
    dataDir: dir,
    apiKey: 'FAKE_SENTINEL_FOR_TESTS',
    fetch: fetcher,
    now: () => NOW,
    autoRefresh: false,
  });
  try {
    await service.refresh('natural');
    await service.idle();
    assert.equal(service.status().collections.natural.errorCode, 'rate-limit');
    assert.equal(service.status().collections.natural.nextRetryAt, '2026-09-27T14:00:00.000Z');
    assert.equal(await service.refresh('enhanced'), 'backoff');
    await service.close();
    service = new EarthService({
      dataDir: dir,
      apiKey: 'FAKE_SENTINEL_FOR_TESTS',
      fetch: fetcher,
      now: () => NOW,
      autoRefresh: false,
    });
    assert.equal(await service.refresh('natural'), 'backoff');
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(service.status()).includes('FAKE_SENTINEL_FOR_TESTS'));
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authentication suspension persists and only a configuration change clears it', async () => {
  const dir = directory();
  let calls = 0;
  const fetcher = fakeFetch(() => {
    calls++;
    return jsonResponse({}, 403);
  });
  let service = new EarthService({
    dataDir: dir,
    apiKey: 'FAKE_KEY_A',
    fetch: fetcher,
    now: () => NOW,
    autoRefresh: false,
  });
  try {
    await service.refresh('natural');
    await service.idle();
    await service.close();
    service = new EarthService({
      dataDir: dir,
      apiKey: 'FAKE_KEY_A',
      fetch: fetcher,
      now: () => NOW + 86400000,
      autoRefresh: false,
    });
    assert.equal(await service.refresh('natural'), 'suspended');
    assert.equal(calls, 1);
    await service.close();
    service = new EarthService({
      dataDir: dir,
      apiKey: 'FAKE_KEY_B',
      fetch: fetcher,
      now: () => NOW + 86400000,
      autoRefresh: false,
    });
    assert.equal(await service.refresh('natural'), 'started');
    await service.idle();
    assert.equal(calls, 2);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credentials stay on the authenticated fixed host and never enter images, diagnostics, or exception messages', async () => {
  const sentinel = 'FAKE_SENTINEL_PRIVATE_TEST_ABC';
  const requested: string[] = [];
  const adapter = new NasaAdapter({
    apiKey: sentinel,
    fetch: fakeFetch((url, init) => {
      requested.push(url.host);
      assert.equal(init?.redirect, 'error');
      if (url.host === 'api.nasa.gov') {
        assert.equal(url.searchParams.get('api_key'), sentinel);
        return jsonResponse([record('2026-09-27 00:00:00')]);
      }
      assert.equal(url.search, '');
      return imageResponse();
    }),
  });
  const records = await adapter.observations('natural');
  await adapter.image(records[0]);
  assert.deepEqual(requested, ['api.nasa.gov', 'epic.gsfc.nasa.gov']);
  assert.ok(!JSON.stringify(records).includes(sentinel));
  const broken = new NasaAdapter({
    apiKey: sentinel,
    fetch: fakeFetch(() => {
      throw new Error(`sensitive URL ${sentinel}`);
    }),
  });
  await assert.rejects(
    () => broken.observations('natural'),
    (error) => String(error) === 'ServiceError: network',
  );
});

test('bounded concurrency, a frozen playback set, and cache capacity preserve all pinned observations', async () => {
  const dir = directory();
  let active = 0;
  let peak = 0;
  let clock = NOW;
  let newer = false;
  const records = Array.from({ length: 50 }, (_, index) =>
    record(
      `2026-09-27 ${String(Math.floor(index / 6)).padStart(2, '0')}:${String((index % 6) * 10).padStart(2, '0')}:00`,
    ),
  );
  const service = new EarthService({
    dataDir: dir,
    now: () => clock,
    autoRefresh: false,
    fetch: fakeFetch(async (url) => {
      if (url.pathname.includes('/archive/')) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return imageResponse();
      }
      return jsonResponse(newer ? [record('2026-09-27 11:00:00')] : records);
    }),
  });
  try {
    await service.refresh('natural');
    await service.idle();
    assert.equal(service.frames('natural').frames.length, 48);
    assert.ok(peak <= 2);
    const ids = service.frames('natural').frames.map((frame) => frame.id);
    assert.equal(service.cache.pinIds(ids), true);
    newer = true;
    clock += 3600000;
    await service.refresh('natural');
    await service.idle();
    assert.deepEqual(
      service.frames('natural').frames.map((frame) => frame.id),
      ids,
    );
    assert.equal(service.status().collections.natural.errorCode, 'storage');
    assert.equal(service.cache.pinIds([]), true);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache byte limit retains the last verified latest and startup removes interrupted files', async () => {
  const dir = directory();
  let newer = false;
  let clock = NOW;
  const fetcher = fakeFetch((url) =>
    url.pathname.includes('/archive/')
      ? imageResponse()
      : url.pathname.endsWith('/all')
        ? jsonResponse([])
        : jsonResponse([record(newer ? '2026-09-27 11:00:00' : '2026-09-27 10:00:00')]),
  );
  let service = new EarthService({
    dataDir: dir,
    now: () => clock,
    autoRefresh: false,
    cacheLimitBytes: png.length,
    fetch: fetcher,
  });
  try {
    await service.refresh('natural');
    await service.idle();
    const saved = service.frames('natural').latestId;
    newer = true;
    clock += 3600000;
    await service.refresh('natural');
    await service.idle();
    assert.equal(service.frames('natural').latestId, saved);
    assert.ok(service.cache.bytes <= png.length);
    await service.close();
    writeFileSync(join(dir, 'images', 'a1b2.partial'), Buffer.from('unfinished'));
    service = new EarthService({
      dataDir: dir,
      now: () => clock,
      autoRefresh: false,
      fetch: fetcher,
    });
    assert.equal(service.frames('natural').latestId, saved);
    assert.ok(!readdirSync(join(dir, 'images')).includes('a1b2.partial'));
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopback HTTP API serves only public data and explicit static assets, with request-origin defenses', async () => {
  const dir = directory();
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Blue Hour</title>');
  writeFileSync(join(dir, 'private.txt'), 'PRIVATE_TEST_ONLY');
  const sentinel = 'FAKE_SENTINEL_NOT_A_REAL_KEY';
  const app = await startServer({
    dataDir: join(dir, 'cache'),
    staticDir: web,
    apiKey: sentinel,
    autoRefresh: false,
    now: () => NOW,
    fetch: fakeFetch((url) =>
      url.pathname.includes('/archive/')
        ? imageResponse()
        : url.pathname.endsWith('/all')
          ? jsonResponse([])
          : jsonResponse([record('2026-09-27 10:00:00')]),
    ),
  });
  try {
    await app.service.refresh('natural');
    await app.service.idle();
    for (const path of ['/api/status', '/api/frames?collection=natural', '/']) {
      const response = await fetch(`${app.url}${path}`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(sentinel));
      assert.ok(!text.includes(dir));
    }
    for (const path of [
      '/.env',
      '/private.txt',
      '/%2e%2e/private.txt',
      '/%2eenv',
      '/api/frames?collection=other',
    ]) {
      const response = await fetch(`${app.url}${path}`);
      assert.ok(response.status >= 400);
    }
    const foreign = await fetch(`${app.url}/api/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.org' },
      body: JSON.stringify({ collection: 'natural' }),
    });
    assert.equal(foreign.status, 403);
    const ids = app.service.frames('natural').frames.map((frame) => frame.id);
    const pinned = await fetch(`${app.url}/api/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    assert.equal(pinned.status, 200);
    const image = await fetch(`${app.url}/images/${ids[0]}`);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const thumbnail = await fetch(`${app.url}/thumbnails/${ids[0]}`);
    assert.equal(thumbnail.status, 200);
    assert.equal(PNG.sync.read(Buffer.from(await thumbnail.arrayBuffer())).width, 64);
    const db = readFileSync(join(dir, 'cache', 'index.sqlite'));
    assert.ok(!db.includes(Buffer.from(sentinel)));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed lengths and oversized streaming metadata are rejected, while decoded gzip lengths are handled correctly', async () => {
  for (const header of ['NaN', '-1', '9999999999999999999999']) {
    const adapter = new NasaAdapter({
      fetch: fakeFetch(() => jsonResponse([], 200, { 'content-length': header })),
    });
    await assert.rejects(() => adapter.observations('natural'), /invalid-metadata/);
  }
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  const huge = new NasaAdapter({
    fetch: fakeFetch(
      () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    ),
  });
  await assert.rejects(() => huge.observations('natural'), /invalid-metadata/);
  assert.equal(canceled, true);
  const compressed = new NasaAdapter({
    fetch: fakeFetch(() =>
      jsonResponse([record('2026-09-27 00:00:00')], 200, {
        'content-encoding': 'gzip',
        'content-length': '32',
      }),
    ),
  });
  assert.equal((await compressed.observations('natural')).length, 1);
});

test('503 responses respect longer Retry-After instructions', async () => {
  const dir = directory();
  const service = new EarthService({
    dataDir: dir,
    now: () => NOW,
    autoRefresh: false,
    fetch: fakeFetch(() =>
      jsonResponse({}, 503, { 'retry-after': 'Sun, 27 Sep 2026 16:00:00 GMT' }),
    ),
  });
  try {
    await service.refresh('natural');
    await service.idle();
    assert.equal(service.status().collections.natural.nextRetryAt, '2026-09-27T16:00:00.000Z');
    assert.equal(await service.refresh('natural'), 'backoff');
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('successful zero-remaining quota headers stop further authenticated metadata without blocking public archive images', async () => {
  const dir = directory();
  let metadataCalls = 0;
  let imageCalls = 0;
  const service = new EarthService({
    dataDir: dir,
    apiKey: 'FAKE_QUOTA_TEST_KEY',
    now: () => NOW,
    autoRefresh: false,
    fetch: fakeFetch((url) => {
      if (url.host === 'api.nasa.gov') {
        metadataCalls++;
        return jsonResponse([record('2026-09-27 10:00:00')], 200, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String((NOW + 120000) / 1000),
        });
      }
      imageCalls++;
      return imageResponse();
    }),
  });
  try {
    await service.refresh('natural');
    await service.idle();
    assert.equal(metadataCalls, 1);
    assert.equal(imageCalls, 1);
    assert.equal(service.frames('natural').frames.length, 1);
    assert.equal(service.status().collections.natural.errorCode, 'rate-limit');
    assert.equal(service.status().collections.natural.nextRetryAt, '2026-09-27T12:02:00.000Z');
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a state-persistence failure stays recoverable without rejecting the background refresh', async () => {
  const dir = directory();
  const service = new EarthService({
    dataDir: dir,
    now: () => NOW,
    autoRefresh: false,
    fetch: fakeFetch(() => jsonResponse([])),
  });
  service.cache.saveState = () => {
    throw new Error('simulated full disk');
  };
  try {
    await service.refresh('natural');
    await assert.doesNotReject(() => service.idle());
    assert.equal(service.status().collections.natural.errorCode, 'storage');
    assert.equal(await service.refresh('natural'), 'backoff');
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('thumbnail worker makes bounded real derivatives while preserving original image bytes', async () => {
  const dir = directory();
  const path = join(dir, 'observation.png');
  const source = new PNG({ width: 256, height: 128 });
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const offset = (y * source.width + x) * 4;
      source.data[offset] = x < 128 ? 255 : 0;
      source.data[offset + 2] = x < 128 ? 0 : 255;
      source.data[offset + 3] = 255;
    }
  const original = PNG.sync.write(source);
  writeFileSync(path, original);
  const cache = new ThumbnailCache();
  try {
    const [one, two] = await Promise.all([cache.get('fixture', path), cache.get('fixture', path)]);
    assert.deepEqual(one, two);
    const thumbnail = PNG.sync.read(one);
    assert.equal(thumbnail.width, 128);
    assert.equal(thumbnail.height, 64);
    assert.equal(thumbnail.data[0], 255);
    assert.equal(thumbnail.data[127 * 4 + 2], 255);
    assert.deepEqual(readFileSync(path), original);
  } finally {
    await cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
