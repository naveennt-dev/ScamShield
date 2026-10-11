# Installing ScamShield on a Mac

Requirements: a Mac with Apple silicon (M1 or newer) and macOS 14 or later. Nothing else — no
Terminal, Node.js, Python or databases. (Intel Macs: not built yet.)

1. Open `ScamShield-<version>.dmg` and drag **ScamShield** onto **Applications**.
2. Open ScamShield from Applications. A shield appears in the menu bar.
   - This preview is **not notarized by Apple** yet. If macOS says it can't verify the developer,
     open **System Settings → Privacy & Security** and click **Open Anyway** next to ScamShield.
     Only do this for a copy whose SHA-256 matches the published checksum.
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
