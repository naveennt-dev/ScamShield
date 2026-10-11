# Licence and trademark options — for the owner's decision (2026-10-11)

Not legal advice. No licence has been added; nothing has been published. ScamShield has no
registered trademark that we know of — none is claimed here.

## 1. Code licence options

| Option | Others may | Others must | Community contributions | Fit for ScamShield |
|---|---|---|---|---|
| **Proprietary / all rights reserved** (no licence file = default) | Nothing beyond viewing, if you publish | — | Very few; any outside code needs a contributor agreement (CLA) assigning/licensing rights to you | Maximum control; least trust from security reviewers |
| **Source-available** (e.g. PolyForm Noncommercial, Business Source License) | Read, run, modify for permitted uses | Not compete / not sell | Some; usually needs a CLA | Middle ground; not "open source" by the OSI definition |
| **AGPL-3.0** (strong copyleft) | Use, modify, sell, host | Publish their changes — including when they run it as a web service | Good; contributions stay open | Stops closed-source clones/hosted copies; some companies avoid AGPL |
| **GPL-3.0** | Same as AGPL | Publish changes when they distribute apps (not for hosting only) | Good | Covers desktop/mobile copies, not hosted copies |
| **MPL-2.0** (file-level copyleft) | Combine with closed code | Publish changes to *your* files | Good | Balanced; changes to ScamShield files stay open |
| **Apache-2.0 / MIT** (permissive) | Anything, incl. closed products | Keep notices (Apache: patent grant + NOTICE) | Highest | Anyone may make a closed competitor; Apache adds patent protection |

Notes:
- Every option above can be combined with a separate **trademark policy** — the licence covers the
  code, not the name or logo (Apache-2.0 says so explicitly, §6).
- Re-licensing later is easy only while you are the sole author (or have CLAs from all contributors).
- Third-party components keep their own licences (`THIRD_PARTY_NOTICES.md`, incl. Node.js in the
  macOS engine); the bundled ML training data licences must be checked before choosing.

## 2. Protecting the name and logo (independent of the code licence)

- **Trademark policy file** (e.g. `TRADEMARKS.md`, modelled on Mozilla/Rust/Linux Foundation
  policies): allows truthful references ("works with ScamShield"), forbids using the name/logo for
  modified builds, forks, apps, domains or app-store listings without written permission; forks
  must rename.
- **Official-build verification**: publish checksums and (later) Developer ID / store signatures so
  users can tell genuine builds apart.
- **Registration**: rights in an unregistered name are limited and vary by country. Registration
  (e.g. India Trade Marks Registry, USPTO, EUIPO; classes typically 9 and 42) needs a clearance search
  — ideally by a trademark professional — because "ScamShield" may already be used by others.
- Use "ScamShield™" only if you claim the mark; never "®" unless registered.

## 3. Common combinations

| Goal | Typical choice |
|---|---|
| Keep control, maybe sell later | Proprietary (or source-available) + trademark policy |
| Trust from security community, stop closed clones | AGPL-3.0 (or MPL-2.0) + trademark policy + CLA |
| Maximum adoption | Apache-2.0 + trademark policy |

Decisions needed from you: licence family; whether to require a CLA/DCO; owner name for the
copyright line; whether to commission a trademark search.
