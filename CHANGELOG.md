# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/):
MAJOR for incompatible changes (e.g. API or saved-data format), MINOR for new features, PATCH for
fixes. Releases are tagged `vX.Y.Z`; nothing is released until a tag and a GitHub Release exist.

## [Unreleased] — 0.1.0 preview (not yet released)

### macOS (Apple silicon, macOS 14+)
- Self-contained app with a bundled on-device engine (no Terminal, Node or database needed); DMG.
- Liquid Glass design on macOS 26+ (scanner card, buttons, menu popover; contrast measured to
  WCAG AA on real captures); previous appearance kept on macOS 14–25.
- "Keep the scanner above other windows" setting, launch at login, remembered scanner position.

### Detection (all platforms)
- Rules, link analysis, embedded ML model and risk fusion; "Unable to assess" instead of a false
  "safe" when a check fails.
- Brand look-alike tiers (deceptive subdomains, character substitutions, punycode).
- Link scanner with SSRF protection; optional isolated page inspection (off by default).

### Android (debug build only)
- Capacitor app running the same engine on the device; share-sheet checking; no network permission.

### Licence
- Apache-2.0, with a separate trademark policy for the ScamShield name and logo.
