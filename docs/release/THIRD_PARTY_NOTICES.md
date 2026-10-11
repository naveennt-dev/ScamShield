# Third-party notices (to ship with any ScamShield release)

Generated from the audit of 2026-10-11 (`docs/release/sbom-npm-runtime.cdx.json`,
`docs/release/python-ml-requirements.lock.txt`). Runtime npm dependencies are MIT / Apache-2.0 /
ISC / BSD except the items below; Python ML dependencies are BSD / MIT / Apache-2.0 / PSF / MPL-2.0
(no GPL). Each package's own licence text is in its directory under `node_modules/` or the Python
environment and must accompany a binary distribution.

| Component | Licence | Obligation |
|---|---|---|
| `@img/sharp-libvips-darwin-arm64` 1.3.4, `@img/sharp-wasm32` 0.35.5 (libvips, via Next.js image optimisation) | LGPL-3.0-or-later (libvips) | Dynamically linked and replaceable. The LGPL/GPL texts, the package README and `versions.json` ship in the app at `Contents/Resources/engine/licenses/`; source: https://github.com/libvips/libvips, build scripts: https://github.com/lovell/sharp-libvips. |
| `caniuse-lite` 1.0.30001706 (browser support data, build tooling) | CC-BY-4.0 | Attribution: "caniuse-lite — data from caniuse.com, CC BY 4.0". |
| UCI SMS Spam Collection (training data for the ML model; 723 messages redistributed in `ml/datasets/processed/test.jsonl`) | CC BY 4.0 | Almeida, T. & Gómez Hidalgo, J. (2011), "SMS Spam Collection", UCI Machine Learning Repository, https://doi.org/10.24432/C5CC84. Changes: subset selected, labels mapped, one private phone number removed — see `ml/datasets/README.md`. |

Model weights (`ml/models/scam_classifier.json`) were trained by this project on the synthetic data
in `ml/datasets/raw/synthetic/` and the UCI corpus above.

ScamShield's own licence: **not yet chosen** (no `LICENSE` file) — a release blocker; see the audit report.
