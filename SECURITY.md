# Private configuration and security boundaries

Blue Hour stores NASA credentials in the desktop main process's encrypted private store and uses them only through the local fetch service. Saved and imported credentials are never returned to the renderer. A key typed into Preferences exists transiently in the masked input and interface memory before submission through the restricted desktop bridge. Credentials must never enter the source repository, release archive, browser storage or diagnostics.

## Credential lifecycle

1. Users enter their own key in the masked **NASA API key** field in Preferences or import an explicitly chosen private configuration file. The desktop process validates the submitted value. The typed draft clears after submission and is discarded when Preferences closes; saved values are never filled back into the field.
2. The restricted save and native import methods return only success and presence booleans. The import method does not return file contents, file paths or the credential. Other preference and status APIs expose presence and provider information only.
3. Saved and imported credentials are encrypted with Electron `safeStorage` in `%APPDATA%\Blue Hour\secret.bin`. On Windows, encryption uses the current account's DPAPI facility. Other software running with your Windows account's permissions remains within that trust boundary. If secure storage is unavailable, saving fails rather than writing a plaintext fallback.
4. The fetch adapter applies the credential only to HTTPS requests to NASA's authenticated API host. The image archive is accessed without credentials. Redirects must not forward credentials to another origin.
5. Rotating a key uses **Replace API key** or the native import dialog and takes effect without rebuilding or restarting. On later launches, a previously encrypted key takes precedence over a private runtime environment variable or launcher file. Runtime sources seed an unconfigured profile without overwriting the user's replacement.

The workspace launcher passes only the private file's path in its child process environment. Build scripts do not parse `.env`, and the packaging configuration excludes environment files. The application can run without a key by explicitly using the public EPIC provider. It never changes providers to evade rate limits.

## Desktop restrictions

- Browser renderer: sandboxed, context isolation enabled, Node integration disabled.
- Preload: individual allowlisted methods for native preferences, key entry and native key import, with no raw IPC, credential readback or filesystem access.
- IPC: only the active application's main frame and current loopback origin are accepted.
- Network: browser requests are limited to the application's own local origin; the private service binds only to loopback.
- External navigation, new windows, browser downloads, webviews, camera, microphone, location and other browser permissions are disabled.
- Exceptions crossing native boundaries use fixed messages rather than source errors, file contents, authenticated URLs or raw upstream response bodies.
- No analytics, remote crash uploader, automatic update endpoint or third-party CDN assets are configured.

## Release review

Run the repository's privacy verification with a fake sentinel credential. Check shipped browser assets, API responses, errors, logs, installer contents and source-control tracking. Never print a personal key to make a comparison; code should compare values in memory and return only a boolean or sanitized result. Do not commit `.env`, private storage, cache directories, logs, or local diagnostic artifacts.

Before committing, run `npm.cmd run verify:privacy` after staging the intended files. Run it again before pushing. The audit checks publishable working files, exact staged Git blobs, reachable commit history, built assets, and the packaged application when present. It compares locally configured private values in memory and checks common credential formats and private filenames; its output contains only counts and fixed failure categories. A failed audit must be resolved before publication. Pattern checks cannot identify every possible secret, so keep all real credentials in the app's private configuration and review new files before staging.

README screenshots are captured through `scripts/capture-readme.mjs` using a fresh public-provider profile with no credential. Only the app's observatory is captured; user profiles and key-entry forms are excluded.

Report a vulnerability privately to the application maintainer without including a real credential. If a credential is accidentally exposed, revoke it at its provider and replace it; deleting a file or commit alone does not revoke access.

Implementation references: [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security), [Electron process sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox), and [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
