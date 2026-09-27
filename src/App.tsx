import { useEffect, useState } from 'react';
import { ArrowUpRight, CircleHelp, Eclipse, Info, Settings2, X } from 'lucide-react';
import { useObservatory } from './hooks/useObservatory';
import { usePreferences } from './hooks/usePreferences';
import { IconButton } from './components/IconButton';
import { EarthView } from './components/EarthView';
import { Timeline } from './components/Timeline';
import { ObservationDetails } from './components/ObservationDetails';
import { DeskView } from './components/DeskView';
import { PreferencesSheet } from './components/PreferencesSheet';
import { InformationSheet } from './components/InformationSheet';
import { Sheet } from './components/Sheet';
import { formatDay, formatTime } from './lib/format';
import { freshness } from './lib/status';

export default function App() {
  const { preferences, update, persistenceError } = usePreferences();
  const o = useObservatory(preferences.interval);
  const [view, setView] = useState<'observe' | 'desk'>('observe');
  const [sheet, setSheet] = useState<'preferences' | 'information' | null>(null);
  const state = freshness(o);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (sheet || o.pendingCollection || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, select, textarea, [contenteditable="true"]')) return;
      if (event.code === 'Space' && !target.closest('button, [role="button"]')) {
        event.preventDefault();
        o.togglePlayback();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        o.step(-1);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        o.step(1);
      }
      if (event.key === 'Escape') setView('observe');
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [o, sheet]);

  const pending = o.pendingCollection ? o.manifests[o.pendingCollection] : null;
  const pendingLatest =
    pending?.frames.find((frame) => frame.id === pending.latestId) || pending?.frames.at(-1);

  return (
    <div className="app-shell">
      {view === 'observe' ? (
        <>
          <header className="app-header interface">
            <a
              className="brand"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                void o.goLatest();
              }}
              aria-label="Blue Hour, return to latest observation"
            >
              <Eclipse size={25} strokeWidth={1.3} />
              <span>
                blue hour<span className="brand-dot">.</span>
              </span>
            </a>
            <nav className="main-navigation" aria-label="Main navigation">
              <button className="nav-active" aria-current="page" onClick={() => setView('observe')}>
                Observe
              </button>
              <button onClick={() => setView('desk')}>
                Desk view <ArrowUpRight size={12} />
              </button>
            </nav>
            <div className="header-actions">
              <span className="header-descriptor">A LITTLE PERSPECTIVE</span>
              <IconButton
                label="About Blue Hour and this observation"
                onClick={() => setSheet('information')}
              >
                <Info size={18} />
              </IconButton>
              <IconButton label="Open preferences" onClick={() => setSheet('preferences')}>
                <Settings2 size={18} />
              </IconButton>
            </div>
          </header>
          <main className="observatory">
            <section className="observation-layout" aria-label="Earth observatory">
              <div className="intro-column interface">
                <p className="eyebrow">
                  <span className="eyebrow-rule" />
                  EARTH, AS OBSERVED
                </p>
                <h1>
                  A little
                  <br />
                  perspective.
                </h1>
                <p className="intro-copy">
                  The world keeps turning.
                  <br />
                  Take a moment to watch.
                </p>
                <div className="intro-footnote">
                  <span className="tiny-cross">+</span>
                  <p>
                    One planet.
                    <br />
                    An entirely different point of view.
                  </p>
                </div>
              </div>
              <div className="earth-column">
                <EarthView
                  frame={o.frame}
                  buffering={o.buffering}
                  loading={o.loading}
                  onFocus={() => setView('desk')}
                />
                <div className="earth-caption interface">
                  <div className={`freshness-badge ${state.warning ? 'warning' : ''}`}>
                    <span className={`status-dot ${state.warning ? 'pending' : ''}`} />
                    {state.label}
                  </div>
                  <p aria-live={o.playing ? 'off' : 'polite'}>
                    {o.frame ? (
                      <>
                        <span>Observed</span>
                        <span className="caption-dot">·</span>
                        {formatDay(o.frame.observedAt)}
                        <span className="caption-dot">·</span>
                        <span className="mono">{formatTime(o.frame.observedAt, true)} UTC</span>
                      </>
                    ) : (
                      'Imagery arrives directly from NASA EPIC.'
                    )}
                  </p>
                </div>
              </div>
              <div className="details-column interface">
                <ObservationDetails observatory={o} onInfo={() => setSheet('information')} />
              </div>
            </section>
            <div className="interface">
              <Timeline observatory={o} />
            </div>
          </main>
          <footer className="app-footer interface">
            <span>
              <span className="footer-dot" />A quiet window to our home.
            </span>
            <span>Imagery: NASA EPIC Team / NOAA DSCOVR</span>
            <button
              onClick={() => setSheet('information')}
              aria-label="About the imagery and keyboard shortcuts"
            >
              <CircleHelp size={12} />
              <span>Space to play · ← → to explore</span>
            </button>
          </footer>
        </>
      ) : (
        <DeskView
          observatory={o}
          preferences={preferences}
          onExit={() => setView('observe')}
          onInfo={() => setSheet('information')}
          onPreferences={() => setSheet('preferences')}
          panelOpen={Boolean(sheet || o.pendingCollection)}
        />
      )}
      {o.notice && (
        <div className="notice interface" role="status">
          <Info size={16} />
          <span>{o.notice}</span>
          <IconButton label="Dismiss notification" onClick={() => o.setNotice(null)}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {sheet === 'preferences' && (
        <PreferencesSheet
          preferences={preferences}
          update={update}
          onClose={() => setSheet(null)}
          onServiceChange={() => void o.reload()}
          provider={o.status?.provider}
          persistenceError={persistenceError}
        />
      )}
      {sheet === 'information' && (
        <InformationSheet observatory={o} onClose={() => setSheet(null)} />
      )}
      {o.pendingCollection && !sheet && (
        <Sheet
          eyebrow="COLLECTION AVAILABILITY"
          title="A different moment in time."
          onClose={() => o.setPendingCollection(null)}
        >
          <p className="sheet-intro">
            {o.pendingCollection === 'natural' ? 'Natural' : 'Enhanced'} imagery is not yet saved
            for {o.frame ? formatDay(o.frame.observedAt) : 'this observation date'}. Your current
            observation stays in view.
          </p>
          {pendingLatest ? (
            <>
              <p className="availability-date">
                <span className="eyebrow">LATEST AVAILABLE IN THIS COLLECTION</span>
                <strong>
                  {formatDay(pendingLatest.observedAt)} · {formatTime(pendingLatest.observedAt)} UTC
                </strong>
              </p>
              <button className="primary-button" onClick={() => void o.acceptLatestCollection()}>
                View this observation <ArrowUpRight size={16} />
              </button>
            </>
          ) : (
            <p className="setting-description">
              {o.status?.collections[o.pendingCollection].refreshing
                ? 'Downloading and verifying the first observations in this collection…'
                : 'No verified images are available in this collection yet. Check its availability again later.'}
            </p>
          )}
          <button className="secondary-button" onClick={() => o.setPendingCollection(null)}>
            Keep current view
          </button>
        </Sheet>
      )}
    </div>
  );
}
