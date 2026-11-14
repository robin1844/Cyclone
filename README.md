# Cyclone, Typhoon and Mistral

One dependency-free FTMS indoor-bike app, served by GitHub Pages, with a three-button launcher and three workout sections:

- Cyclone: open-ended workouts with optional chosen MP3 audio.
- Typhoon: timed workouts, bundled music, results and performance history.
- Mistral: 5, 10, 15, 20, 25 or 30 miles or kilometres, with automatic stopping at the target and assertive half-unit distance announcements. Cadence is polite and pauses around distance messages. Near the finish, Mistral announces 200, 100 and 50 yards remaining in miles mode, or metres in kilometre mode. At completion or early Stop, it shows and reads Time and Average speed (mph or km/h), without comparisons or personal-best commentary. Time runs from Start to Stop/completion, including the opening tones and reconnection intervals; average speed is actual distance divided by that elapsed time.

The page stays loaded when changing sections. `src/shell.js` owns the only native Bluetooth device, GATT connection and FTMS notification subscription. Each engine receives data only while its section is open. Connect once, then use Back and open another section: the connected bike is ready for Start. Stop and Back do not disconnect the bike. A genuine disconnect triggers automatic retries; Cyclone/Mistral keep the active workout and audio running, while Typhoon preserves its previous incomplete-workout behaviour.

The root launcher has no landmark regions. Hidden sections are removed from layout and the accessibility tree. Back remains visible throughout each section, including Typhoon countdown and results. Returning to the launcher ends any current workout according to that section's normal early-stop rules, pauses its audio, cancels pending start tones/playback, releases its screen wake lock and retains the Bluetooth connection. Browser Back/Forward changes sections without loading another document. Existing `/cyclone/`, `/typhoon/` and `/mistral/` URLs redirect into the appropriate section.

All sections share the existing origin-wide `cyclone-typhoon-distances-v1` ledger, stored in kilometres. Cyclone and Mistral use the phone's local calendar day for Today; Mistral converts displayed values to its selected unit. Totals refresh on section entry. Existing `cyclone-sessions` and completed `typhoon-sessions-v1` records still migrate exactly once. Typhoon's performance/PB history remains separate in `typhoon-sessions-v1`, and only completed Typhoon workouts enter its histories, as before. Reset in any section clears shared distances; Typhoon reset additionally clears its performance history.

Cyclone and Mistral use Typhoon's countdown and Go tones, followed by its one-second gap before workout media becomes audible. Media begins within the Start tap through a silent Web Audio gain stage; after the tones it rewinds and becomes audible without a second playback request. Stop pauses media before the finish sound, including Mistral's automatic distance finish. Playback errors are shown and announced with a manual Play fallback. Typhoon's established music playback and cache-only preloader remain separate and unchanged in purpose.

## Source and build

Edit `src/shell.js`, `src/launcher.html` and the three `src/*.html` section sources, then run:

```text
python build.py
```

The standard-library-only builder scopes each section's CSS and IDs, wraps its engine in a private scope, resolves Typhoon music paths, and writes `index.html`, `app.css`, `app.js` and the legacy URL redirects. Generated CSS and JS URLs include a content hash so deployed updates load together. Commit sources and generated files. There is no build step or dependency installation on the live site.

## Verification

`tests/journeys.cjs` uses Playwright installed outside this repository. Start `python -m http.server 8765`, set `PLAYWRIGHT_MODULE` to the external Playwright module directory if needed, then run `node tests/journeys.cjs`. Set `CYCLONE_BROWSER=webkit` for the WebKit journey checks. Windows Playwright WebKit lacks Web Audio, so actual Web Audio/MP3 playback integration runs in Chromium.

The suite covers one connection and one notification subscription across all sections, shared Today and distance resets, independent Typhoon completed history, Mistral target/milestone behaviour, interrupted starts, browser navigation, legacy links, remembered-device connection, reconnecting during an active ride without another chooser, and real MP3 decoding/playback in Cyclone and Mistral. Bluetooth is simulated: physical bike and iPhone/WebBLE/VoiceOver behaviour require device testing.

Run `node tests/mistral-results.cjs` against the same test server for Mistral finish cues and results: true yard conversions, threshold/cadence priority, repeat-workout resets, both speed units, early stopping, long and zero durations, and cancellation on leaving. It also supports `CYCLONE_BROWSER=webkit`.
