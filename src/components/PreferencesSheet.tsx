import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, FileKey2, Monitor, ShieldCheck } from 'lucide-react';
import type { DesktopPreferences, Provider } from '../../shared/contracts';
import type { Preferences } from '../hooks/usePreferences';
import { Sheet } from './Sheet';

type Props = {
  preferences: Preferences;
  update: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  onClose: () => void;
  onServiceChange: () => void;
  provider?: Provider;
  persistenceError?: string | null;
};

export function PreferencesSheet({
  preferences,
  update,
  onClose,
  onServiceChange,
  provider,
  persistenceError,
}: Props) {
  const [desktop, setDesktop] = useState<DesktopPreferences | null>(null);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [keyError, setKeyError] = useState(false);
  const keyInput = useRef<HTMLInputElement | null>(null);
  const keyFieldRef = useCallback((node: HTMLInputElement | null) => {
    // Clear the field even when the entire sheet is unmounted by its parent.
    if (!node && keyInput.current) keyInput.current.value = '';
    keyInput.current = node;
  }, []);
  useEffect(() => {
    void window.blueHour
      ?.getPreferences()
      .then(setDesktop)
      .catch(() => setMessage('Desktop preferences are temporarily unavailable.'));
  }, []);

  function clearKeyInput() {
    if (keyInput.current) keyInput.current.value = '';
  }

  function closePreferences() {
    clearKeyInput();
    onClose();
  }

  async function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.blueHour || !keyInput.current || working) return;
    setMessage('');
    setKeyError(false);
    if (!/^[A-Za-z0-9_-]{4,160}$/.test(keyInput.current.value.trim())) {
      clearKeyInput();
      setKeyError(true);
      setMessage('Enter a NASA API key with 4–160 letters, numbers, underscores, or hyphens.');
      keyInput.current.focus();
      return;
    }
    setWorking(true);
    try {
      // Send directly to the local desktop bridge; never retain a key in React state.
      const pendingSave = window.blueHour.saveKey(keyInput.current.value.trim());
      clearKeyInput();
      const result = await pendingSave;
      if (!result.saved) throw new Error('Key was not saved');
      setDesktop(
        (current) => current && { ...current, hasApiKey: result.hasApiKey, provider: 'nasa' },
      );
      setMessage('API key saved securely. NASA access is checked automatically.');
      onServiceChange();
    } catch {
      setKeyError(true);
      setMessage('Your API key could not be saved securely. Please enter it again and retry.');
    } finally {
      clearKeyInput();
      setWorking(false);
    }
  }

  async function updateDesktop(patch: { autoStart?: boolean; provider?: Provider }) {
    if (!window.blueHour) return;
    setWorking(true);
    setMessage('');
    setKeyError(false);
    try {
      setDesktop(await window.blueHour.updatePreferences(patch));
      onServiceChange();
    } catch {
      setMessage('This setting could not be saved. Please try again.');
    } finally {
      setWorking(false);
    }
  }

  async function importKey() {
    if (!window.blueHour) return;
    clearKeyInput();
    setWorking(true);
    setMessage('');
    setKeyError(false);
    try {
      const result = await window.blueHour.importKey();
      if (result.imported) {
        setMessage('Private configuration imported securely.');
        setDesktop(await window.blueHour.getPreferences());
        onServiceChange();
      }
    } catch {
      setMessage(
        'The private configuration could not be imported. Choose a local file containing NASA_API_KEY.',
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <Sheet title="Make yourself at home." eyebrow="PREFERENCES" onClose={closePreferences}>
      <section className="settings-section">
        <h3>Display & atmosphere</h3>
        <label className="setting-label" htmlFor="brightness">
          <span>Interface brightness</span>
          <span className="value-label">{preferences.brightness}%</span>
        </label>
        <input
          id="brightness"
          type="range"
          min="35"
          max="100"
          value={preferences.brightness}
          onChange={(event) => update('brightness', Number(event.target.value))}
        />
        <p className="setting-description">
          Dims the interface only. NASA imagery stays untouched. Use your display’s controls for
          screen brightness.
        </p>
        <label className="setting-row">
          <span>
            <strong>Reduce motion</strong>
            <span>Minimize interface transitions.</span>
          </span>
          <input
            className="switch"
            type="checkbox"
            checked={preferences.reducedMotion}
            onChange={(event) => update('reducedMotion', event.target.checked)}
          />
        </label>
        <label className="setting-row">
          <span>
            <strong>Playback interval</strong>
            <span>Real images at a fixed presentation speed.</span>
          </span>
          <select
            value={preferences.interval}
            onChange={(event) => update('interval', Number(event.target.value))}
          >
            <option value={1000}>1 second</option>
            <option value={2000}>2 seconds</option>
            <option value={4000}>4 seconds</option>
          </select>
        </label>
      </section>
      <section className="settings-section">
        <h3>Desk view</h3>
        <label className="setting-row">
          <span>
            <strong>Circular display layout</strong>
            <span>Preview the intended panel proportions.</span>
          </span>
          <select
            value={preferences.panelSize}
            onChange={(event) => update('panelSize', event.target.value as '3.4' | '5')}
          >
            <option value="3.4">3.4 inch</option>
            <option value="5">5 inch</option>
          </select>
        </label>
        <p className="setting-description">
          <Monitor size={13} /> A layout preview; physical sizing depends on your panel’s active
          resolution and diameter.
        </p>
        {desktop && (
          <label className="setting-row">
            <span>
              <strong>Open at sign-in</strong>
              <span>Have Earth waiting when your day begins.</span>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={desktop.autoStart}
              disabled={working}
              onChange={(event) => void updateDesktop({ autoStart: event.target.checked })}
            />
          </label>
        )}
      </section>
      <section className="settings-section">
        <h3>Imagery connection</h3>
        <label className="setting-row">
          <span>
            <strong>Metadata source</strong>
            <span>Source changes are always your choice.</span>
          </span>
          <select
            aria-label="Metadata source"
            value={desktop?.provider || provider || 'public'}
            disabled={!desktop || working}
            onChange={(event) => void updateDesktop({ provider: event.target.value as Provider })}
          >
            <option value="public">Public EPIC</option>
            <option value="nasa" disabled={!desktop?.hasApiKey}>
              NASA authenticated
            </option>
          </select>
        </label>
        {desktop ? (
          <div className="private-config">
            <ShieldCheck size={18} />
            <div>
              <strong>
                {desktop.hasApiKey ? 'NASA API key saved' : 'Bring your own NASA API key'}
              </strong>
              <p>
                {desktop.hasApiKey
                  ? 'Your saved key stays with the local service. Its value is never returned to this interface.'
                  : 'Add your personal key to use NASA authenticated imagery. Public EPIC works without one.'}
              </p>
            </div>
            {desktop.hasApiKey && <Check size={16} />}
          </div>
        ) : (
          <p className="setting-description">
            The local service manages your connection. Source and private configuration controls are
            available in the desktop application.
          </p>
        )}
        {desktop && (
          <>
            <form className="api-key-form" onSubmit={(event) => void saveKey(event)} noValidate>
              <label className="setting-label" htmlFor="nasa-api-key">
                NASA API key
                <span className="value-label">
                  {desktop.hasApiKey ? 'Replace saved key' : 'Optional'}
                </span>
              </label>
              <input
                id="nasa-api-key"
                aria-label="NASA API key"
                className="api-key-input"
                ref={keyFieldRef}
                type="password"
                placeholder={
                  desktop.hasApiKey ? 'Paste a replacement key' : 'Paste your NASA API key'
                }
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={160}
                disabled={working}
                aria-invalid={keyError || undefined}
                aria-describedby={`nasa-key-privacy${keyError ? ' preferences-message' : ''}`}
              />
              <p className="setting-description api-key-privacy" id="nasa-key-privacy">
                Entered only in this masked field, then cleared when you save or close. Saved keys
                are encrypted using your operating system and kept outside the app and project
                files.
              </p>
              <button className="primary-button api-key-save" type="submit" disabled={working}>
                <ShieldCheck size={15} />
                {desktop.hasApiKey ? 'Replace API key' : 'Save API key'}
              </button>
            </form>
            <div className="api-key-import">
              <span>Already have an environment file?</span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void importKey()}
                disabled={working}
              >
                <FileKey2 size={15} />
                Import .env file
              </button>
            </div>
          </>
        )}
        {message && (
          <p
            className="settings-message"
            id="preferences-message"
            role={keyError ? 'alert' : 'status'}
          >
            {message}
          </p>
        )}
      </section>
      {persistenceError && (
        <p className="settings-message" role="status">
          {persistenceError}
        </p>
      )}
      <p className="sheet-footnote">No account. No analytics. Just a little perspective.</p>
    </Sheet>
  );
}
