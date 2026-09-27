import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { DisplayPreferences, Provider } from '../shared/contracts';

export interface StoredPreferences {
  provider: Provider;
  autoStart: boolean;
  display: DisplayPreferences | null;
}

// Error details can contain filesystem paths or credentials. Callers receive only
// a success flag or a new, fixed message; source errors never cross IPC.
export async function readApiKeyFile(filename: string): Promise<string | undefined> {
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > 64 * 1024) return undefined;
    const contents = await readFile(filename, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?NASA_API_KEY\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[1];
      if (value.startsWith('"') || value.startsWith("'")) {
        const quoted = /^(["'])([A-Za-z0-9_-]+)\1\s*(?:#.*)?$/.exec(value);
        if (!quoted) return undefined;
        value = quoted[2];
      } else {
        value = value.replace(/#.*$/, '').trim();
      }
      return validateApiKey(value);
    }
  } catch {
    // A missing/unreadable private file is an unconfigured state, not a log event.
  }
  return undefined;
}

export function validateApiKey(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 1024 &&
    /^[A-Za-z0-9_-]{4,160}$/.test(value.trim())
    ? value.trim()
    : undefined;
}

export function validateDisplayPreferences(value: unknown): DisplayPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const display = value as Record<string, unknown>;
  if (
    Object.keys(display).some(
      (key) => !['brightness', 'reducedMotion', 'interval', 'panelSize'].includes(key),
    )
  )
    return undefined;
  if (
    typeof display.brightness !== 'number' ||
    !Number.isInteger(display.brightness) ||
    display.brightness < 35 ||
    display.brightness > 100
  )
    return undefined;
  if (typeof display.reducedMotion !== 'boolean') return undefined;
  if (display.interval !== 1000 && display.interval !== 2000 && display.interval !== 4000)
    return undefined;
  if (display.panelSize !== '3.4' && display.panelSize !== '5') return undefined;
  return {
    brightness: display.brightness,
    reducedMotion: display.reducedMotion,
    interval: display.interval,
    panelSize: display.panelSize,
  };
}

async function writePrivateFile(filename: string, value: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.pending`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, filename);
}

export async function saveApiKey(dataDir: string, apiKey: string): Promise<boolean> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    // Never accept the plaintext fallback used on Linux without a secret store.
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      return false;
    await writePrivateFile(
      path.join(dataDir, 'secret.bin'),
      await safeStorage.encryptStringAsync(apiKey),
    );
    return true;
  } catch {
    return false;
  }
}

export async function loadApiKey(dataDir: string): Promise<string | undefined> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return undefined;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      return undefined;
    const value = await readFile(path.join(dataDir, 'secret.bin'));
    if (value.byteLength > 8192) return undefined;
    const decrypted = await safeStorage.decryptStringAsync(value);
    const apiKey = validateApiKey(decrypted.result);
    if (apiKey && decrypted.shouldReEncrypt) await saveApiKey(dataDir, apiKey);
    return apiKey;
  } catch {
    return undefined;
  }
}

export async function removeApiKey(dataDir: string): Promise<void> {
  await unlink(path.join(dataDir, 'secret.bin')).catch(() => undefined);
}

export async function loadPreferences(
  dataDir: string,
  hasApiKey: boolean,
): Promise<StoredPreferences> {
  const defaults: StoredPreferences = {
    provider: hasApiKey ? 'nasa' : 'public',
    autoStart: false,
    display: null,
  };
  try {
    const source = await readFile(path.join(dataDir, 'preferences.json'), 'utf8');
    if (source.length > 2048) return defaults;
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const value = parsed as Record<string, unknown>;
    return {
      provider:
        value.provider === 'nasa' || value.provider === 'public'
          ? value.provider
          : defaults.provider,
      autoStart: value.autoStart === true,
      display: validateDisplayPreferences(value.display) ?? null,
    };
  } catch {
    return defaults;
  }
}

export async function savePreferences(
  dataDir: string,
  preferences: StoredPreferences,
): Promise<void> {
  // Build a new object so future private fields can never accidentally serialize.
  await writePrivateFile(
    path.join(dataDir, 'preferences.json'),
    JSON.stringify({
      provider: preferences.provider,
      autoStart: preferences.autoStart,
      display: validateDisplayPreferences(preferences.display) ?? null,
    }),
  );
}
