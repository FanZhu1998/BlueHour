export type Collection = 'natural' | 'enhanced';
export type Provider = 'nasa' | 'public';
export type ErrorCode =
  | 'network'
  | 'rate-limited'
  | 'authentication'
  | 'upstream'
  | 'invalid-metadata'
  | 'invalid-image'
  | 'empty'
  | 'cache-full'
  | 'storage';

export class ServiceError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryAfterMs = 0,
  ) {
    super(code);
    this.name = 'ServiceError';
  }
}

export interface Observation {
  collection: Collection;
  sourceIdentifier: string;
  sourceImage: string;
  version: string | null;
  sourceDate: string;
  observedAt: string;
  provenance: string;
  geometry?: Record<string, Record<string, number>>;
}

export interface CachedFrame extends Observation {
  id: string;
  retrievedAt: string;
  width: number;
  height: number;
  checksum: string;
  bytes: number;
  decodeStatus: 'verified';
}

export interface PublicFrame {
  id: string;
  collection: Collection;
  observedAt: string;
  sourceDate: string;
  imageUrl: string;
  retrievedAt: string;
  sourceIdentifier: string;
  sourceImage: string;
  version: string | null;
  width: number;
  height: number;
  provenance: string;
  centroid?: { lat: number; lon: number };
}

export interface CollectionState {
  lastAttemptAt: string | null;
  lastSuccessfulCheck: string | null;
  newestKnownObservedAt: string | null;
  nextRetryAt: string | null;
  errorCode: ErrorCode | null;
  failures: number;
  authSuspended: boolean;
}

export const collections: Collection[] = ['natural', 'enhanced'];
export const isCollection = (value: unknown): value is Collection =>
  value === 'natural' || value === 'enhanced';
export const initialState = (): CollectionState => ({
  lastAttemptAt: null,
  lastSuccessfulCheck: null,
  newestKnownObservedAt: null,
  nextRetryAt: null,
  errorCode: null,
  failures: 0,
  authSuspended: false,
});

export function publicFrame(frame: CachedFrame): PublicFrame {
  return {
    id: frame.id,
    collection: frame.collection,
    observedAt: frame.observedAt,
    sourceDate: frame.sourceDate,
    imageUrl: `/images/${frame.id}`,
    retrievedAt: frame.retrievedAt,
    sourceIdentifier: frame.sourceIdentifier,
    sourceImage: frame.sourceImage,
    version: frame.version,
    width: frame.width,
    height: frame.height,
    provenance: frame.provenance,
    ...(frame.geometry?.centroid_coordinates
      ? {
          centroid: {
            lat: frame.geometry.centroid_coordinates.lat!,
            lon: frame.geometry.centroid_coordinates.lon!,
          },
        }
      : {}),
  };
}
