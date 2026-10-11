# Proposal: private GitHub repository + CI for Windows, Android and Linux builds

**Status: proposal only.** No repository created, nothing pushed or uploaded. Requires your approval.

## 1. What would be uploaded

Exactly the files tracked by Git on the branch you choose (`git ls-files`) plus its commit history:
426 files, ~6 MB. List: `git ls-files` (by folder: src 174, macos 75, tests 52, docs 40, ml 31,
scripts 16, prisma 9, extension 8, public 5, root config 16).

**Not uploaded** (ignored by Git, verified): `.env`, `db/` (incl. `db/.env`), `node_modules/`,
`.next/`, `macos/build/` (app, DMG, engine), `macos/ScamShield/.build*`, `ml/datasets/processed/`,
`ml/datasets/raw/` except the synthetic CSV, `ml/registry/{candidates,releases,backups}/`, the model
signing **private** key (outside the project), backups (outside the project), and all user History,
reports and Keychain items (outside the project).

## 2. Secret and private-data check (run 2026-10-11, all branches, all commits)

| Check | Result |
|---|---|
| Your OpenRouter key value in any commit | **Not found** |
| Key/token patterns (OpenRouter, OpenAI, AWS, GitHub, Slack, Google, private keys) | Only 3 fake values inside redaction tests (`sk-or-v1-…` test strings); no real secrets |
| `.env` files tracked | Only `.env.example` (placeholders, no values) |
| Keys tracked | `ml/registry/model-signing-public.pem` — a **public** key (intended) |
| Personal data | Commit author was a personal e-mail in every commit (since replaced by a GitHub noreply address); test fixtures use synthetic names/numbers (`ravi.kumar@gmail.com`, `4111 1111…`) |
| Datasets | Synthetic CSV + hand-written eval sets; the UCI SMS data is not tracked |

Recommended before upload: decide whether your e-mail may appear in commit metadata (otherwise
rewrite authorship to a GitHub `noreply` address — a history rewrite, needs your approval); re-run the
scan on the exact commit being pushed; enable GitHub secret scanning + push protection.

## 3. Security implications

- **Code exposure**: a private repo is visible to GitHub (Microsoft) and to anyone you add;
  accidental visibility change is the main risk — restrict admin rights, keep it private.
- **CI secrets**: none needed for unsigned builds. Signing certificates (Windows), the Android
  keystore and an AI key must **never** be committed; if added later, use GitHub encrypted secrets
  in a protected `release` environment that requires your manual approval.
- **Supply chain**: pin actions to commit SHAs, `permissions: contents: read`, no
  `pull_request_target`, `npm ci` from the lockfile, verify the Node.js download (as `build-engine.sh`
  does), artifact retention ≤ 7 days.
- **Artifacts**: unsigned test builds only, downloadable by repo members — not a public release.
- **Cost**: private-repo Actions minutes are limited on the free plan (Windows minutes count ×2,
  macOS ×10). Linux/Android jobs fit easily; the free allowance may not cover frequent Windows builds.

## 4. Proposed workflows (after approval)

| Job | Runner | Produces |
|---|---|---|
| test | ubuntu-latest | tsc, eslint, vitest (needs `ml/datasets/processed` → the model-gate test must use a tracked fixture or be marked data-dependent first) |
| linux | ubuntu-latest | Tauri AppImage/DEB (after the Tauri shell exists) |
| windows | windows-latest | Tauri NSIS installer, unsigned (after the Tauri shell exists) |
| android | ubuntu-latest + Android SDK | Capacitor debug APK; release AAB only with keystore approval |

Nothing for Windows/Android/Linux exists yet; the first CI step would only run the tests.
