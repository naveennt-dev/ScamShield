# System evaluation — 1.1.0+20261007.906379c2

> Synthetic scam data + public UCI SMS. Not a measure of real-world scam detection accuracy.

Engine: rules + ML (embedded) + static URL analysis; LLM disabled; no network. 0.64 ms/message.

## Held-out test split

| source | rows | system acc | system scam recall | scam→safe | safe FPR | ML-only acc | ML-only scam recall | ML-only safe FPR |
|---|---|---|---|---|---|---|---|---|
| synthetic | 32 | 0.6875 | 0.7692 | 0 | 0.0833 | 0.7188 | 0.8462 | 0.25 |
| uci-sms-ham | 641 | 0.9953 | – | 0 | 0.0047 | 0.9922 | – | 0.0078 |
| uci-sms-spam | 82 | 0.5732 | – | 0 | – | 0.8659 | – | – |

## Scenario suite (25/25)

| group | scenario | expected | system | score | ML alone | ✓ |
|---|---|---|---|---|---|---|
| safe | normal conversation | safe | safe (safe) | 1 | safe | ✓ |
| safe | genuine delivery notification | safe | safe (safe) | 0 | safe | ✓ |
| safe | genuine bank notification | safe | safe (safe) | 14 | safe | ✓ |
| safe | OTP notification without request | safe | safe (safe) | 1 | safe | ✓ |
| safe | normal job communication | safe | safe (safe) | 2 | safe | ✓ |
| safe | Hindi OTP notice | safe | safe (safe) | 11 | safe | ✓ |
| safe | Hinglish chat | safe | safe (safe) | 0 | safe | ✓ |
| scam | KYC scam | scam | scam (critical) | 89 | scam | ✓ |
| scam | UPI scam | scam | scam (high) | 80 | scam | ✓ |
| scam | fake refund | scam | scam (high) | 81 | scam | ✓ |
| scam | fake job | scam | scam (critical) | 87 | scam | ✓ |
| scam | lottery | scam | scam (critical) | 85 | scam | ✓ |
| scam | investment | scam | scam (critical) | 90 | scam | ✓ |
| scam | fake delivery | scam | scam (high) | 82 | scam | ✓ |
| scam | fake government message | scam | scam (high) | 80 | scam | ✓ |
| scam | fake bank alert | scam | scam (critical) | 90 | scam | ✓ |
| adversarial | mixed Hindi/English | scam | scam (high) | 78 | scam | ✓ |
| adversarial | Hinglish OTP request | scam | scam (high) | 77 | scam | ✓ |
| adversarial | spelling variations | not-safe | scam (high) | 68 | scam | ✓ |
| adversarial | unicode tricks | scam | scam (critical) | 88 | scam | ✓ |
| adversarial | URL obfuscation | scam | scam (critical) | 86 | scam | ✓ |
| adversarial | excessive whitespace | scam | scam (critical) | 87 | scam | ✓ |
| adversarial | urgency manipulation | not-safe | scam (high) | 83 | scam | ✓ |
| adversarial | prompt-injection-like text | scam | scam (critical) | 91 | scam | ✓ |
| adversarial | safe message with scary words | safe | safe (safe) | 1 | safe | ✓ |
