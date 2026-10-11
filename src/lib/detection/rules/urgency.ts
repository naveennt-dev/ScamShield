import { re, rule } from "./shared";
import { findAny } from "./matchers";
import type { RuleDefinition } from "../types";

/** Manipulation tactics: urgency, fear, secrecy, link pressure, moving off-platform. */
export const URGENCY_RULES: RuleDefinition[] = [
  rule(
    {
      id: "tactic.urgency",
      category: "other",
      severity: "low",
      weight: 0.12,
      description: "Creates urgency to stop you from thinking it through.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(urgent\w*|immediately|act now|right away|asap|today itself|final (notice|warning|reminder)|last (chance|warning|reminder|date)|expires? (today|tonight|soon)|limited time|within \d+\s?(hours?|hrs?|minutes?|mins?)|turant|jaldi se|aaj hi)\b`),
        re(`(?:तुरंत|तुरन्त|जल्दी करें|आज ही|अंतिम चेतावनी)`),
      ]),
  ),
  rule(
    {
      id: "tactic.fear_threat",
      category: "other",
      severity: "low",
      weight: 0.15,
      description: "Uses fear (arrest, penalties, blocking) to pressure you.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(legal action|arrest\w*|penalt(y|ies)|police|jail|lawsuit|terminated|permanently (deleted|closed|blocked)|blacklist\w*|fine of|giraftar|case darj)\b`),
        re(`(?:गिरफ्तार|गिरफ़्तार|पुलिस|केस दर्ज|जुर्माना|कानूनी कार्रवाई|जेल)`),
      ]),
  ),
  rule(
    {
      id: "tactic.secrecy",
      category: "other",
      severity: "medium",
      weight: 0.25,
      description: "Tells you to keep it secret from family, the bank or the police.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(don't|do not|dont|never)\s+(tell|inform|discuss|mention|talk to)\b[^.!?\n]{0,25}?\b(anyone|family|bank|police|relatives|friends)\b`),
        re(String.raw`\b(keep (this|it) (confidential|secret|private)|strictly confidential)\b`),
        re(String.raw`\bkisi\s+(ko|se)\s+(mat|na|nahi)\s+(batana|batayein|bataye|batao|kehna)\b`),
        re(`किसी\\s+(?:को|से)\\s+(?:न|ना|मत)\\s+(?:बताएं|बताएँ|बताना|बताइए|कहें)`),
      ]),
  ),
  rule(
    {
      id: "tactic.link_call_to_action",
      category: "phishing",
      severity: "low",
      weight: 0.12,
      description: "Pushes you to click a link.",
    },
    (t, ctx) =>
      ctx.hostnames.length > 0
        ? findAny(t, [re(String.raw`\b(click|tap|open|visit|follow|go to|login at|log in at|verify at|update at)\b[^.!?\n]{0,30}?\b(link|below|here|url|website|now|http|www)`)]) ??
          findAny(t, [re(String.raw`\b(click|tap|visit)\b`)])
        : null,
  ),
  rule(
    {
      id: "contact.off_platform",
      category: "other",
      severity: "low",
      weight: 0.1,
      description: "Moves the conversation to WhatsApp/Telegram or an unknown phone number.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(whatsapp|telegram|signal|call|contact|message)\b[^.!?\n]{0,20}?\b(me|us|on|at|our (agent|executive|officer))\b[^.!?\n]{0,25}?\+?\d[\d\s-]{8,}\d`),
        re(String.raw`\b(t\.me|wa\.me)\/`),
      ]),
  ),
];
