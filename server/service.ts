import type {
  ErrorCode as PublicErrorCode,
  FrameManifest,
  ServiceStatus,
} from '../shared/contracts.js';
import { FrameCache } from './cache.js';
import {
  Collection,
  CollectionState,
  ErrorCode,
  Observation,
  ServiceError,
  collections,
  publicFrame,
} from './model.js';
import { NasaAdapter, NasaOptions, frameIdentity } from './nasa.js';

export interface ServiceOptions extends NasaOptions {
  dataDir: string;
  cacheLimitBytes?: number;
  autoRefresh?: boolean;
  refreshIntervalMs?: number;
  random?: () => number;
}

function publicError(code: ErrorCode | null): PublicErrorCode {
  switch (code) {
    case 'rate-limited':
      return 'rate-limit';
    case 'invalid-metadata':
      return 'invalid-data';
    case 'invalid-image':
    case 'upstream':
      return 'image-unavailable';
    case 'cache-full':
      return 'storage';
    default:
      return code;
  }
}

export class EarthService {
  readonly cache: FrameCache;
  readonly adapter: NasaAdapter;
  private readonly now: () => number;
  private activeCollection: Collection | null = null;
  private activeJob: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly states = new Map<Collection, CollectionState>();

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.cache = new FrameCache(options.dataDir, options.cacheLimitBytes);
    this.adapter = new NasaAdapter(options);
    this.cache.configure(this.adapter.provider, options.apiKey);
    for (const collection of collections) this.states.set(collection, this.cache.state(collection));
    if (options.autoRefresh !== false) this.schedule(50);
  }

  private state(collection: Collection): CollectionState {
    return { ...this.states.get(collection)! };
  }

  private saveState(collection: Collection, state: CollectionState) {
    this.states.set(collection, { ...state });
    try {
      this.cache.saveState(collection, state);
    } catch {
      // A full/unwritable disk must never turn a refresh into an unhandled rejection.
      this.states.set(collection, {
        ...state,
        errorCode: 'storage',
        nextRetryAt: new Date(this.now() + 60000).toISOString(),
      });
    }
  }

  status(): ServiceStatus {
    const status = Object.fromEntries(
      collections.map((collection) => {
        const state = this.state(collection);
        return [
          collection,
          {
            refreshing: this.activeCollection === collection,
            lastSuccessfulCheck: state.lastSuccessfulCheck,
            lastAttempt: state.lastAttemptAt,
            nextRetryAt: state.nextRetryAt,
            errorCode: publicError(state.errorCode),
            latestId: this.cache.latest(collection)?.id ?? null,
            newestKnownObservedAt: state.newestKnownObservedAt,
            frameCount: this.cache.all(collection).length,
          },
        ];
      }),
    ) as ServiceStatus['collections'];
    return {
      provider: this.adapter.provider,
      configured: this.adapter.provider === 'public' || !!this.options.apiKey,
      collections: status,
      cacheBytes: this.cache.bytes,
      cacheLimitBytes: this.cache.limit,
      serverTime: new Date(this.now()).toISOString(),
    };
  }

  frames(collection: Collection): FrameManifest {
    return {
      collection,
      frames: this.cache.all(collection).map(publicFrame),
      latestId: this.cache.latest(collection)?.id ?? null,
      newestKnownObservedAt: this.state(collection).newestKnownObservedAt,
    };
  }

  async refresh(collection: Collection): Promise<'started' | 'busy' | 'backoff' | 'suspended'> {
    if (this.stopped) return 'suspended';
    if (this.activeJob) return 'busy';
    const state = this.state(collection);
    if (state.authSuspended) return 'suspended';
    if (state.nextRetryAt && Date.parse(state.nextRetryAt) > this.now() && state.errorCode)
      return 'backoff';
    if (state.lastAttemptAt && this.now() - Date.parse(state.lastAttemptAt) < 60000)
      return 'backoff';
    this.activeCollection = collection;
    this.activeJob = this.run(collection)
      .catch(() => {
        this.saveState(collection, {
          ...this.state(collection),
          errorCode: 'storage',
          nextRetryAt: new Date(this.now() + 60000).toISOString(),
        });
      })
      .finally(() => {
        this.activeJob = null;
        this.activeCollection = null;
        if (this.options.autoRefresh !== false && !this.stopped) this.schedule(250);
      });
    return 'started';
  }

  async idle(): Promise<void> {
    await this.activeJob;
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick() {
    if (this.stopped) return;
    if (this.activeJob) {
      this.schedule(1000);
      return;
    }
    const now = this.now();
    const due = collections.find((collection) => {
      const state = this.state(collection);
      return !state.authSuspended && (!state.nextRetryAt || Date.parse(state.nextRetryAt) <= now);
    });
    if (due) {
      const result = await this.refresh(due);
      if (result !== 'started') this.schedule(1000);
    } else this.schedule(30000);
  }

  private async download(observation: Observation) {
    if (this.cache.get(frameIdentity(observation))) return;
    const image = await this.adapter.image(observation);
    if (!this.stopped) this.cache.put(observation, image, new Date(this.now()).toISOString());
  }

  private async downloadBatch(observations: Observation[]): Promise<ServiceError | null> {
    let firstError: ServiceError | null = null;
    const queue = [...observations].reverse();
    const worker = async () => {
      while (queue.length && !this.stopped) {
        if (firstError?.code === 'rate-limited' || firstError?.code === 'authentication') break;
        const observation = queue.shift()!;
        try {
          await this.download(observation);
        } catch (error) {
          const safe = error instanceof ServiceError ? error : new ServiceError('storage');
          if (!firstError || safe.code === 'rate-limited' || safe.code === 'authentication')
            firstError = safe;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return firstError;
  }

  private async run(collection: Collection) {
    let state = this.state(collection);
    state.lastAttemptAt = new Date(this.now()).toISOString();
    this.saveState(collection, state);
    try {
      const observations = await this.adapter.observations(collection);
      if (this.stopped) return;
      state.lastSuccessfulCheck = new Date(this.now()).toISOString();
      const newest = observations.at(-1);
      if (newest) state.newestKnownObservedAt = newest.observedAt;
      this.saveState(collection, state);
      if (!newest) throw new ServiceError('empty');

      // Promote the maximum timestamp as soon as it is verified; older downloads cannot replace it.
      let imageError: ServiceError | null = null;
      try {
        await this.download(newest);
      } catch (error) {
        imageError = error instanceof ServiceError ? error : new ServiceError('storage');
      }
      if (imageError?.code === 'authentication' || imageError?.code === 'rate-limited')
        throw imageError;
      const selected = observations.slice(-48);
      const batchError = await this.downloadBatch(selected.filter((frame) => frame !== newest));
      imageError ??= batchError;
      if (batchError?.code === 'authentication' || batchError?.code === 'rate-limited')
        throw batchError;

      if (selected.length < 48 && !this.stopped) {
        const latestDate = newest.observedAt.slice(0, 10);
        const priorDates = (await this.adapter.dates(collection))
          .filter((date) => date < latestDate)
          .slice(0, 6);
        let count = selected.length;
        for (const date of priorDates) {
          if (count >= 48 || this.stopped) break;
          const older = (await this.adapter.observations(collection, date)).slice(-(48 - count));
          count += older.length;
          const error = await this.downloadBatch(older);
          imageError ??= error;
          if (error?.code === 'authentication' || error?.code === 'rate-limited') throw error;
        }
      }
      if (imageError) throw imageError;
      state = this.state(collection);
      state.errorCode = null;
      state.failures = 0;
      state.authSuspended = false;
      const interval = this.options.refreshIntervalMs ?? 3600000;
      const jitter = 0.95 + (this.options.random?.() ?? Math.random()) * 0.1;
      state.nextRetryAt = new Date(this.now() + interval * jitter).toISOString();
      this.saveState(collection, state);
    } catch (error) {
      if (this.stopped) return;
      const safe = error instanceof ServiceError ? error : new ServiceError('storage');
      state = this.state(collection);
      state.errorCode = safe.code;
      state.failures += 1;
      state.authSuspended = safe.code === 'authentication';
      const retries = [60000, 300000, 900000, 3600000];
      const retry = Math.max(
        retries[Math.min(state.failures - 1, retries.length - 1)]!,
        safe.retryAfterMs,
      );
      state.nextRetryAt = state.authSuspended ? null : new Date(this.now() + retry).toISOString();
      this.saveState(collection, state);
      if (safe.code === 'authentication' || safe.code === 'rate-limited') {
        for (const other of collections.filter((value) => value !== collection)) {
          const sibling = this.state(other);
          this.saveState(other, {
            ...sibling,
            errorCode: safe.code,
            authSuspended: state.authSuspended,
            nextRetryAt: state.nextRetryAt,
          });
        }
      }
    }
  }

  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.adapter.close();
    await this.activeJob;
    this.cache.close();
  }
}
