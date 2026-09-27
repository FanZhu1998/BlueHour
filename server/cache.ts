import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CachedFrame,
  Collection,
  CollectionState,
  Observation,
  ServiceError,
  initialState,
} from './model.js';
import { frameIdentity } from './nasa.js';

export const DEFAULT_CACHE_LIMIT = 512 * 1024 * 1024;
export class FrameCache {
  private readonly db: DatabaseSync;
  private readonly images: string;
  private readonly displayPins = new Map<Collection, Set<string>>();
  readonly limit: number;

  constructor(directory: string, limit = DEFAULT_CACHE_LIMIT) {
    this.limit = limit;
    this.images = join(directory, 'images');
    mkdirSync(this.images, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'index.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS frames (id TEXT PRIMARY KEY, collection TEXT NOT NULL, observed_at TEXT NOT NULL, bytes INTEGER NOT NULL, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS frames_collection_date ON frames(collection, observed_at);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.recover();
  }

  private recover() {
    const ids = new Set(this.all().map((frame) => frame.id));
    for (const file of readdirSync(this.images)) {
      if (/^[a-f0-9]{64}\.png$/.test(file) && ids.has(file.slice(0, 64))) continue;
      // Only remove our known cache artifacts, never unrelated files.
      if (/^[a-f0-9]{64}\.png$/.test(file) || /^[a-f0-9-]+\.partial$/.test(file)) {
        try {
          unlinkSync(join(this.images, file));
        } catch {
          /* Retry next startup. */
        }
      }
    }
    for (const frame of this.all()) {
      try {
        const path = this.path(frame.id)!;
        const stat = statSync(path);
        if (!stat.isFile() || stat.size !== frame.bytes) throw new Error();
        // Detect disk corruption without ever allowing a partial file into the index.
        if (createHash('sha256').update(readFileSync(path)).digest('hex') !== frame.checksum)
          throw new Error();
      } catch {
        this.remove(frame.id);
      }
    }
    this.enforceLimits();
  }

  all(collection?: Collection): CachedFrame[] {
    const rows = collection
      ? this.db
          .prepare(
            'SELECT record FROM frames WHERE collection = ? ORDER BY observed_at ASC, id ASC',
          )
          .all(collection)
      : this.db.prepare('SELECT record FROM frames ORDER BY observed_at ASC, id ASC').all();
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(String(row.record)) as CachedFrame];
      } catch {
        return [];
      }
    });
  }

  get(id: string): CachedFrame | null {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const row = this.db.prepare('SELECT record FROM frames WHERE id = ?').get(id);
    if (!row) return null;
    try {
      return JSON.parse(String(row.record));
    } catch {
      return null;
    }
  }

  latest(collection: Collection): CachedFrame | null {
    return this.all(collection).at(-1) ?? null;
  }
  path(id: string): string | null {
    return this.get(id) ? join(this.images, `${id}.png`) : null;
  }
  get bytes(): number {
    return Number(
      this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM frames').get()!.total,
    );
  }

  pin(collection: Collection, id: string | null): boolean {
    return this.pinMany(collection, id === null ? [] : [id]);
  }

  pinMany(collection: Collection, ids: string[]): boolean {
    if (ids.length > 48 || ids.some((id) => this.get(id)?.collection !== collection)) return false;
    this.displayPins.set(collection, new Set(ids));
    return true;
  }

  pinIds(ids: string[]): boolean {
    if (ids.length > 50) return false;
    const frames = ids.map((id) => this.get(id));
    if (frames.some((frame) => !frame)) return false;
    this.displayPins.clear();
    for (const frame of frames) {
      const pins = this.displayPins.get(frame!.collection) ?? new Set<string>();
      pins.add(frame!.id);
      this.displayPins.set(frame!.collection, pins);
    }
    return true;
  }

  state(collection: Collection): CollectionState {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE name = ?')
      .get(`state:${collection}`);
    try {
      return { ...initialState(), ...(row ? JSON.parse(String(row.value)) : {}) };
    } catch {
      return initialState();
    }
  }

  saveState(collection: Collection, state: CollectionState) {
    this.db
      .prepare('INSERT OR REPLACE INTO settings(name,value) VALUES (?,?)')
      .run(`state:${collection}`, JSON.stringify(state));
  }

  configure(provider: string, key?: string) {
    const revision = createHash('sha256')
      .update(`${provider}\0${key ?? ''}`)
      .digest('hex');
    const prior = this.db
      .prepare('SELECT value FROM settings WHERE name = ?')
      .get('configuration-revision');
    if (prior?.value !== revision) {
      for (const collection of ['natural', 'enhanced'] as const) {
        const state = this.state(collection);
        // A newly saved key/provider should be checked promptly rather than
        // inherit an hour-long successful check interval. Preserve rate-limit
        // and transient-failure backoff; configuration changes cannot evade it.
        if (state.authSuspended || !state.errorCode)
          this.saveState(collection, {
            ...state,
            authSuspended: false,
            lastAttemptAt: null,
            lastSuccessfulCheck: null,
            nextRetryAt: null,
            errorCode: null,
            failures: 0,
          });
      }
      this.db
        .prepare('INSERT OR REPLACE INTO settings(name,value) VALUES (?,?)')
        .run('configuration-revision', revision);
    }
  }

  private protectedIds(extra?: string): Set<string> {
    return new Set(
      [
        this.latest('natural')?.id,
        this.latest('enhanced')?.id,
        ...[...this.displayPins.values()].flatMap((ids) => [...ids]),
        extra,
      ].filter((id): id is string => !!id),
    );
  }

  private remove(id: string) {
    this.db.prepare('DELETE FROM frames WHERE id = ?').run(id);
    try {
      unlinkSync(join(this.images, `${id}.png`));
    } catch {
      /* Orphan recovery will retry. */
    }
  }

  private makeRoom(bytes: number, collection: Collection, incomingId: string) {
    const pinned = this.protectedIds(incomingId);
    let count = this.all(collection).length;
    let needed = Math.max(0, this.bytes + bytes - this.limit);
    const candidates = this.all().filter((frame) => !pinned.has(frame.id));
    const removals: CachedFrame[] = [];
    for (const frame of candidates) {
      if (needed <= 0 && (frame.collection !== collection || count < 48)) continue;
      removals.push(frame);
      needed -= frame.bytes;
      if (frame.collection === collection) count--;
    }
    // Do not evict anything if the incoming frame still cannot fit safely.
    if (needed > 0 || count >= 48 || bytes > this.limit) throw new ServiceError('cache-full');
    for (const frame of removals) this.remove(frame.id);
  }

  private enforceLimits() {
    const pinned = this.protectedIds();
    for (const frame of this.all()) {
      if (pinned.has(frame.id)) continue;
      if (this.bytes > this.limit || this.all(frame.collection).length > 48) this.remove(frame.id);
    }
  }

  put(
    observation: Observation,
    image: { bytes: Buffer; width: number; height: number; checksum: string },
    retrievedAt: string,
  ): CachedFrame {
    const id = frameIdentity(observation);
    const existing = this.get(id);
    if (existing) return existing;
    const temporary = join(this.images, `${randomUUID()}.partial`);
    const destination = join(this.images, `${id}.png`);
    try {
      this.makeRoom(image.bytes.length, observation.collection, id);
      writeFileSync(temporary, image.bytes, { flag: 'wx', mode: 0o600 });
      const descriptor = openSync(temporary, 'r+');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, destination);
      const frame: CachedFrame = {
        ...observation,
        id,
        retrievedAt,
        width: image.width,
        height: image.height,
        checksum: image.checksum,
        bytes: image.bytes.length,
        decodeStatus: 'verified',
      };
      this.db
        .prepare('INSERT INTO frames(id,collection,observed_at,bytes,record) VALUES (?,?,?,?,?)')
        .run(id, frame.collection, frame.observedAt, frame.bytes, JSON.stringify(frame));
      return frame;
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Nothing to clean. */
      }
      if (!this.get(id)) {
        try {
          unlinkSync(destination);
        } catch {
          /* Nothing to clean. */
        }
      }
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('storage');
    }
  }

  close() {
    this.db.close();
  }
}
