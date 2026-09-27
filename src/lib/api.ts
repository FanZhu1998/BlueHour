import type { Collection, FrameManifest, ServiceStatus } from '../../shared/contracts';

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  if (!response.ok) throw new Error('The local imagery service is unavailable.');
  return response.json() as Promise<T>;
}

export const api = {
  status: () => readJson<ServiceStatus>('/api/status'),
  frames: (collection: Collection) => readJson<FrameManifest>(`/api/frames?collection=${collection}`),
  refresh: (collection: Collection) => readJson<unknown>('/api/refresh', { method: 'POST', body: JSON.stringify({ collection }) }),
  pin: (ids: string[]) => readJson<unknown>('/api/pin', { method: 'POST', body: JSON.stringify({ ids: ids.slice(0, 50) }) }),
};
