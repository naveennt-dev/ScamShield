from inference.preprocessing import char_features, normalize, tokenize, word_features


def test_scam_signals_are_preserved_as_typed_tokens():
    toks = tokenize("Your account will be blocked! Pay ₹499 now: https://fake-example.com")
    assert toks[:5] == ["your", "account", "will", "be", "blocked"]
    for signal in ("pay", "moneytoken", "now", "urltoken", "fake", "example", "tld_com"):
        assert signal in toks
    assert toks != ["account", "blocked", "pay"]


def test_url_host_words_tld_and_shortener():
    toks = tokenize("Verify at http://sbi-kyc-update.xyz/login?id=3 or bit.ly/abc")
    assert {"urltoken", "sbi", "kyc", "update", "tld_xyz", "shortlink"} <= set(toks)


def test_phone_email_percent_and_numbers():
    toks = tokenize("Call +91 98765 43210 or mail help@scam.io for 5% daily, code 4821")
    assert "phonetoken" in toks and "emailtoken" in toks and "pcttoken" in toks and "numtoken" in toks


def test_hindi_words_stay_whole_with_vowel_marks():
    toks = tokenize("आपका KYC expire हो गया है")
    assert "आपका" in toks and "गया" in toks and "kyc" in toks


def test_hinglish_preserved():
    assert tokenize("Apka KYC expire ho gya hai, abhi verify kro") == ["apka", "kyc", "expire", "ho", "gya", "hai", "abhi", "verify", "kro"]


def test_unicode_tricks_normalised():
    # fullwidth → ASCII (NFKC), zero-width removed
    assert tokenize("ＯＴＰ sha​re") == ["otp", "share"]


def test_whitespace_insensitive():
    assert tokenize("Pay   now\n\n\nplease") == tokenize("Pay now please")


def test_word_and_char_features():
    w = word_features("share otp now")
    assert "share otp" in w and "otp now" in w
    c = char_features("otp")
    assert " ot" in c and "otp" in c and "tp " in c and " otp " in c


def test_empty_and_symbols():
    assert tokenize("") == [] and tokenize("!!! ... ???") == []
    assert normalize("") == ""
