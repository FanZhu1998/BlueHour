export type Collection = 'natural' | 'enhanced';
export type Provider = 'nasa' | 'public';
export type ErrorCode =
  | 'network'
  | 'rate-limit'
  | 'authentication'
  | 'invalid-data'
  | 'image-unavailable'
  | 'storage'
  | 'empty'
  | null;

export interface Frame {
  id: string;
  collection: Collection;
  observedAt: string;
  sourceDate: string;
  imageUrl: string;
  retrievedAt: string;
  sourceImage: string;
  sourceIdentifier: string;
  version: string | null;
  width: number;
  height: number;
  provenance: string;
  centroid?: { lat: number; lon: number };
}

export interface CollectionStatus {
  refreshing: boolean;
  lastSuccessfulCheck: string | null;
  lastAttempt: string | null;
  nextRetryAt: string | null;
  errorCode: ErrorCode;
  latestId: string | null;
  newestKnownObservedAt: string | null;
  frameCount: number;
}

export interface ServiceStatus {
  provider: Provider;
  configured: boolean;
  collections: Record<Collection, CollectionStatus>;
  cacheBytes: number;
  cacheLimitBytes: number;
  serverTime: string;
}

export interface FrameManifest {
  collection: Collection;
  frames: Frame[];
  latestId: string | null;
  newestKnownObservedAt: string | null;
}

export interface DisplayPreferences {
  brightness: number;
  reducedMotion: boolean;
  interval: number;
  panelSize: '3.4' | '5';
}

export interface DesktopPreferences {
  autoStart: boolean;
  hasApiKey: boolean;
  provider: Provider;
  desktop: true;
  display: DisplayPreferences | null;
}

export interface DesktopBridge {
  getPreferences(): Promise<DesktopPreferences>;
  updatePreferences(patch: {
    autoStart?: boolean;
    provider?: Provider;
    display?: DisplayPreferences;
  }): Promise<DesktopPreferences>;
  importKey(): Promise<{ imported: boolean; hasApiKey: boolean }>;
  saveKey(value: string): Promise<{ saved: boolean; hasApiKey: boolean }>;
}
