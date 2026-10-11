# Installing ScamShield on your Mac (personal use)

ScamShield is a menu-bar app plus a small set of local services that run only on `127.0.0.1`. It
is built from source on your Mac; nothing is downloaded at runtime and nothing needs an account.

## Prerequisites

| Need | Check / install |
|---|---|
| macOS 14+ | Apple menu → About This Mac |
| Swift toolchain | `xcode-select --install` (Command Line Tools are enough) |
| Node.js 20+ | `node -v` (Homebrew, fnm or nvm) |
| Python 3 | `python3 -V` |
| PostgreSQL 17 (web accounts and history; not required for Mac scanning) | `brew install postgresql@17` |
| Redis (rate-limit counters; optional) | `brew install redis` |

First-time setup in the repository folder:

```bash
npm install
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
npm run ml:fetch-data && npm run ml:train     # only if ml/models/scam_classifier.joblib is missing
cp .env.example .env                           # only if you don't have a .env yet
```

`scripts/install.sh` checks all of this and prints the exact command for anything missing.

## Install or upgrade

```bash
scripts/install.sh
```

1. Checks prerequisites.
2. Builds the API (`npm run build`) and the Mac app (production configuration).
3. Installs `~/Applications/ScamShield.app`. It replaces only a previous ScamShield (bundle id
   `dev.scamshield.mac`) and keeps one backup in `.scamshield-run/app-backup/`. Anything else at
   that path is left alone.
4. Verifies the app bundle contains **no `.env` file and no API key**.
5. If the services were running, stops them for the rebuild and starts them again, including when
   a build step fails.

**Upgrades keep your data:** history, reports, database, settings and `.env` are never touched.
This was verified by hashing the files and counting database rows before and after an upgrade.

## Run

```bash
scripts/scamshield.sh start     # database, Redis, ML service, API, then opens the app
scripts/scamshield.sh status
scripts/scamshield.sh stop      # quits the app and stops the services
scripts/scamshield.sh restart
```

`scripts/local-stack.sh start|stop|restart|status` runs the services without the app.

- **One instance:** opening ScamShield again just shows its menu; there is never a second
  menu-bar icon.
- **Quit:** menu → Quit ScamShield, or ⌘Q while one of its windows is focused.
- **Services:** they keep running after the app quits until you stop them.

What `local-stack.sh` manages, all on `127.0.0.1`:
- **PostgreSQL**, on the port in `DATABASE_URL`. Its data is in
  `~/Library/Application Support/ScamShield/server/postgres` and is created on first start.
  Migrations are applied on every start; they only add, never reset.
- **Redis**, on the port in `REDIS_URL`; it holds rate-limit counters only and nothing is persisted.
- **The ML service** on port 8765.
- **The API** on port 3000.

It also detects stale PID files after a crash and refuses to start if another program is using one
of its ports; the message names that program. Logs are in `.scamshield-run/`.

If your `DATABASE_URL` has no password, the cluster is created with trust authentication on
`127.0.0.1` only, and the script prints a warning. Any process on this Mac could then connect.
Add a password to `DATABASE_URL` before the first start to avoid that.

## Permissions

ScamShield needs **Screen Recording**, only to read the part of the screen you choose when you
start a scan.

1. Menu → Scan Screen. macOS shows the prompt, or the card shows a "permission required" message
   with a button to open the settings pane.
2. Go to System Settings → Privacy & Security → Screen & System Audio Recording, turn on
   **ScamShield**, and choose "Quit & Reopen" if asked.

**After a rebuild** (every install or upgrade), the default ad-hoc signature gives the app a new
identity, so macOS forgets the permission and you must turn it on again. If the old entry
lingers, reset it first: `tccutil reset ScreenCapture dev.scamshield.mac`.

**Optional, to avoid re-granting:** sign with a free, self-signed certificate on your Mac.

```bash
macos/scripts/create-signing-identity.sh   # adds "ScamShield Local Signing" to your login keychain
scripts/install.sh                          # signs with it automatically
```

- **What it does:** the app's signing requirement then names that certificate instead of a build
  hash, so it stays the same across rebuilds. This was verified with `codesign -d -r-`.
- **Not verified on your Mac:** whether macOS keeps the Screen Recording grant across rebuilds
  with it (see `docs/phases/phase-6-completion.md`).
- **To undo:** delete the certificate in Keychain Access.
- **Limits:** this isn't an Apple Developer ID. The app works only on this Mac and isn't
  notarized. Notarization needs a paid Apple Developer account and was deliberately not set up.

## Verify local-only mode

1. Settings → Analysis shows **"On this device only"** (if chosen in the first-launch consent window; otherwise "On this device + AI second opinion"), and the menu shows
   **Local-only analysis**.
2. `scripts/local-stack.sh status` shows `'llm': 'disabled'`.
3. Scan a message: the card says **"Checked on this device only."**
4. Full check: `scripts/offline-check.sh`. Turn Wi-Fi off when it asks, don't touch the Mac, and
   turn Wi-Fi back on at the end. Expect `OFFLINE CHECK PASSED`.

## Uninstall

```bash
scripts/uninstall.sh                       # removes the app only; your data is kept
scripts/uninstall.sh --reset-permissions   # also forgets the Screen Recording permission
scripts/uninstall.sh --delete-user-data    # ALSO deletes your data (asks you to type DELETE)
```

| App files (always removed) | Your data (removed only with `--delete-user-data` + typing DELETE) |
|---|---|
| `~/Applications/ScamShield.app`, the installer's backup | `~/Library/Application Support/ScamShield/` (history, reports, local database), preferences `dev.scamshield.mac` |

The repository (source, `.env`, ML models) is never touched by the uninstaller.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Card says "ScamShield analysis service isn't running" | `scripts/scamshield.sh start` and check `status` |
| "took too long to respond" | The service is running but slow (e.g. remote AI on a busy free model). Try again; local-only scans take milliseconds |
| "Too many scans in a short time" | Started without the stack script? `scripts/local-stack.sh` enables the local tier (60/min, 2,000/day). Restart with `scripts/scamshield.sh restart` |
| "Screen Recording permission required" after an upgrade | Expected with ad-hoc signing; turn the permission on again (see above) |
| `ERROR: port 3000 is in use by …` | Another program uses the port; stop it or set `PORT=…` |
| Database errors at start | Read `~/Library/Application Support/ScamShield/server/postgres.log`. Scanning still works without the database: health then reports "degraded" |
| History shows "couldn't be read and was set aside" | The file was corrupt; a copy was kept as `history.corrupt-*.json` and scanning continues |
