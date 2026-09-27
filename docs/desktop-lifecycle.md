# Desktop lifecycle

`electron/main.ts` owns the desktop window and starts the bundled service before loading the interface. The HTTP listener selects an available loopback port. The same origin serves both the compiled interface and the image/metadata API.

The service is closed before the desktop exits. A second application launch focuses the existing instance, so two desktop windows do not compete for the same cache. The first startup reads private configuration, restores the cache and begins normal refresh behavior. A browser window is shown only once its initial document is ready.

The isolated preload has four methods, defined in `shared/contracts.ts`:

| Method | Result |
| --- | --- |
| `getPreferences()` | Provider, native login-start state, display preferences, and a credential-presence boolean |
| `updatePreferences({ provider?, autoStart?, display? })` | Validated native settings; provider changes restart the fetch service at the same local origin |
| `importKey()` | Opens a native file dialog, encrypts a recognized NASA key, activates the NASA provider, and returns two booleans |
| `saveKey(value)` | Accepts a transient masked-field draft, validates and encrypts it, activates the NASA provider, and returns status booleans only |

The interface cannot supply file paths to an IPC endpoint, read arbitrary files, invoke arbitrary channels, or retrieve a saved key. A user-entered draft exists briefly in the password field and restricted IPC call, then is cleared. It never enters HTTP requests, URLs, browser storage, or saved preferences. Native settings are serialized to avoid overlapping provider changes, key saves, and imports. Failures use fixed, credential-free errors.

Display preferences are saved with native settings so brightness, reduced motion, playback interval and panel size survive the randomly assigned loopback port changing on restart. Before the first explicit user change, display preferences remain unset and the interface uses its defaults, including the operating system's reduced-motion preference. A browser-only preview uses local storage instead.

The workspace's double-click VBS launcher locates only the prepared application. If a source `.env` exists, it puts the file path in a process-scoped `BLUE_HOUR_PRIVATE_ENV_FILE` variable. The desktop process consumes and removes that variable. No shell command evaluates the file, no build parses it, and no key is placed on a command line.

A stored encrypted key takes precedence over environment-file seeding. Saving a personal key in Preferences therefore survives subsequent workspace launches without being replaced by a different source `.env` value.

Production installers create desktop and Start menu shortcuts. Enabling startup at login uses Electron's Windows login-item integration; the application is not configured to start at login without a user's settings action. The desktop package has no web installer or first-run package download dependency.
