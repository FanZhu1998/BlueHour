import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ServiceError } from './model.js';

// The worker decodes only verified local files. Original observations are never modified.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { PNG } = require(workerData.pngModule);
parentPort.on('message', ({ id, path }) => {
  try {
    const source = PNG.sync.read(readFileSync(path), { checkCRC: true });
    const scale = Math.min(128 / source.width, 128 / source.height, 1);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const target = new PNG({ width, height });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = Math.min(source.width - 1, Math.max(0, (x + .5) / scale - .5));
      const sy = Math.min(source.height - 1, Math.max(0, (y + .5) / scale - .5));
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1);
      const dx = sx - x0, dy = sy - y0;
      for (let c = 0; c < 4; c++) {
        const top = source.data[(y0 * source.width + x0) * 4 + c] * (1 - dx) + source.data[(y0 * source.width + x1) * 4 + c] * dx;
        const bottom = source.data[(y1 * source.width + x0) * 4 + c] * (1 - dx) + source.data[(y1 * source.width + x1) * 4 + c] * dx;
        target.data[(y * width + x) * 4 + c] = Math.round(top * (1 - dy) + bottom * dy);
      }
    }
    const bytes = PNG.sync.write(target);
    parentPort.postMessage({ id, bytes });
  } catch { parentPort.postMessage({ id, failed: true }); }
});`;

interface Job {
  id: string;
  path: string;
  resolve: (bytes: Buffer) => void;
  reject: (error: Error) => void;
}

export class ThumbnailCache {
  private worker: Worker | null = null;
  private active: Job | null = null;
  private readonly queue: Job[] = [];
  private readonly cached = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer>>();
  private stopped = false;

  get(id: string, path: string): Promise<Buffer> {
    if (this.stopped) return Promise.reject(new ServiceError('storage'));
    const cached = this.cached.get(id);
    if (cached) {
      this.cached.delete(id);
      this.cached.set(id, cached);
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(id);
    if (pending) return pending;
    if (this.queue.length >= 64) return Promise.reject(new ServiceError('storage'));
    const promise = new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ id, path, resolve, reject });
    });
    this.pending.set(id, promise);
    this.next();
    return promise;
  }

  private next() {
    if (this.active || !this.queue.length || this.stopped) return;
    try {
      if (!this.worker) {
        const requireFromApp = createRequire(
          typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json'),
        );
        this.worker = new Worker(workerSource, {
          eval: true,
          workerData: { pngModule: requireFromApp.resolve('pngjs') },
          resourceLimits: { maxOldGenerationSizeMb: 192 },
        });
        this.worker.unref();
        this.worker.on(
          'message',
          (result: { id: string; bytes?: Uint8Array; failed?: boolean }) => {
            const job = this.active;
            this.active = null;
            if (job) {
              this.pending.delete(job.id);
              if (result.id === job.id && result.bytes && !result.failed) {
                const bytes = Buffer.from(result.bytes);
                this.cached.set(job.id, bytes);
                while (this.cached.size > 16) this.cached.delete(this.cached.keys().next().value!);
                job.resolve(bytes);
              } else job.reject(new ServiceError('invalid-image'));
            }
            this.next();
          },
        );
        this.worker.on('error', () => this.fail());
        this.worker.on('exit', (code) => {
          if (code !== 0 && !this.stopped) this.fail();
        });
      }
      this.active = this.queue.shift()!;
      this.worker.postMessage({ id: this.active.id, path: this.active.path });
    } catch {
      this.fail();
    }
  }

  private fail() {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.removeAllListeners();
      void worker.terminate();
    }
    const jobs = [...(this.active ? [this.active] : []), ...this.queue.splice(0)];
    this.active = null;
    for (const job of jobs) {
      this.pending.delete(job.id);
      job.reject(new ServiceError('invalid-image'));
    }
  }

  async close() {
    this.stopped = true;
    this.fail();
    this.cached.clear();
  }
}
