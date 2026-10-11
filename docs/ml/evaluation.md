# Evaluation

Model `scam-tfidf-logreg 1.1.0+20261007.906379c2`. Reports:
`ml/evaluation/reports/<build>-test.{json,md}` (ML model) and
`ml/evaluation/reports/system-<build>.{json,md}` (full local engine).

> **No production-quality claim.** The scam-domain data is hand-written and small (13 scams in the
> test split). The real-world part (UCI SMS) measures behaviour on genuine conversation, not scam
> detection. Treat every number below as a pipeline/behaviour check, not real-world accuracy.

## 1. ML model alone — held-out test split (`npm run ml:evaluate`)

Overall (755 rows): accuracy 0.967, macro precision/recall/F1 0.882 / 0.889 / 0.883 —
**dominated by easy UCI rows; read the per-source table instead.**

| source | rows | accuracy | notes |
|---|---|---|---|
| synthetic (domain) | 32 | **0.719** | 2 scams predicted safe (both Hindi), 3 safe flagged |
| UCI ham (real conversational SMS) | 641 | 0.992 | false-positive rate **0.78 %** (5/641) |
| UCI spam (weak "suspicious" label) | 82 | 0.866 | 10 called safe |

Per class: safe P/R 0.976/0.988 · suspicious 0.937/0.831 · scam **0.733/0.846** (13 test scams).
Confusion (rows true, cols predicted; safe/suspicious/scam): `[645,5,3] [14,74,1] [2,0,11]`.

Explicit error counts: false negatives (scam not labelled scam) **2**, both labelled **safe**
(`scamMissedAsSafeRate` 0.154 on 13 scams); false positives (safe flagged) 8 of 653 (1.2 %).

Both missed scams are Hindi (OTP request; "earn from home + registration fee") — Hindi is barely
represented in training. The rule engine catches both (see §2).

## 2. Full local engine — rules + ML + static URL analysis (`npx tsx scripts/evaluate-system.ts`)

LLM disabled, no network, embedded model (same maths as the service), 0.7 ms/message.

| source | rows | system accuracy | scam recall | scam → safe | safe FPR | ML-only scam → safe | ML-only safe FPR |
|---|---|---|---|---|---|---|---|
| synthetic | 32 | 0.688 | 0.769 | **0** | 0.25 (3/12) | 2 | 0.25 |
| UCI ham | 641 | 0.994 | – | – | **0.62 %** (4/641) | – | 0.78 % |
| UCI spam | 82 | 0.610 | – | – | – | – | – |

- The safety principle works on this data: **no scam reached SAFE** with rules + ML, versus 2 for
  ML alone; remaining scam misses land in SUSPICIOUS (still a warning).
- The 3 synthetic false positives are all ML-only (no rule fired): an SBI card statement, a
  DigiLocker new-device notice, a Hindi deposit alert. After this evaluation we added the
  *uncorroborated-ML cap* (ML alone can reach SUSPICIOUS, not HIGH/CRITICAL) — a policy change
  **motivated by inspecting these test errors**; we deliberately did not add training data targeted at
  them (that would leak the test set).
- UCI spam: the fused engine calls 32/82 safe (ML alone 10/82) — with no rule firing, the ML signal
  is confidence-weighted and partly outvoted. Acceptable for generic marketing spam; it shows the
  engine is conservative about warning without deterministic evidence.

### Scenario suite (`ml/datasets/eval/scenario_suite.jsonl`) — 25/25

7 safe (incl. genuine bank alert, OTP notice, Hindi OTP notice, Hinglish chat), 9 scams (KYC, UPI,
refund, job, lottery, investment, delivery, government, bank alert), 9 adversarial (Hindi/English
mix, Hinglish OTP request, misspellings, zero-width + Cyrillic look-alikes, defanged URL, excessive
whitespace, urgency spam, prompt injection, safety advice full of scary words). The suite was written
by the same author as the rules, so it demonstrates intended behaviour rather than independent accuracy.

## 3. Calibration

| probabilities | Brier | ECE (5 bins) | mean confidence | accuracy |
|---|---|---|---|---|
| raw LR (weighted, C = 0.5) | 0.358 | 0.430 | 0.52 | 0.952 |
| **served: sigmoid, fitted on validation** | **0.062** | **0.022** | 0.94 | 0.967 |

Raw probabilities were badly under-confident (heavy regularisation + sample weighting), which would
have muted the ML signal in the confidence-weighted fusion, so calibrated probabilities are served
(`model_manifest.json → probabilityType: calibrated-sigmoid-on-validation`). With 755 test rows (13
scams) these estimates are noisy, and calibration holds only for data resembling this distribution:
**`probability: 0.94` is a model confidence score, not a guaranteed 94 % real-world probability.**

## 4. History (why the data is mixed)

The first model trained only on 178 synthetic rows flagged **47 %** of 4 827 real UCI ham messages
as not-safe (33 % as scam) — synthetic "safe" examples were formal notifications, so casual real
texting looked alien. Adding UCI data (ham = safe) fixed that (FPR < 1 %) but initially drowned the
Indian domain (genuine "Not you? Call 1800…" alerts became suspicious), which per-source weighting
and calibration addressed.

## 5. Detection evaluation sets (2026-10-11)

Full local engine (rules + ML + URL checks, no AI, no network), via the screen path the Mac uses
(`npx tsx --env-file=.env scripts/eval-realistic.ts <file>`). All sets are **synthetic, written for
this project**; they are never trained on. They measure coverage and regressions, not real-world
accuracy.

| set | written | scams caught | genuine flagged |
|---|---|---|---|
| `realistic-v1.jsonl` (28 scam / 22 genuine) | corrective round; rules were tuned on it | 28/28 | 0/22 |
| `heldout-v2.jsonl` (69 / 59), SHA-256 `9f0079f6…81f0d6` | written **before** this round's rules; baseline then 63/69 and 12/59 | 68/69 | 5/59 |
| `blind-v3.jsonl` (50 / 50), SHA-256 `8cde80a7…c44343` | written after the rules were frozen; **first (blind) run: 41/50 and 4/50** | 50/50 *after fixes* | 1/50 *after fixes* |

The honest blind figure is the **first v3 run: 82 % of scams caught, 8 % of genuine messages
flagged**. The v3 failures were then used to fix general weaknesses (extortion without explicit
words, Hinglish verb-final money requests, "need gift cards", water-supply threats, macro
documents, safety tips quoting OTP/PIN), so v3 is no longer blind. A new blind set is needed for the
next measurement.

UCI genuine-SMS false-positive rate (641 held-out messages): 0.62 % → **0.47 %**. Scenario suite:
25/25. UCI spam (unsolicited marketing, weak "suspicious" label) warned on: 57 %.

Still-flagged genuine messages are mostly ML-only bill/payment reminders that ask the reader to pay
(the ML model is trained largely on SMS spam). Missed: a fake shop asking for advance payment.

## 6. What a credible evaluation still needs

1. A real, labelled, consented/public corpus of Indian SMS/WhatsApp scams and genuine notifications
   (English, Hindi, Hinglish) with a time-based test split.
2. Threshold calibration on that validation set (currently hand-set 30/60/85).
3. OCR-in-the-loop evaluation (screenshots → Vision → engine).
4. Monitoring of user-confirmed misses after deployment.
