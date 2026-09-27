import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type { Observatory } from '../hooks/useObservatory';
import { ageLabel, formatDay, formatTime } from '../lib/format';

export function ObservationDetails({
  observatory: o,
  onInfo,
}: {
  observatory: Observatory;
  onInfo: () => void;
}) {
  const frame = o.frame;
  const status = o.status?.collections[o.collection];
  return (
    <aside className="observation-details" aria-label="Observation details">
      <p className="eyebrow">THE OBSERVATION</p>
      <div className="observation-time">
        {frame ? formatTime(frame.observedAt) : '—:—'}
        <span>UTC</span>
      </div>
      <p className="observation-day">
        {frame ? formatDay(frame.observedAt) : 'Awaiting first image'}
      </p>
      <dl className="observation-facts">
        <div>
          <dt>Instrument</dt>
          <dd>EPIC</dd>
        </div>
        <div>
          <dt>Spacecraft</dt>
          <dd>DSCOVR</dd>
        </div>
        <div>
          <dt>Collection</dt>
          <dd>{o.collection === 'natural' ? 'Natural color' : 'Enhanced color'}</dd>
        </div>
        <div>
          <dt>Resolution</dt>
          <dd>
            {frame ? `${frame.width.toLocaleString()} × ${frame.height.toLocaleString()}` : '—'}
          </dd>
        </div>
      </dl>
      <p className="observation-explanation">
        {o.collection === 'natural'
          ? 'Sunlight, oceans, and the atmosphere. Our home, photographed from space.'
          : 'A separately processed EPIC image that brings land features into focus.'}
      </p>
      <button className="text-link" onClick={onInfo}>
        About this observation <ArrowUpRight size={14} />
      </button>
      <div className="check-status">
        <button
          className="check-button"
          onClick={() => void o.refresh()}
          disabled={status?.refreshing}
          title={
            status?.nextRetryAt
              ? `Next retry ${formatTime(status.nextRetryAt)} UTC`
              : 'Check for new observations'
          }
        >
          <RefreshCw size={12} className={status?.refreshing ? 'spinning' : ''} />
          {status?.refreshing
            ? 'Checking observations'
            : o.connectionLost
              ? 'Reconnect'
              : 'Check for updates'}
        </button>
        <span>
          {status?.lastSuccessfulCheck
            ? `Checked ${ageLabel(status.lastSuccessfulCheck).toLowerCase()}`
            : 'Waiting for a successful check'}
        </span>
      </div>
    </aside>
  );
}
