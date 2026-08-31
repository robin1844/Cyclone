# Cyclone and Typhoon

This GitHub Pages project is the combined home for Robin's two FTMS indoor-bike apps.

- `/` is a deliberately minimal two-button launcher.
- `/cyclone/` contains the original open-ended Cyclone app.
- `/typhoon/` contains the timed Typhoon app and its bundled workout music.

The workout engines and their app-specific histories remain independent. Only distance is combined through the origin-wide `cyclone-typhoon-distances-v1` local-storage ledger. On first use, existing `cyclone-sessions` and completed `typhoon-sessions-v1` records are imported into that ledger once.

The **Reset all distance data** action in Cyclone and **Reset all data** action in Typhoon clear the shared distance ledger. Typhoon's reset also retains its existing responsibility for clearing Typhoon's performance history.
