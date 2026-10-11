# Manual Verification — Scanner Window & Remote-AI Privacy

## 1. Drag the scanner card

1. Start the services: `scripts/local-stack.sh start`. Open the app:
   `open macos/build/ScamShield.app`.
2. Click the shield in the menu bar, then **Scan Screen**. A card appears. (If Screen Recording
   isn't granted, it shows a permission message; that's fine for this test.)
3. Press on the **top edge** of the card (above the icon), or on the **round icon / shield logo**,
   and drag. The card should follow the pointer smoothly.
4. Run another scan. The card should stay where you put it through the scanning stages and the
   result.
5. Click **✕**, then scan again. It should reappear in the same spot. (After quitting the app, it
   starts centred again; the position is remembered per session.)
6. Optional, to see the evidence:
   ```
   /usr/bin/log show --last 10m --style compact \
     --predicate 'subsystem == "dev.scamshield.mac" AND category == "window"'
   ```
   Each drag shows `scanner drag began …` and `scanner drag ended (mouse up): origin A → B`.

Also check:
- Pressing ✕ and moving the mouse doesn't move the card.
- Dragging doesn't take typing focus from the app you were in.
- The small menu-bar popup stays attached to the icon.

## 2. Local-only mode (the default)

1. Settings (menu → Settings…) → **Analysis**: "On this device only" is selected (after choosing it in the consent window), with the
   green "Local-only: nothing leaves this Mac". The menu popover says **Local-only analysis**.
2. Turn Wi-Fi off. Scan a message on screen (for example the KYC text from the web demo). You get a
   result, and the card says **"Checked on this device only."**
3. Automated version of the same test: `scripts/offline-check.sh`. Turn Wi-Fi off when it says
   "Waiting…", don't touch the Mac, and turn Wi-Fi on when it says "Turn the network back on".
   Expect `OFFLINE CHECK PASSED`.

## 3. Remote-assisted mode (optional)

1. Put your key in `.env` (`OPENROUTER_API_KEY=…`) and set free models:
   `SCAM_PRIMARY_MODEL=google/gemma-4-31b-it:free`,
   `SCAM_FALLBACK_MODEL=nvidia/nemotron-3-super-120b-a12b:free`.
   Never commit the key.
2. Restart the services with the server-side switch:
   `scripts/local-stack.sh stop && SCAMSHIELD_REMOTE_AI=1 scripts/local-stack.sh start`.
   Health shows `'llm': 'opt_in'`.
3. In Settings → Analysis, choose **"On this device + AI second opinion"**. The orange notice and
   the menu's **Remote AI assist on** confirm it.
4. Scan. The card says "Checked on this device + AI second opinion.", or "AI second opinion not used (reason)
   — on-device result" if the model is offline, busy or not free.
5. To turn it off, choose "On this device only" again. The next scan sends nothing. Restarting the
   services without `SCAMSHIELD_REMOTE_AI=1` also disables it on the server.

What is sent in remote mode:
- **Sent:** the scan's text, with links shortened to their domain, numbers, e-mails, UPI IDs and
  keys masked, up to 3,000 characters.
- **Never sent:** images.

## 4. Scan history (Phase 5)

1. Scan a message with a link (Scan Screen). On a warning card, click **Details & report…**, or
   open **menu → History…** (⌘Y).
2. The entry shows the result, score, type, **Why**, website names and "Checked on this device only".
   It shows no message text unless you turned on the excerpt.
3. Open `~/Library/Application Support/ScamShield/history.json` in a text editor. You'll find no
   message text, no OTPs and no full links. Run `ls -l` on it: `-rw-------`, readable only by you.
4. Use **Scan again** on the same message within 2 minutes. It updates the entry instead of adding
   a new one.
5. Right-click an entry → **Delete**, or use the toolbar **Clear All**. A confirmation appears;
   after confirming, the list is empty, including after relaunching.
6. With nothing selected, the right pane shows the settings: history on/off, the optional
   redacted excerpt (off by default) and the retention period.

## 5. Report a result (local only)

In an entry, choose **It's a scam**, **It looks suspicious** or **ScamShield got it wrong**. The
text below the buttons explains what is stored. The report appears as a flag in the list, is saved
in `reports.json` next to the history, and is never uploaded. Use **Remove my report** to delete
it.

## 6. URL intelligence and the local intelligence database

- Scan text containing `indiapost-redelivery[.]top/pay`. The link is flagged as written in a
  disguised form, and the reasons say "reputation is unknown (not a confirmed scam site)".
- Import a list you are allowed to use:
  `npm run intel:import -- my-list.csv --source imported --dry-run`. Remove `--dry-run` to write it.

  The CSV needs the columns `kind,value,status,category,confidence,explanation[,expiresAt]`.
  Invalid rows are rejected and reported by row number.
- Remove expired records: `npm run intel:prune`.
- Check migration safety on a throw-away database: `npm run db:verify-migrations`.

## 7. Install, upgrade, restart and uninstall (Phase 6)

1. `scripts/install.sh`. It ends with "Done", the bundle check reports no secrets, and the app is
   at `~/Applications/ScamShield.app`.
2. `scripts/scamshield.sh start`. Status `ok`; the menu-bar shield appears.
3. Open the app again (Spotlight or Finder). The existing menu opens and no second shield appears.
4. Menu → Scan Screen on a test message. The card says "Checked on this device only."
5. ⌘Q (or menu → Quit), then `scripts/scamshield.sh start` again. History is still there.
6. Upgrade: run `scripts/install.sh` again. History, reports and settings are unchanged. With the
   signing certificate, no Screen Recording prompt appears.
7. `scripts/scamshield.sh stop`, then `scripts/scamshield.sh status`: everything is down.
8. Optional: `scripts/uninstall.sh` removes only the app. Your data stays until you run it with
   `--delete-user-data` and type `DELETE`.

## 8. Checking real scans after the corrective fix

1. Show a **scam message** on screen, then menu → **Select Region** and drag around just the
   message.
   - **Expect:** a warning card (Suspicious or HIGH RISK) with "Why" reasons taken from the message
     (e.g. "Asks you to share a one-time password").
2. **Scan Screen** with the same message visible. It should also warn; the card notes "The screen
   contained N separate text areas; this result is for the riskiest one".
3. A **genuine message** (chat, bank debit alert) should come out:
   - **"No suspicious content detected"** when nothing at all was found; or
   - **"Low risk — a few weak signs"**, listing the signs, with the score shown.
4. Cover the screen with an empty window and use Select Region on a blank area.
   - **Expect:** "Unable to assess" (never Safe). History records it as incomplete.
5. History (⌘Y):
   - the newest entry shows the same level and score as the card, plus "Scanned: Selected region /
     Full screen", the scan ID, and "Scanned text: Not stored";
   - reports offer "It's a scam" for safe results and "Not a scam (false alarm)" for warnings.
6. Settings: it re-checks the service as soon as it opens ("Last checked …"), and **Components**
   lists live status.
   - **Test:** stop the services (`scripts/scamshield.sh stop`) and reopen Settings. It says
     "Nothing is answering at http://127.0.0.1:3000…".
7. **Diagnostics without any message text:**
   `/usr/bin/log show --last 10m --predicate 'subsystem == "dev.scamshield.mac" AND category == "scan"'`
   shows each scan's ID, capture size, OCR character count and result.

## 9. Production-readiness round (2026-10-11)

1. **AI consent (first launch):** a window "Get an AI second opinion on scans?" appears once. "On this
   device only" keeps everything local; "Turn on AI second opinion" sends only the masked text of the
   scanned area. Settings → Analysis shows and changes the choice.
   **Unable to assess:** stop only the ML service (`kill` the `inference/service.py` process) with the
   AI second opinion off, and move the embedded model aside; a scan of a harmless text then shows
   "Unable to assess", never green. (Covered automatically by `tests/unit/local-plus-remote.test.ts`.)
2. **Why this colour:** every result card has one line under the reasons ("Red: final score …/100 is
   at or above the high-risk line (60) — …"). History → an entry → "Why this colour" lists each
   matched rule with the words that matched, the ML estimate, each link, the AI opinion (labelled
   as AI) and any safety adjustment.
3. **Scanned text in History:** saved by default with numbers, e-mails, UPI IDs and link paths
   masked; History → settings panel → "Save the scanned text" turns it off.
4. **Feedback:** History entry → Report → Correct / Missed scam (green results) / False alarm
   (warnings) / Not sure.
5. **Optional sharing:** History → settings panel → "Share my feedback to improve detection" (off by
   default). With it on, feedback + masked text goes to the local API (`Contribution` table,
   quarantined). Turning it off deletes anything queued.
6. **No sample data:** the menu has no PREVIEW section and production builds contain no sample
   texts (`strings ~/Applications/ScamShield.app/Contents/MacOS/ScamShield | grep -c "Dear SBI"` → 0).

## 10. Link protection (2026-10-11)

1. **Scan Link (Mac):** menu → **Scan Link…** → paste `hxxps://paypa1-secure-login[.]top/verify` →
   **High risk**, page "not inspected" in on-device-only mode, "Nothing left this device".
2. **Online scan:** with the AI second opinion on, paste a YouTube video link → "Official YouTube
   page", **No known threat detected** with "not a guarantee", coverage table, and the list of what
   left the device (the website was contacted by the inspector; the AI got only the address).
3. **Inspect page behaviour…** (same link): progress stages, **Cancel** works and says nothing was
   marked safe; a completed inspection shows requests, typed-data result, downloads, permissions.
   Settings → Analysis → "Offer Inspect page behaviour" off hides the button.
4. **History:** link scans appear as "Link" entries storing only the masked address.
5. **Extension:** load `extension/chromium` unpacked (see its README), open a page you trust (no
   interruption), then a known-bad test address you control → the warning page; **Go back to
   safety** returns to the previous checked page.

