import { re, rule } from "./shared";
import { isAwarenessText } from "./context";
import { findAll, findAny, findNonNegated } from "./matchers";
import type { RuleDefinition } from "../types";

/**
 * News / awareness text ("Police warn citizens about fake messages that threaten…") describes a
 * scam to readers; it does not threaten the reader. Such text never addresses "you".
 */

/** Government/police impersonation and tech-support / remote-access scams. */
export const IMPERSONATION_RULES: RuleDefinition[] = [
  rule(
    {
      id: "gov.impersonation_threat",
      category: "government_impersonation",
      severity: "high",
      weight: 0.45,
      description: "Claims to be police, a court or a government agency and threatens legal action.",
    },
    (t) =>
      isAwarenessText(t) ? null :
      findAll(t, [
        re(`(?:पुलिस|सीबीआई|आयकर विभाग|कोर्ट|साइबर क्राइम|सीमा शुल्क)`),
        re(`(?:गिरफ्तार|गिरफ़्तार|केस दर्ज|मनी लॉन्ड्रिंग|डिजिटल अरेस्ट|जुर्माना|वारंट)`),
      ]) ??
      findAll(t, [
        re(String.raw`\b(income tax|it department|police|cbi|enforcement directorate|customs (department|officer)|trai|rbi|reserve bank|court|cyber ?crime|narcotics|ncb|uidai|mumbai police|delhi police|crime branch|department of telecommunications)\b`),
        re(String.raw`\b(arrest\w*|warrant|legal action|case (has been |is )?(registered|filed|booked)|fir\b|penalty|summons|money laundering|illegal|seized|digital arrest|disconnect\w*|prosecution|jail)\b`),
      ]),
  ),
  rule(
    {
      id: "gov.fake_fine",
      category: "government_impersonation",
      severity: "high",
      weight: 0.4,
      description: "Demands payment of a traffic fine / e-challan through a link that is not an official government site.",
    },
    (t) => {
      if (isAwarenessText(t)) return null;
      const fine = findAll(t, [
        re(String.raw`\b(e-?challan|traffic (fine|challan|violation|penalty)|challan)\b`),
        re(String.raw`\b(pay|clear|settle|deposit)\b|\b(avoid|or face) (court|legal action|penalty|license suspension)\b`),
      ]);
      if (!fine) return null;
      // The official site is a .gov.in domain; any other link or a phone number to pay is a red flag.
      const links = t.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/gi) ?? [];
      const unofficial = links.some((l) => /\.[a-z]{2,}/i.test(l) && !/\.gov\.in\b|\.nic\.in\b/i.test(l));
      return unofficial || /\b(court|legal action)\b/i.test(t) ? fine : null;
    },
  ),
  rule(
    {
      id: "tech.remote_access",
      category: "tech_support",
      severity: "high",
      weight: 0.5,
      description: "Asks you to install remote-access/screen-sharing apps (AnyDesk, TeamViewer…).",
    },
    (t) =>
      findNonNegated(t, [
        re(String.raw`\b(?<verb>install|download|open|use|share|start|enable)\b[^.!?\n]{0,30}?\b(anydesk|any desk|teamviewer|team viewer|quick ?support|rustdesk|ultraviewer|airdroid|remote access|screen ?shar(e|ing))\b`),
        // Tool named first (common in Hinglish: "AnyDesk install karo")
        re(String.raw`\b(anydesk|any desk|teamviewer|team viewer|quick ?support|rustdesk|ultraviewer|airdroid)\b[^.!?\n]{0,30}?\b(?<verb>install|download|kholo|chalao|open)\b`),
      ]),
  ),
  rule(
    {
      id: "tech.fake_virus_alert",
      category: "tech_support",
      severity: "medium",
      weight: 0.3,
      description: "Warns of a virus/hack and pushes you to call 'support'.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(virus|malware|trojan|hacked|infected|compromised|security alert)\b[^.!?\n]{0,70}?\b(call|contact|helpline|toll[- ]free|support team|technician)\b`),
      ]),
  ),
];
