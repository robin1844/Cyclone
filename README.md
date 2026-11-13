# Cyclone, Typhoon and Mistral

This GitHub Pages project is the combined home for Robin's three FTMS indoor-bike apps.

- `/` is a deliberately minimal three-button launcher.
- `/cyclone/` contains the original open-ended Cyclone app.
- `/typhoon/` contains the timed Typhoon app and its bundled workout music.
- `/mistral/` contains the distance-targeted Cyclone-style app: choose 5, 10, 15, 20, 25 or 30 miles, or switch to the same values in kilometres. Connect, then Start; Stop remains available for an early finish. The workout and selected audio stop when bike data reaches the target. Half-unit distance announcements are assertive; cadence announcements are polite. Choose distance returns to the picker between workouts.

The launcher has no landmark regions. All app headers contain a small persistent **Back** button returning directly to the launcher; in Typhoon it remains present throughout setup, countdown, workout and results screens.

The workout engines and their app-specific histories remain independent. All three apps share distance through the origin-wide `cyclone-typhoon-distances-v1` local-storage ledger. On first use, existing `cyclone-sessions` and completed `typhoon-sessions-v1` records are imported into that ledger once.

The **Reset all distance data** action in Cyclone or Mistral and **Reset all data** action in Typhoon clear the shared distance ledger. Typhoon's reset also retains its existing responsibility for clearing Typhoon's performance history.
