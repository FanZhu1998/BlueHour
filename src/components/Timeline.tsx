import { useEffect, useRef } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { Observatory } from '../hooks/useObservatory';
import { formatDay, formatTime, utcDate } from '../lib/format';
import { IconButton } from './IconButton';

export function Timeline({ observatory: o }: { observatory: Observatory }) {
  const active = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    active.current?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  }, [o.frame?.id]);
  return (
    <section className="timeline" aria-label="Recorded Earth observations">
      <div className="timeline-heading">
        <div className="sequence-title">
          <span className="eyebrow">
            {o.mode === 'daily' ? 'AVAILABLE OBSERVATIONS' : 'YOUR WINDOW ON EARTH'}
          </span>
          <span className="timeline-date">
            {o.mode === 'daily' && o.selectedDay
              ? formatDay(`${o.selectedDay}T12:00:00Z`)
              : 'A day, from a different perspective.'}
          </span>
        </div>
        <span className="sequence-count">
          <span className="small-line" />
          {o.sequence.length} {o.sequence.length === 1 ? 'observation' : 'observations'}
          <span className="sequence-qualifier">
            {' '}
            · {o.playing ? 'recorded sequence' : 'saved locally'}
          </span>
        </span>
      </div>
      <div className="filmstrip" role="group" aria-label="Select an observation">
        {o.sequence.length ? (
          o.sequence.map((item, index) => (
            <button
              type="button"
              className={`frame-tile ${item.id === o.frame?.id ? 'selected' : ''}`}
              key={item.id}
              ref={item.id === o.frame?.id ? active : undefined}
              aria-pressed={item.id === o.frame?.id}
              onClick={() => void o.selectFrame(item)}
              title={`${formatDay(item.observedAt)} · ${formatTime(item.observedAt, true)} UTC`}
              aria-label={`Observation ${index + 1}, ${formatDay(item.observedAt)} at ${formatTime(item.observedAt)} UTC`}
            >
              <span className="frame-thumb">
                <img
                  src={item.imageUrl.replace('/images/', '/thumbnails/')}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable="false"
                />
              </span>
              <span className="frame-time">{formatTime(item.observedAt)}</span>
              {index > 0 &&
                utcDate(item.observedAt) !== utcDate(o.sequence[index - 1].observedAt) && (
                  <span
                    className="day-boundary"
                    title={`New UTC day: ${formatDay(item.observedAt)}`}
                  />
                )}
            </button>
          ))
        ) : (
          <div className="empty-filmstrip">
            <span />
            The timeline fills as verified images arrive.
            <span />
          </div>
        )}
      </div>
      <div className="playback-bar">
        <div className="playback-controls">
          <IconButton
            label="Previous observation (left arrow)"
            onClick={() => o.step(-1)}
            disabled={!o.sequence.length || o.index <= 0}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <IconButton
            label={
              o.playing
                ? 'Pause recorded sequence (space)'
                : o.sequence.length < 2
                  ? 'Playback needs at least two observations'
                  : 'Play recorded sequence (space)'
            }
            className="play-button"
            onClick={o.togglePlayback}
            disabled={o.sequence.length < 2}
          >
            {o.playing ? (
              <Pause size={16} fill="currentColor" />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
          </IconButton>
          <IconButton
            label="Next observation (right arrow)"
            onClick={() => o.step(1)}
            disabled={!o.sequence.length || o.index >= o.sequence.length - 1}
          >
            <ChevronRight size={18} />
          </IconButton>
          <span className="playback-position">
            {o.index >= 0 ? String(o.index + 1).padStart(2, '0') : '—'}{' '}
            <span>/ {String(o.sequence.length).padStart(2, '0')}</span>
          </span>
        </div>
        <div className="timeline-options">
          <label className="select-wrap">
            <span className="sr-only">Sequence</span>
            <select
              aria-label="Sequence"
              value={o.mode}
              onChange={(event) => o.changeMode(event.target.value as 'recent' | 'daily')}
            >
              <option value="recent">Recent observations</option>
              <option value="daily">Daily time-lapse</option>
            </select>
          </label>
          {o.mode === 'daily' && (
            <label className="select-wrap date-select">
              <span className="sr-only">UTC observation date</span>
              <select
                aria-label="UTC observation date"
                value={o.selectedDay}
                onChange={(event) => o.changeDay(event.target.value)}
              >
                {o.days.map((day) => (
                  <option key={day} value={day}>
                    {formatDay(`${day}T12:00:00Z`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="collection-control" role="group" aria-label="Image processing">
            <button
              aria-pressed={o.collection === 'natural'}
              onClick={() => void o.switchCollection('natural')}
            >
              Natural
            </button>
            <button
              aria-pressed={o.collection === 'enhanced'}
              onClick={() => void o.switchCollection('enhanced')}
            >
              Enhanced
            </button>
          </div>
        </div>
        <button
          className={`latest-button ${o.latestActive ? 'active' : ''}`}
          onClick={() => void o.goLatest()}
          disabled={!o.latest}
        >
          Latest <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="sequence-note" aria-live="polite">
        <span>
          {o.playing
            ? 'Recorded sequence · fixed playback interval'
            : o.sequence.length === 1
              ? 'One observation available · playback needs two'
              : 'Every frame is a real observation.'}
        </span>
        <span>{o.gap || 'Times shown in UTC'}</span>
      </div>
    </section>
  );
}
