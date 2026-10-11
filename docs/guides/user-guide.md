# ScamShield user guide

ScamShield checks a message or a link and tells you whether it shows the warning signs of a scam,
why, and what to do. It is a helper, **not a guarantee**: a "no scam signs found" result means none
of the checks found a warning sign — not that something is safe.

> **Never paste passwords, OTPs, PINs, card numbers or API keys into a GitHub issue**, and don't post
> other people's real messages publicly. ScamShield itself keeps what you scan on your device.

**Contents:** [Install](#install-and-first-launch) · [Scan a message](#scan-a-message) ·
[Scan a link](#scan-a-link) · [Understand the result](#understand-the-result) ·
[After a high-risk result](#after-a-high-risk-result) · [Privacy](#privacy-and-data) ·
[Offline vs online](#offline-and-online) · [Troubleshooting](#troubleshooting) ·
[Uninstall](#uninstall) · [Platforms and limits](#platforms-and-limits) ·
[Build from source](#build-from-source)

## Install and first launch

- **macOS** (Apple silicon, macOS 14+): see [Installing ScamShield on a Mac](install-macos.md).
  On first launch, ScamShield asks **"Get an AI second opinion on scans?"** — choose
  **On this device only** or **Turn on AI second opinion**. You can change this later in
  **Settings → Analysis**. The first screen scan asks for macOS's **Screen Recording** permission.
- **Android** (7.0+, test build): see [ScamShield for Android](android.md). No permissions are
  requested.

## Scan a message

**macOS** — click the shield in the menu bar:
- **Scan Screen** (⇧⌘S) reads the text on the screen you are looking at;
- **Select Region** lets you drag around just the message (Esc cancels).

The text is read on your Mac (Apple Vision); the screenshot is discarded immediately. A floating
card shows progress and then the result. You can drag the card by its top edge; it reappears where
you left it.

**Android** — either paste the message into the **Message** tab and tap **Check**, or, in the app
where you received it, long-press the message → **Share** → **Check with ScamShield**: it is
checked immediately.

## Scan a link

- **macOS:** menu → **Scan Link…** → paste the address → **Check link**.
- **Android:** **Link** tab → paste → **Check**, or share a link to ScamShield (a shared bare link
  opens the Link tab automatically).

ScamShield analyses the **address** — look-alike brand names (`amaz0n`, `paypa1`), an official name
placed in front of another site (`paypal.com-account-verify.xyz`), international look-alike
characters, shorteners, risky endings. The link is **never opened in your browser**. (On macOS in the
"AI second opinion" mode, the website may also be contacted — without your cookies or accounts — to
follow redirects and read the page.)

## Understand the result

| Result | Score | Meaning |
|---|---|---|
| **No scam signs found** (green) | 0–29 | None of the checks found a warning sign. Not a guarantee. |
| **Suspicious** (orange) | 30–59 | Some warning signs. Be careful; verify through an official channel. |
| **High risk** (red) | 60–84 | Strong warning signs. Treat it as a scam. |
| **High-risk scam** (red) | 85–100 | Several strong, independent signs. |
| **Unable to assess** (grey) | — | Part of the check failed. This is **not** a safe result — check again or verify yourself. |

Links get a verdict: **No known threat**, **Suspicious**, **High risk**, **Malicious** (on a threat
list, desktop only when configured) or **Inconclusive**.

Every warning lists **why** — the specific signs found (for example *"Asks you to share a one-time
password (OTP)"* or *"amaz0n imitates amazon by changing a character"*) — and **what to do**.
**Why this colour** explains how the score was reached.

## After a high-risk result

1. **Don't** click the link, call the number, reply, install anything or pay.
2. **Never** share an OTP, PIN, CVV or password — no genuine bank, courier or government office asks.
3. If you already acted: call your bank **using the number on your card or its official website**,
   block the card/account, and change passwords.
4. Report it. In India: **cybercrime.gov.in** or helpline **1930**, and *Chakshu* on Sanchar Saathi.
   Elsewhere: your national fraud-reporting service.
5. On macOS you can record feedback on any result in **History** → *Your feedback on this result*:
   *Correct — it's a scam*, *Correct — it's genuine*, *Missed scam — this is fraud*,
   *False alarm — this is genuine* or *Not sure*. Feedback stays on your Mac unless you turn on
   **Share my feedback to improve detection** (off by default).

## Privacy and data

- **What stays on your device:** everything you scan, screenshots (read and discarded, never
  saved), History and feedback.
- **History (macOS):** date, result, score, reasons, website names and — unless you turn off
  **Save the scanned text (numbers masked)** — the text with numbers, e-mail addresses, UPI IDs and
  link paths masked. Kept 7, 30, 90 (default) or 365 days, at most 500 entries. Delete single entries
  or **Clear All** in the History window, or turn off **Keep a history of my scans**.
- **AI second opinion (macOS, opt-in):** needs your own AI service key (stored only in your Keychain);
  sends the masked text (at most 3,000 characters) and the findings — or, for links, only the address
  and findings.
- **Android:** no internet permission, no storage, no backups.
- Full draft notice: [privacy notice](../release/PRIVACY-NOTICE-DRAFT.md) (not yet legally reviewed).

## Offline and online

| | Works offline | Uses the network |
|---|---|---|
| macOS — **On this device only** | All checks | Nothing |
| macOS — **On this device + AI second opinion** | Rules, ML model, link analysis | AI second opinion (masked text); online link checks |
| Android | All checks | Never (no permission) |
| Browser extension | Talks only to the ScamShield engine on your Mac | Nothing else |

## Troubleshooting

| Problem | What to do |
|---|---|
| macOS says it can't verify the developer | The preview isn't notarized yet — see [install guide](install-macos.md). Only open a copy whose checksum matches the published one. |
| "Screen Recording permission needed" | System Settings → Privacy & Security → Screen & System Audio Recording → turn on ScamShield, then quit and reopen it. |
| "Unable to assess" / engine not running | Settings → **Analysis engine** shows the status; click **Retry**. The log (no message text) is in `~/Library/Logs/ScamShield/engine.log`. |
| No text found | Use **Select Region** around the message; make sure it isn't covered and the text is large enough. |
| ⇧⌘S does nothing | Another app may use the shortcut — change it in Settings → Keyboard shortcut. |
| Android: "app not installed" | The test build replaces only an earlier test build; uninstall other ScamShield copies first. |

## Uninstall

- **macOS:** see [install guide → Uninstall](install-macos.md).
- **Android:** long-press the ScamShield icon → **Uninstall** (or Settings → Apps → ScamShield →
  Uninstall). The app stores nothing else.
- **Extension:** `chrome://extensions` (or `edge://extensions`) → ScamShield Link Guard → **Remove**.

## Platforms and limits

| Platform | Status |
|---|---|
| macOS (Apple silicon, 14+) | Built and tested; **not notarized** yet; no Intel build |
| Android (7.0+) | Test build, tested on an Android 15 emulator; not yet on physical phones; not on Google Play |
| Chromium extension | Unpacked, Chrome/Edge, needs the macOS app |
| Windows, Linux desktop, iPhone/iPad | Not available yet |

ScamShield cannot read images without text, voice calls or content you don't scan, and it can miss
new scam styles or flag genuine messages. Accuracy was measured on test sets written for this
project ([evaluation](../ml/evaluation.md)), not real-world traffic.

## Build from source

- macOS app and DMG: [`macos/README.md`](../../macos/README.md) and
  `macos/scripts/build-app.sh` / `build-dmg.sh` (Apple silicon, Xcode 26 or the Command Line Tools
  with the macOS 26 SDK).
- Android test APK: [ScamShield for Android → Build](android.md#build).
- Web app / API: [development guide](../development.md).
