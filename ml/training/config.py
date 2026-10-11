"""Training configuration — every tunable lives here (no magic numbers in train/evaluate)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ML = ROOT / "ml"
RAW_DIR = ML / "datasets" / "raw"
PROCESSED_DIR = ML / "datasets" / "processed"
# Training writes a CANDIDATE (ml/registry/candidates/next by default via `npm run ml:train`). The
# active model in ml/models changes only through scripts/model-registry.ts (gate → sign → install).
MODELS_DIR = Path(os.environ["SCAMSHIELD_MODEL_OUT"]).resolve() if os.environ.get("SCAMSHIELD_MODEL_OUT") else ML / "models"
REPORTS_DIR = ML / "evaluation" / "reports"
EXTERNAL_UCI = RAW_DIR / "external" / "SMSSpamCollection"

MODEL_NAME = "scam-tfidf-logreg"
# Bump MAJOR when features/labels change incompatibly, MINOR for retraining on new data.
MODEL_VERSION = "1.1.0"

SEED = 42
LABELS = ["safe", "suspicious", "scam"]
CATEGORIES = [
    "phishing", "banking", "upi", "kyc", "job", "investment", "lottery", "delivery", "loan",
    "government_impersonation", "tech_support", "romance", "malware", "credential_theft", "other",
]
LANGUAGES = ["en", "hi", "hinglish", "mixed"]

# Group-aware split (near-duplicates never cross splits).
TEST_FRACTION = 0.15
VAL_FRACTION = 0.15
NEAR_DUPLICATE_JACCARD = 0.8

# Features
WORD_MIN_DF = 2
CHAR_MIN_DF = 2
CHAR_MAX_FEATURES = 12000

# Model selection on the VALIDATION split only.
# Objective = macro-F1 + scam recall on the domain (synthetic) validation rows
#             − EXTERNAL_FPR_PENALTY × false-positive rate on real external "safe" validation rows.
C_GRID = [0.5, 1.0, 2.0, 4.0]
SCAM_RECALL_WEIGHT = 1.0
EXTERNAL_FPR_PENALTY = 2.0
# Per-source weighting: total weight of external rows = ratio × total weight of domain rows.
# None = unweighted. Prevents ~4k generic SMS from drowning ~200 scam-domain examples.
EXTERNAL_WEIGHT_RATIOS = [None, 3.0, 1.0, 0.5]

# Probability calibration: "sigmoid" (Platt, per class, fitted on the validation split; the
# classifier itself is then trained on the train split only) or "none" (raw LR probabilities).
CALIBRATION = "sigmoid"

# Category head: categories with fewer examples are folded into "other".
MIN_CATEGORY_EXAMPLES = 3
