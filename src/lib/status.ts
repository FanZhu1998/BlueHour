import type { Observatory } from '../hooks/useObservatory';
import type { ErrorCode } from '../../shared/contracts';
import { ageLabel } from './format';

export const errorDescriptions: Record<Exclude<ErrorCode, null>, string> = {
  network: 'The imagery source could not be reached. Saved observations remain available.',
  'rate-limit': 'The source asked us to wait. Blue Hour will retry after the requested delay.',
  authentication: 'Setup needed. The configured NASA key was not accepted. Import an updated private configuration in Preferences.',
  'invalid-data': 'The source returned an observation that could not be verified. Your saved images are safe.',
  'image-unavailable': 'A newer observation could not be downloaded and verified. The last good image is still available.',
  storage: 'The local image cache could not be updated. Check that the application has available disk space.',
  empty: 'The source returned no usable observations. Existing saved images are being retained.',
};

export function freshness(o: Observatory): { label: string; warning: boolean } {
  const status = o.status?.collections[o.collection];
  if (o.connectionLost) return { label: o.frame ? 'Showing saved image · service disconnected' : 'Connecting to local service', warning: true };
  if (status?.errorCode === 'authentication') return { label: o.frame ? 'Showing saved image · setup needed' : 'Setup needed', warning: true };
  if (status?.errorCode) return { label: o.frame ? 'Showing saved image' : status.refreshing ? 'Retrieving observations' : 'Waiting for Earth imagery', warning: true };
  if (o.latestActive && o.frame && ((status?.newestKnownObservedAt && status.newestKnownObservedAt > o.frame.observedAt) || (o.latest && o.latest.observedAt > o.frame.observedAt))) return { label: status?.refreshing || o.buffering ? 'Showing saved image · updating' : 'Showing saved image', warning: true };
  const lastCheckAge = status?.lastSuccessfulCheck ? Date.now() - new Date(status.lastSuccessfulCheck).getTime() : null;
  if (lastCheckAge !== null && (lastCheckAge < -300_000 || Math.abs(Date.now() - new Date(o.status!.serverTime).getTime()) > 600_000)) return { label: 'Age unavailable · check device clock', warning: true };
  if (lastCheckAge !== null && lastCheckAge > 3 * 3_600_000) return { label: 'Update check overdue', warning: true };
  const newestTime = status?.newestKnownObservedAt || o.latest?.observedAt;
  if (newestTime && new Date(newestTime).getTime() - Date.now() > 300_000) return { label: 'Age unavailable · check device clock', warning: true };
  if (newestTime && Date.now() - new Date(newestTime).getTime() > 48 * 3_600_000) return { label: `Older observation · ${ageLabel(newestTime)}`, warning: true };
  if (o.frame && !o.latestActive) return { label: o.playing ? 'Recorded sequence' : 'Historical observation', warning: false };
  if (status?.refreshing && !o.frame) return { label: 'Retrieving observations', warning: false };
  return { label: o.frame ? 'Latest available observation' : 'Waiting for Earth imagery', warning: false };
}
