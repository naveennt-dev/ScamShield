# Contributing to ScamShield

Thank you for helping protect people from scams. Contributions are reviewed and merged **only by the
project maintainers**; opening a pull request does not guarantee it will be merged.

## Ground rules

- Be kind — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **Never** commit real people's messages, phone numbers, account details, API keys or `.env` files.
  Use synthetic examples. Security problems go through [SECURITY.md](SECURITY.md), not issues.
- Detection changes need evidence: add or update tests and report the evaluation numbers
  (see below). We never claim 100% accuracy.
- By contributing you agree that your contribution is licensed under the
  [Apache License 2.0](LICENSE) (Apache-2.0 §5), and you confirm you have the right to submit it.
- The ScamShield name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md), not by the licence.

## Project layout

| Path | What |
|---|---|
| `src/lib/detection`, `src/lib/url`, `src/lib/linkscan` | Shared detection engine (rules, link analysis, ML, risk fusion) |
| `src/app` | Next.js web app and API (also the desktop engine) |
| `macos/ScamShield` | macOS menu-bar app (Swift Package, builds with the Command Line Tools) |
| `mobile/` | Android app (Capacitor) running the same engine on the device |
| `extension/chromium` | Chromium link-warning extension (talks to the local engine) |
| `ml/` | Model training, evaluation and the embedded model |
| `tests/`, `macos/ScamShield/Tests`, `mobile/test` | Tests |

## Set up

Node 22, Python 3.12+ (ML only), PostgreSQL 17 and Redis for the full web test suite; macOS 14+
with Xcode or the Command Line Tools for the Mac app; JDK 21 and the Android SDK for Android.

```
npm ci
cp .env.example .env        # fill in only what you need; never commit .env
npx prisma migrate deploy
```

## Checks (run before opening a pull request)

```
npx tsc --noEmit
npx eslint src scripts tests extension
npx vitest run                                   # needs the test database
cd macos/ScamShield && ../scripts/test.sh        # macOS
cd mobile && npm ci && npm run test:parity       # device engine == server engine
```

Detection changes: also run `npx tsx scripts/eval-realistic.ts tests/fixtures/eval/<set>.jsonl` and
`npx tsx scripts/eval-urls.ts <set>` and put before/after numbers in the pull request. Don't tune on
the blind sets (`*-blind-*`).

## Pull requests

- One topic per pull request; describe what changed, why, and how you tested it.
- CI must pass. CI runs with **read-only** permissions and no secrets; signing keys and API keys are
  never available to pull requests.
- Changes to security-sensitive areas (link scanner / SSRF protection, host allow-list, extension,
  anything that sends data off the device, model registry / signing, build and release scripts)
  need review by a maintainer who checks them specifically for security.
- Match the existing style; comments explain *why*, not *what*.
