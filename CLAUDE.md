# Cyclone combined-site briefing

Keep this project dependency-free and suitable for GitHub Pages and the WebBLE iPhone browser.

- The root page is only a two-button launcher for Cyclone and Typhoon.
- Do not add a Main landmark or other visible content to the launcher.
- Keep the small header Back button visible throughout both apps; it always returns directly to the root launcher.
- Preserve the independent workout engines in `cyclone/index.html` and `typhoon/index.html`.
- Share only distance through the origin-wide `cyclone-typhoon-distances-v1` ledger.
- Keep Typhoon performance/PB history in `typhoon-sessions-v1`.
- Preserve one-time migration from legacy `cyclone-sessions` and completed `typhoon-sessions-v1` records.
- Both reset flows clear the combined distance ledger; Typhoon's reset additionally clears Typhoon workout history.
