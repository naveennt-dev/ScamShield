# Privacy notice — review against the code (2026-10-11)

Not legal advice and not legal approval. Each statement of `PRIVACY-NOTICE-DRAFT.md` was checked
against the code and runtime behaviour; the draft has been corrected accordingly.

## A. Owner details still missing (to be supplied by you — nothing was invented)

1. Publisher / data controller: legal name (person or company) and registered address.
2. Contact for privacy questions and deletion requests (e-mail/address).
3. Grievance officer or equivalent, if required where you operate (e.g. India's DPDP Act, EU GDPR representative).
4. Jurisdiction / governing law; effective date; version number; how changes are announced.
5. Legal basis for processing (consent / legitimate interest), and minimum age of users.
6. Whether a hosted ScamShield web service exists, where it is hosted (country/provider) and its retention period.
7. Sub-processor list (AI service — currently OpenRouter and the model providers it routes to; hosting; Google sign-in if the web service uses it; URLhaus/PhishTank if you enable them).
8. International transfers (the AI service is outside India).
9. Commitments that code cannot prove — e.g. "we never sell data" — must be your business decision.

## B. Statement-by-statement verification

| Draft statement | Verdict | Evidence / correction |
|---|---|---|
| Screen/region images are read with the OS text recognition, never saved or sent | **True** | Vision OCR in the app; no image encoding or file writes in shipped code (audit: no CGImageDestination/PNG/JPEG writes); images never leave the process. |
| Scans are analysed on your device | **True (desktop)** | Bundled engine on 127.0.0.1; for the web service, scans run on the server — added. |
| History stores date, result, reasons, masked text | **Incomplete** | Also: score, "why this colour" with matched words (masked), website names in the scan, scan ID, capture type, whether AI was used. Max 500 entries; retention 7/30/90/365 days (default 90). Corrected. |
| "numbers … removed" before AI | **Overstated** | Runs of 4+ digits are masked keeping the last 2 (e.g. `####13`); e-mail local parts and UPI handles masked; link paths/queries removed; at most 3,000 characters; plus the list of findings. Shorter numbers are not masked. Corrected. |
| AI second opinion on by default after first-launch agreement | **True** | Default mode is AI-assisted but nothing is sent until the consent answer (`effectiveAnalysisMode`). In the desktop app it also needs your own AI key (Keychain); without it nothing is sent. Added. |
| AI service "may log what it receives" | **True, incomplete** | The request goes to OpenRouter, which forwards it to a model provider; both have their own terms. Added. |
| Online link checks contact the website without cookies | **True, incomplete** | The website sees your IP address and a ScamShield user-agent. Added. |
| Threat-list services only if configured; receive address without query | **True** | `intel.ts`: inactive without keys; sends `scheme://host/path`. |
| Share feedback off by default; sends feedback + masked text | **True** | `ContributionOutbox`: off by default; the desktop engine does not accept contributions (they stay queued on the device). |
| Never continuous monitoring | **True** | Capture only on explicit scan. |
| Never uploads History/reports automatically | **True** | No upload code for History/reports. |
| Never trains on scans automatically | **True** | Training is a manual, gated workflow; scans don't modify the model (tested). |
| Never sells data | **Not verifiable in code** | Owner commitment (see A.9). |
| — missing — browser extension | **Added** | Sends each opened page's `scheme://host/path` to the engine on your device; session-only verdict cache; private windows never checked. |
| — missing — web service accounts | **Added** | If the web service is used: Google sign-in (e-mail, name, picture), session cookies, signed-in scans stored with a masked 240-character preview for the retention period (default 90 days), hashed IP for rate limiting. |
| — missing — local logs | **Added** | Engine log and macOS logs contain scan IDs, scores and statuses — no message text. |
