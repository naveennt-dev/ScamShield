# Rule Engine & Local Risk Engine

Code: `src/lib/detection/` — `rules/*.ts` (one module per scam family), `rule-engine.ts`,
`risk-engine.ts`, `thresholds.ts`, `types.ts`.

## Design principles

1. **Signals, not verdicts.** A rule never decides "scam". It emits structured evidence; the risk
   engine combines it with ML and link analysis.
2. **Intent, not keywords.** No `contains("KYC") ⇒ scam`. Rules look for a *request* near a
   sensitive object ("share … OTP"), a *threat* with a *deadline*, a *fee* tied to a *job/parcel*, etc.
   "Your KYC has been successfully updated" scores 0 (tested).
3. **Negation-aware.** "Never share your OTP", "Do not share it with anyone", Hinglish "share na
   karein / kisi ko mat batao", Hindi "साझा न करें / मत बताइए" do not fire (negation before *or*
   after the verb).
4. **Sentence-bounded.** Proximity gaps stop at `. ! ?`, newlines and the Devanagari danda `।`.
5. **Narrow exceptions are explicit** (e.g. in-person delivery OTPs; UPI handles like
   `zomato@icici` are not bank-brand claims).

## Output

```ts
{ ruleId: "cred.otp_request", category: "credential_theft", severity: "high",
  evidence: "…share the otp you received with our executive…",   // digits masked
  weight: 0.55, description: "Asks you to share a one-time password (OTP)…" }
```

`weight` (0–1) is the rule's contribution to a noisy-OR score:
`rules.score = 100 × (1 − Π(1 − weightᵢ))` — independent indicators accumulate with diminishing
returns and never exceed 100. Rough intent: one high-severity dangerous request ≈ 50–65; weak
tactics (urgency, fear, link pressure) 0.10–0.15 each; combos add 0.2–0.35 when tactics co-occur.
**All weights are hand-set starting points**, to be tuned on a labelled validation set.

## Rule families (59 rules + 5 combos)

| module | rules | detects (EN / Hinglish / Hindi) |
|---|---|---|
| `otp.ts` | `cred.otp_request`, `cred.pin_request`, `cred.card_details`, `cred.password_request`, `cred.identity_documents` | share OTP / "OTP batao, bhej do" / "ओटीपी बताइए"; PIN, CVV/card, passwords, Aadhaar/PAN copies |
| `kyc.ts` | `kyc.urgent_update` | KYC + expiry/suspension/deadline; "केवाईसी समाप्त…" |
| `banking.ts` | `bank.account_threat`, `bank.impersonation_cta` | account/card/SIM will be blocked; "account band ho jayega"; "खाता बंद कर दिया जाएगा"; bank brand + call/click |
| `payment.ts` | `pay.advance_fee`, `pay.money_request`, `upi.pin_to_receive`, `upi.refund_bait`, `upi.collect_or_qr` | processing/clearance fees; "enter PIN to receive" / "receive karne ke liye UPI PIN daaliye"; refund/cashback bait; scan QR / approve collect to *receive* |
| `lottery.ts` | `prize.winner_claim` | won a lottery/lucky draw; "lottery jeeti hai"; "लॉटरी जीती" |
| `job.ts` | `job.fee_required`, `job.easy_money_tasks` | job + registration/training fee; "ghar baithe … kamaiye"; "घर बैठे … रजिस्ट्रेशन फीस" |
| `investment.ts` | `invest.guaranteed_returns`, `invest.crypto_trading_promise` | guaranteed/daily % returns, "double your money / paisa double karo", crypto/VIP groups |
| `impersonation.ts` | `gov.impersonation_threat`, `tech.remote_access`, `tech.fake_virus_alert` | police/CBI/court/TRAI + arrest/FIR/digital arrest (EN + Hindi); AnyDesk/TeamViewer (either word order) |
| `delivery.ts` | `delivery.held_parcel` | parcel held/customs + pay/click/update |
| `loan.ts` | `loan.instant_offer`, `loan.recovery_harassment` | instant/no-CIBIL loans + fee ("bina CIBIL"); threats to share photos/contacts |
| `romance.ts` | `romance.money_plea` | affection + emergency/gift + money |
| `malware.ts` | `malware.app_install`, `malware.enable_macros` | `.apk/.exe` files, "install this app from the link"; "enable macros/content to view the invoice" |
| `utility.ts` | `utility.disconnection_threat` | electricity/gas/water/SIM "will be disconnected tonight" (EN / Hinglish / Hindi), not scheduled maintenance |
| `personal.ts` | `person.new_number_money`, `person.secret_money_request`, `pay.gift_card_request`, `extortion.intimate_content`, `pay.wrong_transfer_return`, `charity.direct_upi_donation`, `shop.advance_payment_only`, `cred.wallet_seed_phrase` | family/friend on a new or borrowed number asking for money ("dusra number… 7000 paytm kar do"); "don't call/tell"; gift-card codes; "pay or I send the video to your family"; "sent by mistake, return it"; donations to a personal UPI; advance-only sellers; seed phrases / "connect wallet to claim" |
| `account.ts` | `account.deletion_threat`, `refund.bank_details_bait`, `rewards.points_expiry`, `account.mailbox_full`, `tech.subscription_refund_call`, `tech.call_support_scare`, `insurance.lapse_threat`, `job.task_deposit`, `invest.private_group_tips` | "account will be deleted — appeal", refund/subsidy needing bank details, reward points expiring, mailbox full, "renewed for $499 — call to cancel", "PC infected — call support", policy lapsing, task-scam deposits, paid VIP tip groups / pre-IPO |
| `urgency.ts` | `tactic.urgency`, `tactic.fear_threat`, `tactic.secrecy`, `tactic.link_call_to_action`, `contact.off_platform` | urgency ("turant", "तुरंत"), fear ("giraftar", "गिरफ्तार"), secrecy ("kisi ko mat batana", "किसी को न बताएं"), link pressure, move to WhatsApp/Telegram |
| `adversarial.ts` | `adversarial.prompt_injection`, `adversarial.obfuscation` | "ignore previous instructions…", invisible characters / Cyrillic look-alikes |
| `links.ts` | `link.shortened`, `link.ip_address`, `link.unofficial_with_brand` | lightweight link signals (the URL analyser does the heavy lifting) |
| `combos.ts` | 5 combos | credential request + link, threat + link, urgency + payment, authority + payment, remote access + banking |

`CRITICAL_RULES` (OTP/PIN/CVV/password, PIN-to-receive, QR/collect, remote access, app install)
mark requests no legitimate sender makes.

**Safety tips and news** (`rules/context.ts`): text that talks ABOUT scams ("banks never ask for your
OTP", "police bust digital-arrest gang", "savdhan…") and gives the reader no instruction runs only the
link and prompt-injection checks. A scam that adds "beware of fraudsters" still addresses the reader
and is not exempt.

**Nothing-asked gate** (risk engine): with no rule and no risky link, the ML score alone cannot make
a message orange if it asks the reader to do nothing a scam needs (no link, ≥10-digit number,
pay/send/share/click/install/reply/join…, fee demand, "on WhatsApp/Telegram", "text X to 12345").

## Local risk engine (`risk-engine.ts`)

Inputs: rule result, ML prediction (calibrated probabilities), static URL analysis, and (Phase 4,
disabled now) LLM. Strategy — transparent, not a plain average:

1. **Confidence-weighted mean** of available sources: `wᵢ = configured_weightᵢ × confidenceᵢ`
   (weights `RISK_WEIGHT_ML 0.35`, `RISK_WEIGHT_RULES 0.30`, `RISK_WEIGHT_URL 0.20`,
   `RISK_WEIGHT_LLM 0.15`; renormalised over available sources).
2. **Deterministic floor**: `score ≥ 0.8 × max(rule score, URL score)` — ML can't argue away
   strong rule/link evidence. *This is how "ML says SAFE + OTP + PIN + urgent bank" still escalates*
   (tested).
3. **Critical floor**: a critical indicator keeps the result ≥ suspicious + 15.
4. **Prompt-injection floor**: ≥ suspicious.
5. **Corroboration boost**: two independent sources ≥ HIGH ⇒ at least the second-highest.
6. **Uncorroborated-ML cap** (`RISK_CAP_UNCORROBORATED_ML`, default on): with no rule fired and no
   HIGH-risk link, model signals alone can reach at most SUSPICIOUS (high − 1).

Every contribution and adjustment is returned (`signals`, `adjustments`) and shown in the UI.

## Thresholds (`thresholds.ts`, configurable)

| level | default | env |
|---|---|---|
| SAFE | 0–29 | — |
| SUSPICIOUS | 30–59 | `RISK_THRESHOLD_SUSPICIOUS=30` |
| HIGH RISK (classification `scam`) | 60–84 | `RISK_THRESHOLD_HIGH=60` |
| CRITICAL | 85–100 | `RISK_THRESHOLD_CRITICAL=85` |

Ordering is validated at startup. These are hand-chosen starting points (the spec's example
31/61/81 works via env), **not calibrated optima** — they must be calibrated on validation data
from real messages.

## Tests

`tests/unit/rules.test.ts`, `rules-multilingual.test.ts` (each family incl. Hindi/Hinglish,
false-positive guards in all three languages, danda boundary, UPI handles), `risk-engine.test.ts`
(safe ML + no rules, uncertain ML + strong rules, ML-safe + OTP/PIN/bank, scam ML + weak rules,
extremes, boundaries, custom thresholds, ML-only cap), `fusion.test.ts`, `pipeline-scenarios.test.ts`,
`redos.test.ts` (adversarial inputs stay fast).
