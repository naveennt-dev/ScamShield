# Security policy

ScamShield handles people's messages and links, so we take security reports seriously.

## Reporting a vulnerability — privately, please

**Do not open a public issue for security problems.** Use GitHub's private reporting:
repository **Security** tab → **Report a vulnerability** (GitHub "private vulnerability reporting").

Please include: affected component (macOS app, on-device engine, Android app, browser extension,
web service), version or commit, steps to reproduce, and the impact you expect. Don't include real
people's messages or personal data — synthetic examples are enough.

We aim to acknowledge reports within 7 days and will tell you what we plan to do. This is a small
project with no bug-bounty programme. Please give us a reasonable time to fix an issue before
disclosing it publicly; we are happy to credit you.

## In scope

Anything that could expose a user's scanned text, History, API keys or files; make the app send
data off the device without consent; let a web page, link or message execute code or reach local
services (SSRF, DNS rebinding, injection into the AI prompt); weaken the link scanner's isolation;
or tamper with model updates or release artefacts.

## Out of scope

Scam messages that the detector misses or wrongly flags — please report those as a normal issue
using the "Detection problem" template (with synthetic or redacted text). Detection is probabilistic
and never 100% accurate.

## Supported versions

Only the latest commit on `main` and the latest published release (when releases exist) receive
security fixes.
