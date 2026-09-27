import { useEffect, useRef, useState } from 'react';
import type { DisplayPreferences } from '../../shared/contracts';

export type Preferences = DisplayPreferences;
const key = 'blue-hour-preferences-v1';

function readPreferences(): Preferences {
  const defaults: Preferences = {
    brightness: 85,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    interval: 1000,
    panelSize: '5',
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}') as Partial<Preferences>;
    return {
      brightness:
        typeof parsed.brightness === 'number'
          ? Math.max(35, Math.min(100, parsed.brightness))
          : defaults.brightness,
      reducedMotion:
        typeof parsed.reducedMotion === 'boolean' ? parsed.reducedMotion : defaults.reducedMotion,
      interval: [1000, 2000, 4000].includes(Number(parsed.interval))
        ? Number(parsed.interval)
        : defaults.interval,
      panelSize: parsed.panelSize === '3.4' ? '3.4' : '5',
    };
  } catch {
    return defaults;
  }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const current = useRef(preferences);
  const userChanged = useRef(false);
  const saves = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    if (window.blueHour) {
      void window.blueHour
        .getPreferences()
        .then((native) => {
          if (!active || userChanged.current || !native.display) return;
          current.current = native.display;
          setPreferences(native.display);
        })
        .catch(() => {
          if (active)
            setPersistenceError(
              'Your display settings apply to this session. Saved desktop preferences could not be loaded.',
            );
        });
    }
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--interface-opacity',
      String(preferences.brightness / 100),
    );
    document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion);
  }, [preferences]);
  function update<K extends keyof Preferences>(field: K, value: Preferences[K]) {
    userChanged.current = true;
    const next = { ...current.current, [field]: value };
    current.current = next;
    setPreferences(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Native persistence remains independent of browser storage. */
    }
    if (window.blueHour) {
      saves.current = saves.current.then(async () => {
        try {
          await window.blueHour!.updatePreferences({ display: next });
          setPersistenceError(null);
        } catch {
          setPersistenceError(
            'Your display settings apply to this session, but could not be saved for next time.',
          );
        }
      });
    }
  }
  return { preferences, update, persistenceError };
}
