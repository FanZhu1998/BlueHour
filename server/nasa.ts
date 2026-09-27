import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { Collection, Observation, Provider, ServiceError } from './model.js';

const MAX_METADATA = 4 * 1024 * 1024;
const MAX_IMAGE = 32 * 1024 * 1024;
const GEOMETRY_KEYS: Record<string, string[]> = {
  centroid_coordinates: ['lat', 'lon'],
  dscovr_j2000_position: ['x', 'y', 'z'],
  lunar_j2000_position: ['x', 'y', 'z'],
  sun_j2000_position: ['x', 'y', 'z'],
  attitude_quaternions: ['q0', 'q1', 'q2', 'q3'],
};

function serverDelay(headers: Headers, now: number): number {
  const retry = headers.get('retry-after')?.trim();
  const numeric = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : NaN;
  const date = retry && !/^\d+$/.test(retry) ? Date.parse(retry) : NaN;
  const resetHeader = headers.get('x-ratelimit-reset');
  const reset = resetHeader && /^\d+$/.test(resetHeader) ? Number(resetHeader) * 1000 : NaN;
  return Math.max(
    0,
    ...[numeric, date - now, reset - now].filter(
      (value) => Number.isFinite(value) && value <= 8.64e15 - now,
    ),
  );
}

export function parseObservationDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))
    return null;
  const normalized = `${value.replace(' ', 'T')}Z`;
  const stamp = Date.parse(normalized);
  if (!Number.isFinite(stamp)) return null;
  const iso = new Date(stamp).toISOString();
  return iso.slice(0, 19) === normalized.slice(0, 19) ? iso : null;
}

export function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    parseObservationDate(`${value} 00:00:00`) !== null
  );
}

export function frameIdentity(frame: Observation): string {
  return createHash('sha256')
    .update(JSON.stringify([frame.collection, frame.sourceImage, frame.version]))
    .digest('hex');
}

export function parseMetadata(value: unknown, collection: Collection): Observation[] {
  if (!Array.isArray(value) || value.length > 10000) throw new ServiceError('invalid-metadata');
  const records = new Map<string, Observation>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const observedAt = parseObservationDate(item.date);
    if (!observedAt || typeof item.image !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(item.image))
      continue;
    const sourceIdentifier =
      typeof item.identifier === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(item.identifier)
        ? item.identifier
        : item.image;
    const version =
      typeof item.version === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(item.version)
        ? item.version
        : null;
    const parts = observedAt.slice(0, 10).split('-');
    const provenance = `https://epic.gsfc.nasa.gov/archive/${collection}/${parts.join('/')}/png/${item.image}.png`;
    const geometry: Record<string, Record<string, number>> = {};
    for (const [field, keys] of Object.entries(GEOMETRY_KEYS)) {
      if (!item[field] || typeof item[field] !== 'object') continue;
      const values: Record<string, number> = {};
      for (const key of keys) {
        const number = item[field][key];
        if (typeof number === 'number' && Number.isFinite(number)) values[key] = number;
      }
      if (Object.keys(values).length === keys.length) geometry[field] = values;
    }
    const frame: Observation = {
      collection,
      sourceIdentifier,
      sourceImage: item.image,
      version,
      sourceDate: item.date,
      observedAt,
      provenance,
      ...(Object.keys(geometry).length ? { geometry } : {}),
    };
    const id = frameIdentity(frame);
    const existing = records.get(id);
    if (!existing || frame.observedAt > existing.observedAt) records.set(id, frame);
  }
  if (value.length && records.size === 0) throw new ServiceError('invalid-metadata');
  return [...records.values()].sort(
    (a, b) =>
      a.observedAt.localeCompare(b.observedAt) || a.sourceImage.localeCompare(b.sourceImage),
  );
}

export function verifyPng(data: Buffer): { width: number; height: number } {
  try {
    if (
      data.length < 33 ||
      !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error();
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (
      width < 64 ||
      height < 64 ||
      width > 4096 ||
      height > 4096 ||
      width / height < 0.5 ||
      width / height > 2
    )
      throw new Error();
    const decoded = PNG.sync.read(data, { checkCRC: true });
    if (
      decoded.width !== width ||
      decoded.height !== height ||
      decoded.data.length !== width * height * 4
    )
      throw new Error();
    return { width, height };
  } catch {
    throw new ServiceError('invalid-image');
  }
}

export interface NasaOptions {
  apiKey?: string;
  provider?: Provider;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  metadataTimeoutMs?: number;
  imageTimeoutMs?: number;
}

export class NasaAdapter {
  readonly provider: Provider;
  private readonly request: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly controllers = new Set<AbortController>();
  private metadataNotBefore = 0;
  constructor(private readonly options: NasaOptions) {
    this.provider = options.provider ?? (options.apiKey ? 'nasa' : 'public');
    this.request = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private async bytes(url: URL, kind: 'metadata' | 'image'): Promise<Buffer> {
    const authenticatedMetadata = url.host === 'api.nasa.gov';
    if (authenticatedMetadata && this.metadataNotBefore > this.now()) {
      throw new ServiceError('rate-limited', this.metadataNotBefore - this.now());
    }
    const limit = kind === 'metadata' ? MAX_METADATA : MAX_IMAGE;
    const controller = new AbortController();
    this.controllers.add(controller);
    let response: Response | undefined;
    const timer = setTimeout(
      () => controller.abort(),
      kind === 'metadata'
        ? (this.options.metadataTimeoutMs ?? 15000)
        : (this.options.imageTimeoutMs ?? 60000),
    );
    timer.unref();
    try {
      response = await this.request(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: kind === 'image' ? 'image/png' : 'application/json' },
      });
      if (response.status === 401 || response.status === 403)
        throw new ServiceError('authentication');
      if (response.status === 429) {
        const delay = Math.max(serverDelay(response.headers, this.now()), 60000);
        if (authenticatedMetadata) this.metadataNotBefore = this.now() + delay;
        throw new ServiceError('rate-limited', delay);
      }
      if (!response.ok)
        throw new ServiceError('upstream', serverDelay(response.headers, this.now()));
      if (authenticatedMetadata && response.headers.get('x-ratelimit-remaining') === '0') {
        this.metadataNotBefore =
          this.now() + (serverDelay(response.headers, this.now()) || 3600000);
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (kind === 'metadata' ? type !== 'application/json' : type !== 'image/png')
        throw new ServiceError(kind === 'metadata' ? 'invalid-metadata' : 'invalid-image');
      const lengthHeader = response.headers.get('content-length');
      const declared = lengthHeader === null ? null : Number(lengthHeader);
      if (
        (lengthHeader !== null &&
          (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(declared) || declared! > limit)) ||
        !response.body
      ) {
        throw new ServiceError(kind === 'metadata' ? 'invalid-metadata' : 'invalid-image');
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > limit) {
            controller.abort();
            throw new ServiceError(kind === 'metadata' ? 'invalid-metadata' : 'invalid-image');
          }
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        reader.releaseLock();
      }
      const encoding = response.headers.get('content-encoding');
      if ((!encoding || encoding === 'identity') && declared !== null && length !== declared)
        throw new ServiceError(kind === 'metadata' ? 'invalid-metadata' : 'invalid-image');
      return Buffer.concat(chunks, length);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('network');
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      if (response?.body && !response.body.locked) {
        try {
          await response.body.cancel();
        } catch {
          /* Discard transport details. */
        }
      }
    }
  }

  private async metadata(collection: Collection, suffix = ''): Promise<unknown> {
    if (this.provider === 'nasa' && !this.options.apiKey) throw new ServiceError('authentication');
    const url =
      this.provider === 'nasa'
        ? new URL(`https://api.nasa.gov/EPIC/api/${collection}${suffix}`)
        : new URL(`https://epic.gsfc.nasa.gov/api/${collection}${suffix}`);
    if (this.provider === 'nasa') url.searchParams.set('api_key', this.options.apiKey!);
    const bytes = await this.bytes(url, 'metadata');
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ServiceError('invalid-metadata');
    }
  }

  async observations(collection: Collection, date?: string): Promise<Observation[]> {
    if (date && !validDate(date)) throw new ServiceError('invalid-metadata');
    return parseMetadata(await this.metadata(collection, date ? `/date/${date}` : ''), collection);
  }

  async dates(collection: Collection): Promise<string[]> {
    const value = await this.metadata(collection, '/all');
    if (!Array.isArray(value)) throw new ServiceError('invalid-metadata');
    return [
      ...new Set(
        value.map((item) => (typeof item === 'string' ? item : item?.date)).filter(validDate),
      ),
    ]
      .sort()
      .reverse();
  }

  async image(
    observation: Observation,
  ): Promise<{ bytes: Buffer; width: number; height: number; checksum: string }> {
    const url = new URL(observation.provenance);
    // Provenance is constructed from allowlisted records, never browser input.
    if (url.protocol !== 'https:' || url.host !== 'epic.gsfc.nasa.gov' || url.search)
      throw new ServiceError('invalid-image');
    const bytes = await this.bytes(url, 'image');
    return {
      bytes,
      ...verifyPng(bytes),
      checksum: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  close() {
    for (const controller of this.controllers) controller.abort();
  }
}
