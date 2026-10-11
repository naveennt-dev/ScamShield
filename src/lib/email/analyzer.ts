import { parse as parseDomain } from "tldts";
import type { RuleSignal } from "@/lib/detection/types";
import type { AnalyzeEmailInput, AttachmentMeta } from "@/lib/schemas/api";
import { analyzeUrlStatic } from "@/lib/url/analyzer";
import { BRAND_DOMAINS } from "@/lib/url/data";

/**
 * Email header/metadata analysis. Safe by design:
 *  - attachments are described by METADATA only (name, declared type, size); no attachment bytes
 *    are accepted, downloaded, opened or executed;
 *  - nothing is fetched; links in the body go through the normal static URL analysis.
 */

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "rediffmail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

const EXECUTABLE = /\.(exe|scr|msi|bat|cmd|com|pif|ps1|vbs|vbe|js|jse|wsf|hta|jar|apk|xapk|dmg|pkg|lnk|cpl|reg|iso|img|vhd)$/i;
const MACRO = /\.(docm|xlsm|pptm|dotm|xltm|xlam|ppam)$/i;
const HTML_LIKE = /\.(html?|shtml|xhtml|svg|mht)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|cab|ace|arj)$/i;
const DOUBLE_EXT = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|txt|csv)\.[a-z0-9]{2,5}$/i;

export interface ParsedAddress {
  displayName: string | null;
  address: string | null;
  domain: string | null;
}

export function parseAddress(raw: string): ParsedAddress {
  const s = raw.trim();
  const angle = s.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  const address = (angle ? angle[2] : s.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? null)?.toLowerCase() ?? null;
  const displayName = angle ? angle[1].replace(/^["'\s]+|["'\s]+$/g, "") || null : null;
  const host = address?.split("@")[1]?.replace(/[>.]+$/, "") ?? null;
  const domain = host ? (parseDomain(host).domain ?? host) : null;
  return { displayName, address, domain };
}

export interface AttachmentAssessment extends AttachmentMeta {
  risk: "low" | "medium" | "high";
  reason: string | null;
}

export function assessAttachment(a: AttachmentMeta): AttachmentAssessment {
  const name = a.filename.trim().toLowerCase().replace(/[‮​-‏]/g, "");
  if (/[‮]/.test(a.filename)) return { ...a, risk: "high", reason: "File name uses a hidden right-to-left character to disguise its type" };
  if (DOUBLE_EXT.test(name) && EXECUTABLE.test(name)) return { ...a, risk: "high", reason: "Double extension hides an executable file" };
  if (EXECUTABLE.test(name)) return { ...a, risk: "high", reason: "Executable/installer file type" };
  if (MACRO.test(name)) return { ...a, risk: "medium", reason: "Office document with macros enabled" };
  if (HTML_LIKE.test(name)) return { ...a, risk: "medium", reason: "HTML/SVG attachments are often fake login pages" };
  if (ARCHIVE.test(name)) return { ...a, risk: "medium", reason: "Archive files can hide malware" };
  const declared = a.contentType?.toLowerCase();
  if (declared && name.endsWith(".pdf") && !declared.includes("pdf")) {
    return { ...a, risk: "medium", reason: "Declared content type does not match the file extension" };
  }
  return { ...a, risk: "low", reason: null };
}

export interface EmailAnalysis {
  sender: ParsedAddress;
  replyTo: ParsedAddress | null;
  attachments: AttachmentAssessment[];
  signals: RuleSignal[];
  authResults: { spf: string | null; dkim: string | null; dmarc: string | null };
}

function sig(ruleId: string, severity: RuleSignal["severity"], weight: number, description: string, evidence: string, category: RuleSignal["category"] = "phishing"): RuleSignal {
  return { ruleId, severity, weight, description, evidence: evidence.slice(0, 200), category };
}

export function analyzeEmailMetadata(input: AnalyzeEmailInput): EmailAnalysis {
  const sender = parseAddress(input.from);
  const replyTo = input.replyTo ? parseAddress(input.replyTo) : null;
  const signals: RuleSignal[] = [];

  if (!sender.address) {
    signals.push(sig("email.invalid_sender", "medium", 0.2, "The sender address is missing or malformed.", input.from));
  }

  // Display-name brand impersonation
  const dn = (sender.displayName ?? "").toLowerCase();
  const brandInName = Object.keys(BRAND_DOMAINS).find((b) => new RegExp(`\\b${b}\\b`).test(dn));
  const authorityInName = /\b(bank|income tax|police|customs|support|security|helpdesk|it department|kyc|refund|government)\b/.exec(dn)?.[1];
  if (sender.domain) {
    const officialForBrand =
      brandInName && BRAND_DOMAINS[brandInName].some((d) => sender.domain === d || sender.domain!.endsWith(`.${d}`));
    if (brandInName && !officialForBrand) {
      signals.push(
        sig(
          FREEMAIL.has(sender.domain) ? "email.freemail_brand" : "email.display_name_mismatch",
          "high",
          0.45,
          `The sender calls itself "${brandInName}" but the email comes from ${sender.domain}, not an official ${brandInName} domain.`,
          `${sender.displayName} <…@${sender.domain}>`,
        ),
      );
    } else if (authorityInName && FREEMAIL.has(sender.domain)) {
      signals.push(
        sig(
          "email.freemail_authority",
          "medium",
          0.35,
          `Claims to be "${authorityInName}" but uses a free personal email service (${sender.domain}).`,
          `${sender.displayName} <…@${sender.domain}>`,
        ),
      );
    }
    const embedded = dn.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0];
    if (embedded && embedded !== sender.address) {
      signals.push(sig("email.spoofed_display_address", "medium", 0.3, "The display name shows a different email address than the real sender.", `${embedded} vs …@${sender.domain}`));
    }
    const domainFinding = analyzeUrlStatic(`https://${sender.domain}/`);
    const lookalike = domainFinding.flags.find((f) => ["host.brand_impersonation", "host.typosquat", "host.homograph"].includes(f.id));
    if (lookalike) {
      signals.push(sig("email.lookalike_domain", "high", 0.5, "The sender's domain imitates a well-known brand.", `${sender.domain}: ${lookalike.detail}`));
    }
  }

  if (replyTo?.domain && sender.domain && replyTo.domain !== sender.domain) {
    signals.push(
      sig(
        "email.reply_to_mismatch",
        "medium",
        FREEMAIL.has(replyTo.domain) ? 0.3 : 0.2,
        "Replies would go to a different domain than the sender's.",
        `from …@${sender.domain}, reply-to …@${replyTo.domain}`,
      ),
    );
  }

  const ar = (input.authenticationResults ?? "").toLowerCase();
  const res = (k: string) => ar.match(new RegExp(`\\b${k}=(pass|fail|softfail|neutral|none|temperror|permerror)`))?.[1] ?? null;
  const authResults = { spf: res("spf"), dkim: res("dkim"), dmarc: res("dmarc") };
  if (authResults.dmarc === "fail") {
    signals.push(sig("email.dmarc_fail", "high", 0.4, "The email failed DMARC: the sender domain did not authorise it (possible spoofing).", "dmarc=fail"));
  } else if (authResults.spf === "fail" || authResults.dkim === "fail") {
    signals.push(sig("email.auth_fail", "medium", 0.3, "The email failed sender authentication (SPF/DKIM).", `spf=${authResults.spf} dkim=${authResults.dkim}`));
  } else if (authResults.spf === "softfail") {
    signals.push(sig("email.spf_softfail", "low", 0.12, "SPF soft-failed for the sender.", "spf=softfail"));
  }

  const attachments = input.attachments.map(assessAttachment);
  for (const a of attachments) {
    if (a.risk === "high") {
      signals.push(sig("email.dangerous_attachment", "high", 0.5, `Dangerous attachment: ${a.reason}.`, a.filename, "malware"));
    } else if (a.risk === "medium") {
      signals.push(sig("email.risky_attachment", "medium", 0.25, `Risky attachment: ${a.reason}.`, a.filename, "malware"));
    }
  }

  return { sender, replyTo, attachments, signals, authResults };
}
