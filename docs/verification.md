# Desktop verification

Verified on Windows on September 27, 2026.

## Implemented and checked

- Real public NASA EPIC metadata and full-resolution PNG downloads for both natural and enhanced collections. The integration run saved 48 images per collection, using approximately 247 MiB within the 512 MiB cap.
- 18 automated tests passed: strict UTC parsing, newest-frame selection, corrupt/truncated image rejection, cache recovery and offline restart, empty/malformed upstream data, rate limits and authentication suspension, concurrency and retention bounds, safe local endpoints, thumbnail generation, presentation timestamps, and prompt checks for a newly saved key without bypassing rate limits.
- Direct API-key entry passed 26 checks in both the development and final packaged executable using fake credentials: masked input, cleared drafts, save and replacement, Windows-encrypted storage, no saved-key readback or browser persistence, fixed validation errors, and replacement surviving restart despite a competing launcher seed file. No personal key was used in these checks.
- Eight native private-storage checks passed using a fake credential, including Windows encryption, absence of plaintext in the encrypted file, strict configuration parsing, and persisted display settings.
- Fourteen native application checks passed, including sandbox isolation, the restricted bridge, provider changes, blocked external windows, and display preferences surviving a complete restart with a different local port.
- The final packaged executable passed all 16 checks, including downloading a real NASA observation and producing its 128-pixel thumbnail from the bundled worker inside the application archive.
- Browser interaction checks passed for saved-frame navigation, refresh preserving historical selection, recorded playback, daily grouping, natural/enhanced switching, settings, hidden desk controls, and responsive layout. No browser runtime errors or remote browser requests were observed.
- Circular text/control bounding boxes were measured at both layout presets. The largest measured 3.4-inch preset caption corner was 0.4383 times the diameter, within the specified 0.44 safe radius. These are screen-coordinate checks, not physical-panel validation.
- Windows x64 NSIS installer and unpacked executable generated. The package archive contains no `.env`, private credential file, or image-cache database.

## Deliberate boundaries

The workspace `.env` was empty during integration, so real authenticated requests using the user's key could not be tested. Authentication behavior and credential boundaries were verified using fake sentinel credentials. The application works through the explicitly identified public provider; it does not fall back to that provider after a private-provider failure.

No physical panel or enclosure has been selected. Actual-size readability, touch alignment, panel backlight control, physical power-loss behavior, the one-second startup target on appliance hardware, and a 24-hour hardware soak remain hardware-stage work. Software clock warnings detect obvious inconsistencies, not a replacement for OS clock synchronization.

The generated installer is unsigned. A clean-machine installation and publisher code signing are release-distribution steps. The app includes its own runtime and needs no terminal for normal installation or use.

Existing collection/image/version cache identities are immutable. Explicit revalidation of an unchanged asset is not yet exposed. Archive event curation and geometry overlays remain future modules.

## Reproducible checks

Contributor commands are documented in the README. `scripts/ui-smoke.mjs` checks the local preview with installed Chrome; `scripts/smoke-desktop.mjs` uses isolated temporary user data and an empty environment fixture. Add `--packaged` to test the actual release executable and its thumbnail worker. These scripts do not load the user's private configuration.

`scripts/verify-privacy.mjs` performs a local code-only comparison against any configured workspace key and prints only pass/fail metadata. The build itself never loads `.env`.

## Source contract

Implementation follows the supplied Blue Hour blueprint's desktop workflow and the official [NASA EPIC API documentation](https://epic.gsfc.nasa.gov/about/api), [image descriptions and reuse policy](https://epic.gsfc.nasa.gov/about), and [NASA authentication guidance](https://api.nasa.gov/assets/html/authentication.html). The separate desktop renderer follows [Electron's security recommendations](https://www.electronjs.org/docs/latest/tutorial/security).
