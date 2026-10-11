# ScamShield Link Guard (Chrome / Edge, Manifest V3)

Warns before a dangerous link opens. Every check is done by the ScamShield service **on this device**
(address only — no query string, no fragment; nothing leaves the device).

**Install (unpacked, not from a store):** start ScamShield (`scripts/scamshield.sh start`), open
`chrome://extensions` (or `edge://extensions`), turn on *Developer mode*, click **Load unpacked** and
choose this folder.

**What it can't do** — pages may start loading before the warning replaces them (Manifest V3 can't
block synchronously); sub-frames, background requests, downloads started by pages, other browsers,
private windows and navigations during the extension's start-up are not checked; if the ScamShield
service isn't running, nothing is checked (badge "!"). Details: `docs/design/link-protection.md`.

Tests: `tests/unit/extension.test.ts`; end-to-end in Playwright's Chromium: `npx tsx scripts/e2e-extension.ts`.
