# Shared learning, model improvement & URL intelligence — design

Status as of 2026-10-11. Every component below is marked **Runs** (implemented and exercised on
this Mac), **Interface only** (code + tests exist, but the infrastructure it needs is not deployed)
or **Not built**.

## 1. Scan pipeline (one scan ID end to end)

```
capture (region / full screen, on demand only)
  → on-device OCR (Apple Vision; image never leaves the Mac, never stored)
  → local analysis on 127.0.0.1 (rules · ML · URL heuristics · scam intelligence)
  → URL intelligence (reputation providers, cached)
  → remote AI second opinion  — only with the user's consent, masked text only, free models only
  → risk fusion (rules/URL floors, ML caps, nothing-asked gate, remote-never-lowers)
  → decision explanation ("why green / orange / red")
  → result card + History (same scan ID; text masked)
```

The scan ID is created by the Mac app and travels as `X-Request-Id` to the API and the ML service.

## 2. Local + AI second opinion together, with local fallback (Runs)

Implemented in `src/lib/detection/pipeline.ts`, not only in Settings; proven by
`tests/unit/local-plus-remote.test.ts` (26 tests) and the Mac `AssessmentTests`.

1. Every scan runs the full local pipeline first: rules, the installed ML model, URL intelligence.
2. When the AI second opinion is on and the service has it enabled, the same scan (same request
   ID) is also sent — masked — to the remote model, with the local findings as hints.
3. The risk engine fuses both. The remote verdict can raise the score; it can never lower the
   local result (`remote-never-lowers` in `risk-engine.ts`).
4. Remote unavailable, offline, rate-limited, misconfigured, invalid answer (malformed/schema),
   circuit open, budget exhausted, or no answer at all → the local result, with a notice. A hard
   deadline (`OPENROUTER_TOTAL_BUDGET_MS` + 2 s, 27 s by default) caps the wait even if the
   provider hangs; the Mac client gives up at 35 s.
5. **Unable to assess:** if nothing suspicious was found but a detector failed — the ML model was
   unavailable and there was no AI opinion, or a rule errored — the result carries
   `assessment.status = "insufficient"`. The Mac app shows "Unable to assess" (and History records
   it as not assessed); the website shows a grey "Unable to assess". It is never shown green. If
   the rules found something, the warning is still shown.
6. Local-only is an explicit choice (consent window or Settings); "On this device + AI" is the
   default for new installs. Until the consent window is answered, nothing is sent.
7. Results and evidence are stored on the device per the History settings. Nothing is uploaded for
   training automatically.

### Inference is not training
Every scan only *uses* the installed model (`ml/models`, SHA-256-verified at load). Scans, reports,
feedback and AI verdicts never change it (a test checks the model files are untouched by scans).
Training is a separate manual workflow (§6) that writes a candidate; the installed model keeps
working if training fails. Training data from users comes only from opt-in contributions that a
human reviewer marked ACCEPTED — agreement between users or an AI verdict is never treated as
verified ground truth (unreviewed rows go to `ml/datasets/review/`, which training does not read).

### When could the local model replace the AI second opinion?
Not now. It should only be considered when, on a **representative, independently labelled** test
set (not written by the rule author; real SMS/WhatsApp/e-mail/screen text; English, Hindi,
Hinglish; ≥ 1,000 messages, time-split after the training data), the local engine alone reaches:
scam recall ≥ 95 % overall and ≥ 90 % in each language and major scam family, false-positive
rate ≤ 1 % on genuine messages, and no worse recall than local + AI on the same set. No such test
set exists yet; the current sets are synthetic (`docs/ml/evaluation.md` §5).

## 2b. Remote AI default and consent (Runs)

- New installations default to **"On this Mac + AI second opinion"**, but nothing is sent until the
  user answers the one-time consent window. Until then — and if they choose "On this Mac only" —
  `effectiveAnalysisMode` is `local`. Environment variables and Info.plist cannot switch it on.
- What is sent: the text of the scanned area after `minimizeForRemote` — link paths/queries
  removed (also for links written without `https://`), 4+ digit runs, e-mail local parts, UPI IDs
  and keys masked, at most 3,000 characters. Never images, History or other windows.
- Free-tier OpenRouter models only (`OPENROUTER_REQUIRE_FREE_MODELS=true`, no paid fallback). User-facing
  copy does not name the provider or the pricing tier, and the model ID is not shown in results. The API key
  stays in `.env`; `scripts/local-stack.sh` checks it is present without printing it.
- The AI verdict can raise the risk but never lower the on-device result; it is labelled "AI second
  opinion (<model>)" in the explanation.

## 3. Decision explanation (Runs)

`src/lib/detection/decision.ts` builds `result.decision` from the computed evidence only:
`why` (colour, final score, the threshold crossed), `basis` (rules, ML — "a model estimate, not
proof" — each link, the AI opinion, every safety adjustment) and `matches` (each matched rule with
the masked words that matched). The Mac card shows `why`; History shows all of it.

## 4. Feedback (Runs, local)

Four options per History entry: **Correct**, **Missed scam** (green results), **False alarm**
(warnings), **Not sure**. Stored only in `reports.json` (0600). Older reports are migrated on read
(`scam`/`suspicious` → correct or missed scam; `false_positive` on a green result → missed scam, as
the old "ScamShield got it wrong" button meant). Feedback never modifies model weights.

## 5. Shared learning

| Component | Status | Where |
|---|---|---|
| Opt-in sharing setting (off by default), outbox (0600), retry on launch | Runs | `ContributionOutbox.swift`, History → settings panel |
| Ingestion API `POST /api/v1/contributions` | Runs on the local API (`CONTRIBUTIONS_ENABLED=true` set by `local-stack.sh`) | `src/app/api/v1/contributions`, `contribution-service.ts` |
| Server-side re-masking, schema validation (strict, ≤2,000 chars), quarantine, per-(message, installation) dedupe, rate limits (`contribute` scope) | Runs | same |
| Poisoning flags: prompt-injection text; "safe" label on an OTP/PIN/password request | Runs | `contributionFlags` |
| Curation: only reviewer-ACCEPTED rows become training data; rows with ≥2 distinct contributors and ≥80% agreement go to a review queue; unreliable-contributor removal; per-contributor cap max(10, 5%) | Runs (script) | `contribution-curation.ts`, `scripts/curate-contributions.ts` |
| Training writes a **candidate** only | Runs | `npm run ml:train` → `ml/registry/candidates/next` |
| Evaluation gate vs the active model (3 fixed sets + UCI genuine SMS) + model card | Runs | `src/lib/ml-registry/gate.ts`, `npm run model:registry -- gate` |
| Ed25519-signed releases, pinned public key, verified atomic install, rollback | Runs (local releases and HTTP(S) URLs) | `src/lib/ml-registry/*`, `scripts/model-registry.ts` |
| **Central** contribution server shared by many users | **Not deployed** | The same API can be deployed; the Mac app sends to the API it is connected to (by default this Mac). |
| **Hosted** model distribution (release URL clients poll) | **Not deployed** | `model:registry install <https-url>` works against any static host; no host or automatic polling exists. |
| Human review UI for quarantined contributions | **Not built** | Rows can be set ACCEPTED/REJECTED in the database. |

### Privacy of contributions
Only after opting in, and only for entries whose text was saved. Sent: masked text, verdict, the
result's level/score/category, app version, a random installation UUID (stored server-side only as
a SHA-256). Not sent: screenshots, History, local IDs, account data. Turning sharing off deletes the
queue.

### Poisoning defences — and their limits
Quarantine + consensus + reliability + caps + rate limits + gate make a single installation unable
to change a model. **Limit:** many coordinated installations ("sock puppets") agreeing on false
labels could pass consensus; the evaluation gate (no regression on fixed sets) is the last line of
defence, and a human decides every release.

## 6. Model registry & signed distribution (Runs)

```
npm run ml:train                                    # candidate → ml/registry/candidates/next
npm run model:registry -- keygen                    # once; private key in ~/Library/Application Support/ScamShield/keys (0600)
npm run model:registry -- gate ml/registry/candidates/next
npm run model:registry -- release ml/registry/candidates/next
npm run model:registry -- install ml/registry/releases/<buildId>   # or https://…/<buildId>/
npm run model:registry -- rollback
scripts/scamshield.sh restart                       # load the installed model
```

Install refuses: a bad signature or a different key, a release whose gate failed, any file whose
size/SHA-256 differs, unsafe file names, a model manifest that disagrees with the signed list, and
plain-HTTP URLs other than loopback. The swap is two renames on one disk; the previous model is kept
(3 backups); a rolled-back model is never restored automatically.

Verified on this Mac (2026-10-11): candidate trained → gate passed → signed → tampered copy refused
(active model unchanged) → installed from a directory and over loopback HTTP → rolled back; the
original model files were restored byte-identical (SHA-256 checked).

## 7. URL intelligence (Runs)

Each link in a result has `url`, `hostname`, `registrableDomain`, `riskScore`, `flags` (static
heuristics: brand look-alikes, risky TLDs, shorteners, IPs, encodings…), `reputation`
(`confirmed_malicious` / `suspicious` / `benign_reports` / `unknown`) and
`intel { checked, checkedBy, sources, evidence, confidence, lastUpdated }`.

- `checked: false` means no reputation source could be consulted (database down / none configured):
  the explanation then says "reputation not checked", never "clean".
- `unknown` with `checked: true` means "no record" — explicitly *not* evidence of safety.
- `benign_reports` never becomes a risk signal.
- Providers implement `DomainReputationProvider` (`lookup` rejects when it cannot check). Built in:
  ScamShield's own intelligence database (`internal-reports`). Answers are cached 5 minutes per
  provider and domain.
- **No external threat feed is bundled or enabled.** No unverified threat list is shipped. A
  third-party feed (e.g. a Safe Browsing-style API) can be added as a provider; its licence and
  terms must be checked before use, and none was added here (no paid services).

## 8. Data sources and licensing

| Data | Use | Licence / origin |
|---|---|---|
| Synthetic handwritten scam/genuine messages (v1–v3) | ML training | Written for this project |
| UCI SMS Spam Collection | ML training + genuine-SMS false-positive check | CC BY 4.0 (Almeida & Hidalgo) |
| `tests/fixtures/eval/realistic-v1.jsonl`, `heldout-v2.jsonl`, `blind-v3.jsonl` | Evaluation / gate only (never trained on) | Written for this project |
| User contributions | Future training, after curation | The users' own masked feedback (opt-in) |
