# Installing ScamShield on a Mac

Requirements: a Mac with Apple silicon (M1 or newer) and macOS 14 or later. Nothing else to install —
no Node.js, Python or databases. (Intel Macs: not built yet.)

There is no published download yet. When there is, it will be on the project's
[Releases page](https://github.com/naveennt-dev/ScamShield/releases) together with its SHA-256
checksum. Download only from there.

## Verify your download

Open **Terminal** and run `shasum -a 256 ` followed by a space, then drag the downloaded file into the
window and press Return. The long code it prints must match the checksum on the Releases page
**exactly**. If it doesn't, delete the file and don't open it. (Windows: `Get-FileHash <file>` in
PowerShell; Linux: `sha256sum <file>`.)

## Install

1. Open the DMG and drag **ScamShield** onto **Applications**.
2. Open ScamShield from Applications. A shield appears in the menu bar.
   - This preview is signed with the project's own local certificate, **not an Apple Developer ID,
     and not notarized by Apple** yet, so macOS shows that it can't verify the developer. **Only for a copy whose checksum you verified above:** open **System Settings →
     Privacy & Security**, scroll down and click **Open Anyway** next to ScamShield. Don't do this
     for apps from unknown sources in general — notarization is Apple's malware check, and this is
     an exception for a verified copy of this specific app.
3. Choose how scans are analysed: **On this device + AI second opinion** or **On this device only**.
   You can change it later in Settings → Analysis.
4. Scan: menu → **Scan Screen**, **Select Region** or **Scan Link…**. The first screen scan asks for
   the **Screen Recording** permission (System Settings → Privacy & Security → Screen & System Audio
   Recording). ScamShield never records continuously — only when you start a scan.

**AI second opinion:** needs an AI service key. Paste it in Settings → Analysis → *AI service key*;
it is stored only in your login Keychain and given only to ScamShield's own engine.

**Settings → App:** keep the scanner above other windows; open ScamShield when you log in.

**Troubleshooting:** Settings → *Analysis engine* shows whether the engine is running; **Retry**
restarts it. Engine log (no message text): `~/Library/Logs/ScamShield/engine.log`.

**Uninstall:** quit ScamShield and move it from Applications to the Bin. Your history and reports
stay in `~/Library/Application Support/ScamShield` until you delete that folder; the optional AI key
can be removed in Settings first (or in Keychain Access, item "dev.scamshield.mac.ai-key").
