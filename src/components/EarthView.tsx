import { ArrowUpRight, LoaderCircle, Satellite } from 'lucide-react';
import type { Frame } from '../../shared/contracts';
import { formatDay, formatTime } from '../lib/format';

export function EarthView({
  frame,
  buffering,
  loading,
  onFocus,
}: {
  frame: Frame | null;
  buffering: boolean;
  loading: boolean;
  onFocus?: () => void;
}) {
  if (!frame)
    return (
      <div className="earth-empty">
        <div className="empty-symbol">
          <Satellite size={30} strokeWidth={1} />
        </div>
        <h2>Waiting for Earth imagery</h2>
        <p>
          {loading
            ? 'Connecting to your local observatory…'
            : 'The first verified observation will appear here.'}
        </p>
        <div className="empty-note">
          <span className="status-dot pending" />
          {loading || buffering ? 'Preparing your view' : 'Real observations. Worth the wait.'}
        </div>
      </div>
    );
  return (
    <figure className="earth-figure">
      {onFocus ? (
        <button
          className="earth-image-button"
          onClick={onFocus}
          title="Open desk view"
          aria-label={`Open desk view. Earth observed ${formatDay(frame.observedAt)} at ${formatTime(frame.observedAt)} UTC`}
        >
          <img
            className="earth-image"
            src={frame.imageUrl}
            alt={`Earth photographed by NASA EPIC on ${formatDay(frame.observedAt)} at ${formatTime(frame.observedAt)} UTC`}
            draggable="false"
          />
          <span className="focus-hint">
            Enter desk view <ArrowUpRight size={13} />
          </span>
        </button>
      ) : (
        <img
          className="earth-image"
          src={frame.imageUrl}
          alt={`Earth photographed by NASA EPIC on ${formatDay(frame.observedAt)} at ${formatTime(frame.observedAt)} UTC`}
          draggable="false"
        />
      )}
      {buffering && (
        <span className="buffering-indicator" role="status">
          <LoaderCircle size={12} className="spinning" /> Preparing observation
        </span>
      )}
    </figure>
  );
}
