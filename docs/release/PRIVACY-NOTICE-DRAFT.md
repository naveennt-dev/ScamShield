# ScamShield privacy notice — DRAFT for the owner's review (not legal advice; not approved)

Corrected after the code review in `PRIVACY-NOTICE-REVIEW.md`.

[OWNER TO COMPLETE — see PRIVACY-NOTICE-REVIEW.md §A: publisher/controller, contact, grievance
officer, jurisdiction, effective date and version, legal basis, minimum age, hosting, sub-processors,
international transfers, deletion requests.]

**On your device.** In the desktop app, scans are analysed on your device. Screen/region images are
read with the operating system's text recognition and are never saved or sent. History keeps, on
your device only: date, result and score, the reasons and "why this colour" (with matched words
masked), website names found, whether the AI was used, and — unless you turn it off — the scanned
text with numbers of 4+ digits (only the last two digits kept), e-mail addresses, UPI IDs and link
paths masked. Up to 500 entries, kept 7/30/90/365 days (default 90). Your feedback is stored on
your device. Logs contain scan IDs, scores and statuses — never message text.

**Only if you choose it.**
- *AI second opinion* (on by default only after you agree on first launch; can be turned off; in
  the desktop app it also needs your own AI key, kept in your Keychain): the masked text of a scan
  (as above, at most 3,000 characters) and the list of findings — or, for links, only the website
  address and the findings — is sent to the AI service (currently OpenRouter, which forwards it to an
  AI model provider). Their own privacy terms apply; they may log what they receive. It is outside
  [OWNER: list countries/transfers].
- *Online link checks*: ScamShield contacts the website you asked about (without your cookies or
  accounts) to follow redirects and read the page. That website sees your IP address.
- *Threat-list services* (only if configured): receive the address without query parameters.
- *Share feedback* (off by default): sends your feedback with the masked text to the ScamShield
  service you are connected to.

- *Browser extension* (if installed): the address (without ?query or #fragment) of each page you
  open is checked by the ScamShield engine on your device; nothing is sent elsewhere. Private windows
  are never checked.
- *Web service accounts* [OWNER: only if you operate one]: Google sign-in (e-mail, name, picture),
  session cookies, scans stored with a masked 240-character preview for the retention period
  (default 90 days), and a hashed IP address for rate limiting.

**Never:** continuous screen monitoring, uploading History or reports automatically, training models
on your scans automatically. [OWNER: add business commitments such as "we do not sell data" only if
true.]

**Your choices:** turn the AI second opinion, text saving, sharing and launch-at-login on or off in
Settings; delete History in the History window; remove the app and its data folder.
