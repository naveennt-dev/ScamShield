# Licence texts shipped with the macOS app

- `lgpl-3.0.txt`, `gpl-3.0.txt` — libvips (via `@img/sharp-libvips-darwin-arm64`), LGPL-3.0-or-later,
  dynamically linked by the image library inside the on-device engine
  (`Contents/Resources/engine/app/node_modules/@img/sharp-libvips-darwin-arm64/lib/`). You may replace
  that library with a compatible build. Source: https://github.com/libvips/libvips (the exact version
  is in `versions.json`, copied next to these files in the app) and the build scripts at
  https://github.com/lovell/sharp-libvips.
- Node.js runtime: `Contents/Resources/engine/NODE-LICENSE`.
- All other components: `docs/release/THIRD_PARTY_NOTICES.md`.
