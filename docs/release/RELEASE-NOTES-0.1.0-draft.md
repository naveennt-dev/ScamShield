# ScamShield 0.1.0 (macOS preview) — DRAFT, not published

- Self-contained macOS app: the analysis engine is bundled and starts with the app (no Terminal).
- Screen, region and link scanning with on-device rules, ML model and link checks; optional AI
  second opinion (masked text only; your own key, kept in your Keychain).
- Link scan: look-alike and international domains, redirects, page forms/downloads, YouTube
  imitation/wrapper checks; five verdicts with evidence and coverage; "Unable to assess" instead of
  a false "safe" when checks fail.
- History with masked text and "why this colour"; four-option feedback; opt-in sharing (off).
- Optional Chromium extension (unpacked) that warns before high-risk pages open.

Known limitations: not notarized (macOS "Open Anyway" step); Apple silicon only; no Windows,
Linux, Android or iOS builds yet; detection measured on synthetic test sets — not 100% accurate;
isolated page-behaviour inspection is not included in the desktop app.

Checksums: `ScamShield-0.1.0.dmg.sha256` next to the DMG.
