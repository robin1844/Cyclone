# Cyclone combined-site briefing

Keep this project dependency-free and suitable for GitHub Pages and the WebBLE iPhone browser.

- The root page is only a two-button launcher for Cyclone and Typhoon.
- Do not add a Main landmark or other visible content to the launcher.
- Keep the small header Back button visible throughout both apps; it always returns directly to the root launcher.
- Preserve the independent workout engines in `cyclone/index.html` and `typhoon/index.html`.
- Share only distance through the origin-wide `cyclone-typhoon-distances-v1` ledger.
- Keep Typhoon performance/PB history in `typhoon-sessions-v1`.
- Typhoon's twelve-track library follows descending BPM order from 97 to 90.
- Preserve one-time migration from legacy `cyclone-sessions` and completed `typhoon-sessions-v1` records.
- Both reset flows clear the combined distance ledger; Typhoon's reset additionally clears Typhoon workout history.
- In Typhoon, only `#music` may play or be unmuted. Keep `#music-preload` permanently paused and muted as a cache-only preloader; never swap the two elements.
- Register Typhoon's Media Session `nexttrack` action to invoke the same guarded music-advance function as the on-screen button, enabling AirPods and system media controls without introducing another audio player.
- Typhoon's automatic plan excludes tracks heard in the preceding workout. Explicit Next song or Media Session skips use the remaining planned tracks without repetition, then every other unplayed library track before wrapping, so a user-requested skip may eventually override that exclusion.
