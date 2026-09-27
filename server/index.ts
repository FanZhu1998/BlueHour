import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { EarthService, ServiceOptions } from './service.js';
import { isCollection } from './model.js';
import { ThumbnailCache } from './thumbnails.js';

export interface ServerOptions extends ServiceOptions {
  staticDir: string;
  port?: number;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new Error('request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error('request');
    chunks.push(chunk);
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('request');
  return result as Record<string, unknown>;
}

export async function startServer(options: ServerOptions) {
  let service: EarthService;
  try {
    service = new EarthService(options);
  } catch {
    throw new Error('Unable to open the local image cache.');
  }
  const thumbnails = new ThumbnailCache();
  const staticRoot = existsSync(options.staticDir)
    ? realpathSync(options.staticDir)
    : resolve(options.staticDir);
  let origin = '';
  let host = '';

  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );

    const handle = async () => {
      if (
        request.headers.host !== host ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        json(response, 403, { error: 'forbidden' });
        return;
      }
      const url = new URL(request.url ?? '/', origin);
      if (url.pathname === '/api/status' && request.method === 'GET') {
        json(response, 200, service.status());
        return;
      }
      if (url.pathname === '/api/frames' && request.method === 'GET') {
        const collection = url.searchParams.get('collection') ?? 'natural';
        if (!isCollection(collection)) {
          json(response, 400, { error: 'invalid-collection' });
          return;
        }
        json(response, 200, service.frames(collection));
        return;
      }
      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        const data = await body(request);
        if (!isCollection(data.collection)) {
          json(response, 400, { error: 'invalid-collection' });
          return;
        }
        const result = await service.refresh(data.collection);
        json(response, result === 'started' ? 202 : 200, { result });
        return;
      }
      if (url.pathname === '/api/pin' && request.method === 'POST') {
        const data = await body(request);
        if (
          Array.isArray(data.ids) &&
          data.ids.length <= 50 &&
          data.ids.every((id) => typeof id === 'string')
        ) {
          const success = service.cache.pinIds(data.ids);
          json(response, success ? 200 : 404, { pinned: success });
          return;
        }
        if (
          !isCollection(data.collection) ||
          !(
            data.id === null ||
            typeof data.id === 'string' ||
            (Array.isArray(data.ids) &&
              data.ids.length <= 48 &&
              data.ids.every((id) => typeof id === 'string'))
          )
        ) {
          json(response, 400, { error: 'invalid-frame' });
          return;
        }
        const success = Array.isArray(data.ids)
          ? service.cache.pinMany(data.collection, data.ids as string[])
          : service.cache.pin(data.collection, data.id as string | null);
        json(response, success ? 200 : 404, { pinned: success });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        json(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const thumbnail = /^\/thumbnails\/([a-f0-9]{64})$/.exec(url.pathname);
      if (thumbnail) {
        const path = service.cache.path(thumbnail[1]!);
        if (!path) {
          json(response, 404, { error: 'not-found' });
          return;
        }
        const bytes = await thumbnails.get(thumbnail[1]!, path);
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
        response.end(request.method === 'HEAD' ? undefined : bytes);
        return;
      }
      const image = /^\/images\/([a-f0-9]{64})$/.exec(url.pathname);
      if (image) {
        const frame = service.cache.get(image[1]!);
        const path = service.cache.path(image[1]!);
        if (!frame || !path) {
          json(response, 404, { error: 'not-found' });
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': frame.bytes,
          'Cache-Control': 'private, max-age=31536000, immutable',
          ETag: `"${frame.checksum}"`,
        });
        if (request.method === 'HEAD') response.end();
        else
          createReadStream(path)
            .on('error', () => response.destroy())
            .pipe(response);
        return;
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        json(response, 400, { error: 'invalid-path' });
        return;
      }
      if (
        pathname.includes('\\') ||
        pathname.includes('\0') ||
        pathname.split('/').some((part) => part.startsWith('.'))
      ) {
        json(response, 404, { error: 'not-found' });
        return;
      }
      const path = resolve(staticRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
      const type = TYPES[extname(path).toLowerCase()];
      if (!type || !existsSync(path)) {
        json(response, 404, { error: 'not-found' });
        return;
      }
      const actual = realpathSync(path);
      const contained = relative(staticRoot, actual);
      if (
        contained === '..' ||
        contained.startsWith(`..${sep}`) ||
        isAbsolute(contained) ||
        !statSync(actual).isFile()
      ) {
        json(response, 404, { error: 'not-found' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      if (request.method === 'HEAD') response.end();
      else
        createReadStream(actual)
          .on('error', () => response.destroy())
          .pipe(response);
    };
    void handle().catch(() => {
      if (!response.headersSent) json(response, 400, { error: 'invalid-request' });
      else response.destroy();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch {
    await service.close();
    throw new Error('Unable to start the local Earth service.');
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Unable to start the local Earth service.');
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  return {
    url: origin,
    service,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error ? reject(new Error('Unable to stop the local Earth service.')) : resolve(),
        );
        server.closeAllConnections();
      });
      await service.close();
      await thumbnails.close();
    },
  };
}
