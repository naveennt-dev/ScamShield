"""
Text preprocessing shared by TRAINING and PRODUCTION INFERENCE (single source of truth).

Design rule: preserve scam signals. URLs, money, phone numbers, percentages and numbers are
replaced by *typed placeholder tokens* (plus the URL's host words and TLD), never deleted:

    "Your account will be blocked! Pay ₹499 now: https://fake-example.com"
 →  "your account will be blocked! pay  moneytoken  now:  urltoken fake example tld_com "

Tokens are Unicode letter runs (incl. combining marks, so Devanagari words stay whole), giving
word unigrams+bigrams and character 3–5-grams (robust to misspellings like "acc0unt", "verlfy").

THIS MODULE MUST STAY EQUIVALENT TO src/lib/detection/ml/tokenizer.ts. Any change requires the
same change in TypeScript, bumping TOKENIZER_VERSION in both, retraining, and regenerating the
parity fixture (`npm run ml:parity-fixture`).
"""
from __future__ import annotations

import unicodedata

import regex as re  # `regex` supports \p{L}/\p{M} like JavaScript's /u regexes

TOKENIZER_VERSION = "v2"

_INVISIBLE = re.compile("[​-‏‪-‮⁠-⁩﻿­]")
_URL = re.compile(r"(?:https?://|www\.)[^\s<>\"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|net|org|xyz|top|info|io|co|ly|me|app|site|online|shop|live|icu|link|click|biz|cc|tk|ml|ga|cf|gq|buzz)(?:/[^\s<>\"']*)?")
_EMAIL = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}")
_MONEY = re.compile(r"(?:₹|rs\.?|inr|\$|€|£|usd)\s?[0-9][0-9,]*(?:\.[0-9]+)?|[0-9][0-9,]*(?:\.[0-9]+)?\s?(?:rupees|rs|inr|lakhs?|crores?)\b")
_PHONE = re.compile(r"(?:\+?[0-9]{1,3}[\s-]?)?[0-9]{3,5}[\s-]?[0-9]{3,5}[\s-]?[0-9]{0,5}(?=[^0-9]|$)")
_PERCENT = re.compile(r"[0-9]+(?:\.[0-9]+)?\s?%")
_NUM = re.compile(r"[0-9]+")
_TOKEN = re.compile(r"[\p{L}\p{M}_]+")
_SHORTENERS = {"bit.ly", "tinyurl.com", "t.co", "goo.gl", "cutt.ly", "rb.gy", "is.gd", "ow.ly", "shorturl.at", "t.ly", "s.id", "tiny.cc"}


def _url_replacement(m: "re.Match[str]") -> str:
    raw = m.group(0)
    host = re.sub(r"^(?:https?://)?(?:www\.)?", "", raw).split("/")[0].split("?")[0].split("#")[0].split(":")[0]
    parts = [p for p in re.split(r"[.\-]", host) if p]
    tld = parts[-1] if len(parts) > 1 else ""
    words = [p for p in parts[:-1] if not p.isdigit()] if tld else parts
    out = ["urltoken", *words]
    if tld:
        out.append("tld_" + tld)
    if host in _SHORTENERS:
        out.append("shortlink")
    return " " + " ".join(out) + " "


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKC", text)
    t = _INVISIBLE.sub("", t)
    t = t.lower()
    t = _EMAIL.sub(" emailtoken ", t)  # before URLs: "help@scam.io" is an email, not a link
    t = _URL.sub(_url_replacement, t)
    t = _MONEY.sub(" moneytoken ", t)
    t = _PERCENT.sub(" pcttoken ", t)
    t = _PHONE.sub(lambda m: " phonetoken " if sum(c.isdigit() for c in m.group(0)) >= 8 else m.group(0), t)
    t = _NUM.sub(" numtoken ", t)
    return t


def tokenize(text: str) -> list[str]:
    return [tok for tok in _TOKEN.findall(normalize(text)) if len(tok) >= 2]


def word_features(text: str) -> list[str]:
    toks = tokenize(text)
    return toks + [f"{a} {b}" for a, b in zip(toks, toks[1:])]


CHAR_NGRAM_RANGE = (3, 5)


def char_features(text: str) -> list[str]:
    """Character n-grams inside each token (padded with spaces), like sklearn's char_wb."""
    out: list[str] = []
    lo, hi = CHAR_NGRAM_RANGE
    for tok in tokenize(text):
        padded = " " + tok + " "
        chars = list(padded)  # code points
        for n in range(lo, hi + 1):
            if len(chars) < n:
                break
            out.extend("".join(chars[i:i + n]) for i in range(len(chars) - n + 1))
    return out
