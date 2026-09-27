import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { startServer } from '../server/index';
import type { DesktopPreferences, Provider } from '../shared/contracts';
import {
  loadApiKey,
  loadPreferences,
  readApiKeyFile,
  removeApiKey,
  saveApiKey,
  savePreferences,
  validateApiKey,
  validateDisplayPreferences,
} from './private-config';
import type { StoredPreferences } from './private-config';

app.setName('Blue Hour');
app.setAppUserModelId('space.bluehour.desktop');
app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
let service: Awaited<ReturnType<typeof startServer>> | undefined;
let origin = '';
let apiKey: string | undefined;
let preferences: StoredPreferences = { autoStart: false, provider: 'public', display: null };
let dataDir = '';
let closing = false;
let operation: Promise<unknown> = Promise.resolve();

function publicPreferences(): DesktopPreferences {
  return {
    desktop: true,
    hasApiKey: Boolean(apiKey),
    provider: preferences.provider,
    autoStart: app.isPackaged && app.getLoginItemSettings().openAtLogin,
    display: preferences.display ? { ...preferences.display } : null,
  };
}

function requireLocalSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('This action is available only in Blue Hour.');
  }
  try {
    if (new URL(event.senderFrame.url).origin !== origin) throw new Error();
  } catch {
    throw new Error('This action is available only in Blue Hour.');
  }
}

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const next = operation.then(action, action);
  operation = next.catch(() => undefined);
  return next;
}

async function beginService(
  port = 0,
  provider = preferences.provider,
  privateKey = apiKey,
): Promise<void> {
  service = await startServer({
    dataDir: path.join(dataDir, 'cache'),
    staticDir: path.join(app.getAppPath(), 'dist', 'web'),
    apiKey: privateKey,
    provider,
    port,
  });
  origin = new URL(service.url).origin;
}

async function restartService(provider = preferences.provider, privateKey = apiKey): Promise<void> {
  const port = Number(new URL(service!.url).port);
  await service?.close();
  try {
    await beginService(port, provider, privateKey);
  } catch {
    // Preserve the previous working provider/configuration if a replacement
    // cannot start. Configuration fields are committed only after this succeeds.
    await beginService(port, preferences.provider, apiKey);
    throw new Error('The local image service could not apply that setting.');
  }
}

async function applyPreferences(next: StoredPreferences, privateKey = apiKey): Promise<void> {
  const previous = { ...preferences };
  const priorKey = apiKey;
  const priorAutoStart = app.isPackaged && app.getLoginItemSettings().openAtLogin;
  const needsRestart = next.provider !== previous.provider || privateKey !== priorKey;
  let restarted = false;
  try {
    if (needsRestart) {
      await restartService(next.provider, privateKey);
      restarted = true;
    }
    await savePreferences(dataDir, next);
    if (app.isPackaged && next.autoStart !== priorAutoStart) {
      app.setLoginItemSettings({ openAtLogin: next.autoStart, path: process.execPath });
    }
    preferences = next;
    apiKey = privateKey;
  } catch {
    // Each rollback is best-effort, but never replace the previous in-memory
    // settings with a partially committed configuration.
    if (restarted) await restartService(previous.provider, priorKey).catch(() => undefined);
    await savePreferences(dataDir, previous).catch(() => undefined);
    if (app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: priorAutoStart, path: process.execPath });
      } catch {
        /* retain fixed error */
      }
    }
    throw new Error('The setting could not be saved. Please try again.');
  }
}

// Both entry paths use the same encrypted transaction. Only configuration status
// returns to the renderer; there is deliberately no saved-key readback method.
async function storePrivateKey(value: string): Promise<void> {
  const previousKey = apiKey;
  if (!(await saveApiKey(dataDir, value))) throw new Error('Private configuration unavailable.');
  try {
    await applyPreferences({ ...preferences, provider: 'nasa' }, value);
  } catch {
    if (previousKey) await saveApiKey(dataDir, previousKey);
    else await removeApiKey(dataDir);
    throw new Error('Private configuration unavailable.');
  }
}

function setupBridge(): void {
  ipcMain.handle('blue-hour:preferences:get', (event) => {
    requireLocalSender(event);
    return publicPreferences();
  });

  ipcMain.handle('blue-hour:preferences:update', (event, patch: unknown) => {
    requireLocalSender(event);
    return serialize(async () => {
      try {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error();
        const values = patch as Record<string, unknown>;
        if (
          Object.keys(values).some(
            (key) => key !== 'provider' && key !== 'autoStart' && key !== 'display',
          )
        )
          throw new Error();
        if (
          values.provider !== undefined &&
          values.provider !== 'public' &&
          values.provider !== 'nasa'
        )
          throw new Error();
        if (values.autoStart !== undefined && typeof values.autoStart !== 'boolean')
          throw new Error();
        const display =
          values.display === undefined ? undefined : validateDisplayPreferences(values.display);
        if (values.display !== undefined && !display) throw new Error();
        const next: StoredPreferences = {
          provider:
            values.provider === undefined ? preferences.provider : (values.provider as Provider),
          autoStart:
            values.autoStart === undefined
              ? publicPreferences().autoStart
              : app.isPackaged && Boolean(values.autoStart),
          display: display ?? preferences.display,
        };
        await applyPreferences(next);
        return publicPreferences();
      } catch {
        throw new Error('The setting could not be saved. Please try again.');
      }
    });
  });

  ipcMain.handle('blue-hour:key:save', (event, value: unknown) => {
    requireLocalSender(event);
    // Validate before scheduling work and never include submitted input in errors.
    let validated = validateApiKey(value);
    value = undefined;
    if (!validated) throw new Error('Enter a valid NASA API key.');
    return serialize(async () => {
      try {
        await storePrivateKey(validated!);
        return { saved: true, hasApiKey: true };
      } catch {
        throw new Error('Your API key could not be saved securely. Please try again.');
      } finally {
        validated = undefined;
      }
    });
  });

  ipcMain.handle('blue-hour:key:import', (event) => {
    requireLocalSender(event);
    return serialize(async () => {
      try {
        const result = await dialog.showOpenDialog(mainWindow!, {
          title: 'Choose your private NASA configuration',
          buttonLabel: 'Use private configuration',
          properties: ['openFile', 'showHiddenFiles'],
          filters: [
            { name: 'Environment configuration', extensions: ['env'] },
            { name: 'All files', extensions: ['*'] },
          ],
        });
        if (result.canceled || result.filePaths.length !== 1)
          return { imported: false, hasApiKey: Boolean(apiKey) };
        const imported = await readApiKeyFile(result.filePaths[0]);
        if (!imported) {
          await dialog.showMessageBox(mainWindow!, {
            type: 'info',
            title: 'Configuration not recognized',
            message: 'Choose a private .env file containing NASA_API_KEY.',
            detail:
              'The configuration stays on this computer. No file contents were sent to the interface.',
          });
          return { imported: false, hasApiKey: Boolean(apiKey) };
        }
        await storePrivateKey(imported);
        return { imported: true, hasApiKey: true };
      } catch {
        throw new Error('The private configuration could not be saved securely. Please try again.');
      }
    });
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: 'Blue Hour',
    width: 1440,
    height: 1000,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#03070b',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  const window = mainWindow;
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin === origin) return;
    } catch {
      /* deny malformed URL */
    }
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      window.setFullScreen(!window.isFullScreen());
      event.preventDefault();
    }
    if (input.key === 'Escape' && window.isFullScreen()) {
      window.setFullScreen(false);
      event.preventDefault();
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });
  await window.loadURL(service!.url);
}

async function boot(): Promise<void> {
  nativeTheme.themeSource = 'dark';
  dataDir = app.getPath('userData');
  apiKey = await loadApiKey(dataDir);

  // A workspace launcher passes only a path. It is consumed here at runtime;
  // build tools never read .env, and neither the path nor the key enters the UI.
  const explicitEnvFile = process.env.BLUE_HOUR_PRIVATE_ENV_FILE;
  delete process.env.BLUE_HOUR_PRIVATE_ENV_FILE;
  const environmentKey = validateApiKey(process.env.NASA_API_KEY);
  delete process.env.NASA_API_KEY;
  // Files/environment seed an unconfigured installation. A key saved explicitly
  // in Preferences takes precedence, including when using the workspace launcher.
  if (!apiKey) {
    const fileKey = explicitEnvFile
      ? await readApiKeyFile(explicitEnvFile)
      : !app.isPackaged
        ? await readApiKeyFile(path.join(app.getAppPath(), '.env'))
        : undefined;
    apiKey = fileKey ?? environmentKey ?? (await readApiKeyFile(path.join(dataDir, '.env')));
    if (apiKey) await saveApiKey(dataDir, apiKey);
  }
  preferences = await loadPreferences(dataDir, Boolean(apiKey));
  await beginService();

  // The renderer has one local origin and no remote network capability.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const target = new URL(details.url);
      callback({ cancel: target.origin !== origin && target.protocol !== 'devtools:' });
    } catch {
      callback({ cancel: true });
    }
  });
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  Menu.setApplicationMenu(null);
  setupBridge();
  await createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app
    .whenReady()
    .then(boot)
    .catch(() => {
      dialog.showErrorBox(
        'Blue Hour could not start',
        'Blue Hour could not open its local image service. Close other copies and try again. Your private configuration has not been displayed or shared.',
      );
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (closing || !service) return;
    event.preventDefault();
    closing = true;
    void operation
      .then(() => service?.close())
      .catch(() => undefined)
      .finally(() => app.quit());
  });
}
