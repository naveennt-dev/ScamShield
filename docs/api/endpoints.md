# API Reference (v1)

Base path: `/api/v1`. All endpoints run on the Node.js runtime and return `Cache-Control: no-store`.

## Envelope

Success:
```json
{ "success": true, "data": { ... }, "meta": { "requestId": "…", "processingTimeMs": 42, "version": "v1" } }
```
Error (no stack traces, no echoed input):
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "The request is invalid.", "requestId": "…", "details": [{ "path": "message", "message": "must not be empty" }] } }
```
Every response carries `X-Request-Id` (a well-formed inbound `X-Request-Id` is reused).

| code | HTTP | meaning |
|---|---|---|
| VALIDATION_ERROR | 400 | schema validation failed (unknown fields are rejected) |
| MALFORMED_JSON | 400 | body is not JSON |
| UNAUTHORIZED | 401 | sign-in required |
| ORIGIN_NOT_ALLOWED | 403 | cross-site write rejected |
| NOT_FOUND | 404 | missing or not yours |
| CONFLICT | 409 | already reported |
| PAYLOAD_TOO_LARGE | 413 | body/message/image too large |
| UNSUPPORTED_MEDIA_TYPE | 415 | wrong content type / invalid image |
| UNPROCESSABLE | 422 | no readable text in image |
| RATE_LIMITED | 429 | see `Retry-After` |
| SERVICE_UNAVAILABLE | 503 | OCR disabled/failed |
| INTERNAL_ERROR | 500 | unexpected; quote `requestId` |

## Authentication & limits

Session cookie from better-auth (`/api/auth/*`). Identity is always taken from the session; any
`userId` in a body is rejected by the schema.

Rate limits (fixed windows; headers `X-RateLimit-Limit/Remaining/Reset`, `Retry-After` on 429):

| scope | anonymous | authenticated | premium (future) |
|---|---|---|---|
| analyze_message, analyze_url | 5/min, 30/day | 20/min, 500/day | 60/min, 5000/day |
| analyze_image | 2/min, 10/day | 5/min, 100/day | 20/min, 1000/day |
| analyze_email | 3/min, 20/day | 10/min, 200/day | 40/min, 2000/day |
| report | not allowed | 10/min, 100/day | 30/min, 500/day |
| read (history, stats, settings GET) | — | 120/min | 300/min |
| write (settings PUT, deletes) | — | 30/min | 60/min |

Anonymous analysis can be disabled with `ALLOW_ANONYMOUS_ANALYSIS=false`.

## `AnalysisResult`

Returned by all `analyze/*` endpoints (schema: `src/lib/schemas/analysis.ts`):

```jsonc
{
  "id": "clx…" | null,              // null for anonymous (not stored)
  "inputType": "message",
  "classification": "scam",          // safe | suspicious | scam
  "riskLevel": "critical",           // safe | suspicious | high | critical
  "riskScore": 87,                   // 0–100
  "confidence": 0.81,                // 0–1
  "category": "kyc", "categoryLabel": "KYC Scam",
  "reasons": ["Pressures you to update KYC urgently…", "Link sbi-kyc-update.xyz: …"],
  "indicators": [{ "source": "rules", "type": "kyc.urgent_update", "severity": "medium", "evidence": "…masked…" }],
  "suspiciousEntities": ["sbi-kyc-update.xyz"],
  "urls": [{ "url": "…", "hostname": "…", "registrableDomain": "…", "riskScore": 79, "flags": [{ "id": "host.brand_impersonation", "severity": "high", "detail": "…" }],
             "reputation": "unknown",       // confirmed_malicious | suspicious | benign_reports | unknown (= no record, not "safe")
             "intel": { "checked": true, "checkedBy": ["internal-reports"], "sources": [], "evidence": [], "confidence": null, "lastUpdated": null } }],
  "recommendedActions": ["Do not click the link.", "…"],
  "explanation": "This is almost certainly a scam (KYC Scam). …",
  "aiSummary": "…" | null,           // LLM text, only when the LLM contributed
  "signals": [{ "source": "rules", "available": true, "score": 94, "confidence": 0.95, "configuredWeight": 0.3, "effectiveWeight": 0.51, "contribution": 47.6 }],
  "adjustments": [{ "kind": "floor", "reason": "…", "from": 52, "to": 75 }],
  "modelMetadata": { "llm": { "provider": "openrouter", "model": "…", "status": "ok|fallback|unavailable|disabled|skipped", "attempts": 1 } | null,
                     "ml": { "version": "baseline-…", "seedModel": true } | null },
  "intel": { "knownPattern": false, "reportCount": 0 },
  "warnings": ["AI analysis was unavailable; …"],
  "decision": {                      // why this colour — built only from the evidence above
    "colour": "red",                 // green | orange | red
    "why": "Red: final score 95/100 is at or above the high-risk line (60) — strong evidence: …",
    "basis": ["Safety rules: 8 matched (3 strong), rule score 95/100.", "ML model: 100/100 scam-like … — a model estimate, not proof.", "Link …", "AI second opinion (…): rated 92/100 …"],
    "matches": [{ "rule": "Asks you to share a one-time password (OTP)…", "text": "…share the otp sent to your mobile…", "severity": "high" }],
    "thresholds": { "suspicious": 30, "high": 60, "critical": 85 }
  },
  "createdAt": "2026-10-07T17:09:16.138Z"
}
```

## Endpoints

### `POST /analyze/message` — auth optional
`{ "message": string (1–10 000 chars), "channel"?: "sms"|"whatsapp"|"email"|"social"|"call_transcript"|"other" }`

### `POST /analyze/url` — auth optional
`{ "url": string (≤4096), "followRedirects"?: boolean }` — non-http schemes (e.g. `javascript:`) are
analysed and flagged, never fetched. Redirects are resolved only if the server has
`URL_FETCH_ENABLED=true` (SSRF-guarded, see `docs/security/ssrf.md`).

### `POST /analyze/image` — auth optional
`multipart/form-data` with field `image` (PNG/JPEG/WebP, ≤5 MB, ≤10 000 px per side). Response
adds `ocr: { provider, confidence, latencyMs, image: { type, width, height }, extractedText (masked, ≤2000 chars) }`.
503 if OCR is disabled or fails, 422 if no text is found. Images are not stored.

### `POST /analyze/email` — auth optional
```json
{ "from": "\"SBI\" <alerts@x.com>", "replyTo": "…", "subject": "…", "body": "…",
  "authenticationResults": "spf=pass; dkim=fail; dmarc=fail",
  "attachments": [{ "filename": "invoice.pdf.exe", "contentType": "application/pdf", "sizeBytes": 1234 }] }
```
Attachment **content is not accepted**. Response adds `email: { sender, replyToDomain, authResults, attachments: [{ filename, risk, reason }] }`.

### `GET /history?limit=20&cursor=…&classification=scam&inputType=message` — auth required
`{ items: HistoryItem[], nextCursor: string | null }`

### `DELETE /history` — auth required
Deletes all of the caller's stored analyses → `{ deleted: n }`.

### `GET /history/{id}` / `DELETE /history/{id}` — auth required
Another user's ID returns 404.

### `GET /reports` / `POST /reports` — auth required
`POST { "reportType": "message"|"url"|"other", "content": string, "category": ScamCategory, "analysisId"?: string, "note"?: string }`
→ 201 `ReportItem` (`communityReports` = how many users reported the same content). 409 on duplicate.

### `GET /stats` — auth required
`{ totalScans, scamsDetected, suspicious, safe, reportsSubmitted, topCategories[], recent[] }` (caller's data only).

### `GET /settings` / `PUT /settings` — auth required
`{ storeContentPreview: boolean, retentionDays: 1–365, allowLlmAnalysis: boolean }`

### `POST /analyze/link` — auth optional
Layered link scan (`docs/design/link-protection.md`). Body (strict): `{ url, analysisMode: "local" |
"remote-assisted" (default local), inspectBehaviour: boolean (default false) }`. `local` makes no
outbound request. Returns a `LinkReport`: `verdict` (malicious | high_risk | suspicious |
no_known_threat | inconclusive), `verdictLabel`, `summary`, `recommendedAction`, redacted `url`,
`hostname`/`displayHostname`, `redirectChain`, `finalUrl`, `page` (kind incl. official_youtube /
youtube_imitation / third_party_with_youtube_embed / download), `download`, `categories`,
`evidence` (kind: confirmed_intel | observed_behaviour | heuristic | ai_opinion), `coverage`,
`limitations`, `disclosures`, `dynamic`, and the underlying `analysis`.

### `POST /contributions` — auth optional, disabled unless `CONTRIBUTIONS_ENABLED=true`
Opt-in shared-learning contribution. Body (strict): `{ installationId: uuid, text: 10–2000 chars (already
masked by the app; masked again here, link paths dropped), verdict: correct|missed_scam|false_positive|unsure,
system: { riskLevel, riskScore, category? }, appVersion, modelBuild? }`. Stored QUARANTINED, one row per
(message, installation) — a repeat updates it (200, `duplicate: true`), a new one returns 201. Rate scope
`contribute`. 403 when the server doesn't accept contributions. Never changes a model; see
`docs/design/shared-learning-and-url-intelligence.md`.

### `GET /health` — public
`{ status: "ok"|"degraded"|"down", checks: { database, rateLimitStore, llm, ml, ocr }, mlModel, appVersion }`.
Never calls OpenRouter; returns 503 only when the database is down.

### `GET /metrics` — `Authorization: Bearer $METRICS_TOKEN`
Prometheus text format. 404 when `METRICS_TOKEN` is unset.

### `GET /cron/retention` — `Authorization: Bearer $CRON_SECRET`
Deletes expired data → `{ analyses, events, patterns }`. 404 when `CRON_SECRET` is unset.

## Legacy

### `POST /api/scam` — removed

The deprecated legacy endpoint was removed (it only duplicated `POST /api/v1/analyze/message`).
