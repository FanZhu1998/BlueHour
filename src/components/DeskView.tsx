import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pause,
  Play,
  Settings2,
  X,
} from 'lucide-react';
import type { Observatory } from '../hooks/useObservatory';
import type { Preferences } from '../hooks/usePreferences';
import { formatDay, formatTime } from '../lib/format';
import { freshness } from '../lib/status';
import { IconButton } from './IconButton';
import { EarthView } from './EarthView';

export function DeskView({
  observatory: o,
  preferences,
  onExit,
  onInfo,
  onPreferences,
  panelOpen,
}: {
  observatory: Observatory;
  preferences: Preferences;
  onExit: () => void;
  onInfo: () => void;
  onPreferences: () => void;
  panelOpen: boolean;
}) {
  const [visible, setVisible] = useState(true);
  const [modeOpen, setModeOpen] = useState(false);
  const timeout = useRef<number | undefined>(undefined);
  const state = freshness(o);
  function reveal() {
    setVisible(true);
    window.clearTimeout(timeout.current);
    if (!modeOpen && !panelOpen) timeout.current = window.setTimeout(() => setVisible(false), 8000);
  }
  useEffect(() => {
    reveal();
    return () => window.clearTimeout(timeout.current);
  }, [modeOpen, panelOpen]);
  const showControls = visible || modeOpen || panelOpen;
  return (
    <main className="desk-view" onPointerMove={reveal} onKeyDown={reveal}>
      <div className={`desk-surround interface ${showControls ? '' : 'controls-hidden'}`}>
        <button className="text-link" onClick={onExit}>
          <ArrowLeft size={15} /> Back to observatory
        </button>
        <span className="eyebrow">DESK VIEW · {preferences.panelSize}″ LAYOUT</span>
        <IconButton label="Open display preferences" onClick={onPreferences}>
          <Settings2 size={18} />
        </IconButton>
      </div>
      <div className={`desk-circle panel-${preferences.panelSize === '3.4' ? 'small' : 'large'}`}>
        <div
          className="desk-image-area"
          onClick={() => {
            if (visible) {
              window.clearTimeout(timeout.current);
              setVisible(false);
              setModeOpen(false);
            } else reveal();
          }}
          role="button"
          tabIndex={0}
          aria-label={showControls ? 'Hide desk controls' : 'Show desk controls'}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              setVisible((value) => !value);
            }
          }}
        >
          <EarthView frame={o.frame} buffering={o.buffering} loading={o.loading} />
        </div>
        <div className={`desk-identity interface ${showControls ? '' : 'controls-hidden'}`}>
          <span className="brand-mini">blue hour.</span>
        </div>
        <div className="desk-caption interface" aria-live={o.playing ? 'off' : 'polite'}>
          <span className="desk-caption-label">
            OBSERVED ·{' '}
            {o.latestActive ? 'LATEST AVAILABLE' : o.playing ? 'RECORDED SEQUENCE' : 'HISTORICAL'}
          </span>
          <strong>{o.frame ? formatDay(o.frame.observedAt) : 'Waiting for imagery'}</strong>
          <span>
            {o.frame
              ? `${formatTime(o.frame.observedAt, true)} UTC`
              : 'Earth will appear when ready.'}
          </span>
        </div>
        {state.warning && (
          <div className="desk-freshness interface">
            <span className="status-dot pending" />
            {state.label}
          </div>
        )}
        <div
          className={`desk-controls interface ${showControls ? '' : 'controls-hidden'}`}
          inert={!showControls || modeOpen}
        >
          <IconButton
            label="Previous observation"
            onClick={() => o.step(-1)}
            disabled={o.index <= 0}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label={o.playing ? 'Pause recorded sequence' : 'Play recorded sequence'}
            className="play-button"
            onClick={o.togglePlayback}
            disabled={o.sequence.length < 2}
          >
            {o.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
          </IconButton>
          <IconButton
            label="Next observation"
            onClick={() => o.step(1)}
            disabled={o.index >= o.sequence.length - 1}
          >
            <ChevronRight />
          </IconButton>
          <IconButton
            label="Desk view modes and information"
            aria-expanded={modeOpen}
            onClick={() => setModeOpen((value) => !value)}
          >
            <MoreHorizontal />
          </IconButton>
        </div>
        <IconButton
          label={
            o.playing
              ? 'Pause recorded sequence and reveal controls'
              : 'Play recorded sequence and reveal controls'
          }
          className={`desk-rest-play interface ${showControls ? 'controls-hidden' : ''}`}
          inert={showControls}
          onClick={() => {
            reveal();
            o.togglePlayback();
          }}
          disabled={o.sequence.length < 2}
        >
          {o.playing ? <Pause /> : <Play />}
        </IconButton>
        {modeOpen && (
          <div className="desk-mode-sheet interface">
            <div className="desk-mode-heading">
              <p className="eyebrow">YOUR VIEW</p>
              <IconButton label="Close desk modes" onClick={() => setModeOpen(false)} autoFocus>
                <X />
              </IconButton>
            </div>
            <div className="collection-control">
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
            <button
              onClick={() => {
                o.changeMode(o.mode === 'daily' ? 'recent' : 'daily');
                setModeOpen(false);
              }}
            >
              {o.mode === 'daily' ? 'Recent observations' : 'Daily time-lapse'}
            </button>
            <button
              onClick={() => {
                void o.goLatest();
                setModeOpen(false);
              }}
            >
              Return to latest
            </button>
            <button
              onClick={() => {
                setModeOpen(false);
                onInfo();
              }}
            >
              Observation information
            </button>
          </div>
        )}
      </div>
      <div className={`desk-bottom interface ${showControls ? '' : 'controls-hidden'}`}>
        <span>Tap Earth to reveal or hide controls.</span>
        <span>Imagery: NASA EPIC Team / NOAA DSCOVR</span>
      </div>
    </main>
  );
}
