import { ExternalLink } from 'lucide-react';
import type { Observatory } from '../hooks/useObservatory';
import { ageLabel, formatDay, formatTime } from '../lib/format';
import { errorDescriptions, freshness } from '../lib/status';
import { Sheet } from './Sheet';

export function InformationSheet({
  observatory: o,
  onClose,
}: {
  observatory: Observatory;
  onClose: () => void;
}) {
  const frame = o.frame;
  const status = o.status?.collections[o.collection];
  const state = freshness(o);
  return (
    <Sheet title="A real view of our world." eyebrow="ABOUT THIS OBSERVATION" onClose={onClose}>
      <p className="sheet-intro">
        Blue Hour brings NASA’s Earth Polychromatic Imaging Camera to your desk. Each frame is a
        photograph captured by EPIC aboard NOAA’s DSCOVR spacecraft.
      </p>
      <div className={`information-status ${state.warning ? 'warning' : ''}`}>
        <span className={`status-dot ${state.warning ? 'pending' : ''}`} />
        <span>{state.label}</span>
      </div>
      {status?.errorCode && (
        <p className="status-explanation">{errorDescriptions[status.errorCode]}</p>
      )}
      <dl className="information-facts">
        <div>
          <dt>Observed</dt>
          <dd>
            {frame
              ? `${formatDay(frame.observedAt)} · ${formatTime(frame.observedAt, true)} UTC`
              : 'Awaiting imagery'}
          </dd>
        </div>
        <div>
          <dt>Observation age</dt>
          <dd>{frame ? ageLabel(frame.observedAt) : '—'}</dd>
        </div>
        <div>
          <dt>Last successful check</dt>
          <dd>
            {status?.lastSuccessfulCheck
              ? `${formatDay(status.lastSuccessfulCheck)} · ${formatTime(status.lastSuccessfulCheck)} UTC`
              : 'Not yet checked'}
          </dd>
        </div>
        <div>
          <dt>Saved on this device</dt>
          <dd>
            {frame ? `${formatDay(frame.retrievedAt)} · ${formatTime(frame.retrievedAt)} UTC` : '—'}
          </dd>
        </div>
        <div>
          <dt>Metadata source</dt>
          <dd>
            {o.status?.provider === 'nasa' ? 'NASA API · authenticated' : 'Public NASA EPIC API'}
          </dd>
        </div>
        <div>
          <dt>Image collection</dt>
          <dd>{o.collection === 'natural' ? 'Natural color' : 'Enhanced color'}</dd>
        </div>
        {frame?.version && (
          <div>
            <dt>Processing version</dt>
            <dd>{frame.version}</dd>
          </div>
        )}
        {frame?.centroid && (
          <div>
            <dt>Image-center coordinates</dt>
            <dd>
              {frame.centroid.lat.toFixed(2)}° latitude · {frame.centroid.lon.toFixed(2)}° longitude
            </dd>
          </div>
        )}
        {status?.nextRetryAt && (
          <div>
            <dt>Next scheduled retry</dt>
            <dd>
              {formatDay(status.nextRetryAt)} · {formatTime(status.nextRetryAt)} UTC
            </dd>
          </div>
        )}
        <div>
          <dt>Local image cache</dt>
          <dd>
            {o.status
              ? `${(o.status.cacheBytes / 1_048_576).toFixed(1)} MB / ${Math.round(o.status.cacheLimitBytes / 1_048_576)} MB`
              : '—'}
          </dd>
        </div>
      </dl>
      <div className="information-note">
        <h3>Observed, never simulated.</h3>
        <p>
          EPIC provides the latest available observations, not a live video feed. Playback moves
          through verified photographs at a fixed interval. Actual time gaps remain visible; no
          intermediate images are generated.
        </p>
        <p>
          {o.collection === 'enhanced'
            ? 'Enhanced imagery is a separately processed NASA product. Its land emphasis and darker limb are preserved exactly.'
            : 'The complete source image, its original orientation, and its natural appearance are preserved.'}
        </p>
      </div>
      {frame && (
        <div className="source-reference">
          <span className="eyebrow">SOURCE IMAGE</span>
          <code>{frame.sourceImage}</code>
          <a href={frame.provenance} target="_blank" rel="noreferrer">
            NASA source record <ExternalLink size={13} />
          </a>
        </div>
      )}
      <div className="credit-block">
        <strong>Imagery: NASA EPIC Team / NOAA DSCOVR</strong>
        <span>Our planet. A shared perspective.</span>
        <a href="https://epic.gsfc.nasa.gov/about" target="_blank" rel="noreferrer">
          About EPIC & image credits <ExternalLink size={12} />
        </a>
      </div>
    </Sheet>
  );
}
