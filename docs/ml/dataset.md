# Dataset

## Required format (CSV or JSONL)

| column | required | values |
|---|---|---|
| `text` | yes | message as received |
| `label` | yes | `safe` · `suspicious` · `scam` |
| `category` | no (default `other`) | `phishing banking upi kyc job investment lottery delivery loan government_impersonation tech_support romance malware credential_theft other` |
| `source` | no | provenance tag, e.g. `synthetic-handwritten-v2`, `uci-sms-ham` |
| `language` | no (default `en`) | `en` · `hi` · `hinglish` · `mixed` |

```csv
text,label,category,source,language
"Your KYC has expired...",scam,kyc,dataset,en
"Your order has shipped...",safe,other,dataset,en
```

Place files anywhere under `ml/datasets/raw/` (except `raw/external/`). `preprocess.py` rejects
unknown labels/categories/languages and empty text.

## What is in the repository

| Source | Rows | Labels | Notes |
|---|---|---|---|
| `raw/synthetic/scamshield_synthetic_v1.csv` | 194 | 86 scam, 78 safe, 30 suspicious | **Hand-written for this project** (no real people's messages). English 164, Hindi 11, Hinglish 19. Includes genuine-looking Indian bank/UPI/telecom alerts, adversarial variants (misspellings, Unicode tricks, defanged URLs, prompt injection). |
| `raw/external/SMSSpamCollection` (downloaded, git-ignored) | 5 574 | ham → `safe`, spam → `suspicious` | UCI SMS Spam Collection v.1, Almeida & Gómez Hidalgo (2011), free use with attribution. Ham contributors consented to publication. **Spam is a weak label**: unsolicited marketing/prize SMS, not verified scams; excluded from the category head. Fetch: `npm run ml:fetch-data`. |
| `eval/scenario_suite.jsonl` | 25 | expectation per scenario | Held-out controlled scenarios (safe / scam / adversarial); never used for training. |

After dedup: 5 768 rows in, 487 exact duplicates dropped (mostly repeated spam), 5 152
near-duplicate groups.

## Splits (seed 42, group-aware)

| split | rows | safe | suspicious | scam | synthetic | UCI ham | UCI spam |
|---|---|---|---|---|---|---|---|
| train | 3 771 | 3 267 | 443 | 61 | 133 | 3 214 | 424 |
| validation | 755 | 654 | 89 | 12 | 29 | 641 | 85 |
| test | 755 | 653 | 89 | 13 | 32 | 641 | 82 |

Near-duplicates (token-set Jaccard ≥ 0.8) form groups; `StratifiedGroupKFold` assigns whole groups
to one split, and `preprocess.py` aborts if any group spans two splits. Reproducible: same inputs +
seed ⇒ identical files (tested). The manifest records a SHA-256 of the canonicalised data.

## Limitations

- The scam class is small (86 examples total) and synthetic → the model's scam-domain performance
  is measured on only 13 test scams.
- Hindi/Hinglish coverage is thin (test split: 4 Hindi, 3 Hinglish rows).
- No real-world Indian scam corpus is included. To claim production quality, add a labelled,
  consented/public dataset of real Indian SMS/WhatsApp scams and genuine notifications, with a
  time-based held-out test set.

## Privacy

No private messages are included. Do not add real people's messages without consent; keep any
such data in `ml/datasets/private/` (git-ignored) or outside the repository.
