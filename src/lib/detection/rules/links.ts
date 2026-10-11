import { isIP } from "node:net";
import { URL_SHORTENERS } from "@/lib/url/data";
import { isOfficialBrandHost } from "@/lib/url/analyzer";
import type { RuleDefinition } from "../types";

/** Lightweight link signals (the URL analyser does the heavy lifting). */
export const LINKS_RULES: RuleDefinition[] = [
  {
    id: "link.shortened",
    category: "phishing",
    severity: "low",
    weight: 0.15,
    description: "Contains a shortened link that hides where it goes.",
    evaluate: (ctx) => ctx.hostnames.find((h) => URL_SHORTENERS.has(h)) ?? null,
  },
  {
    id: "link.ip_address",
    category: "phishing",
    severity: "medium",
    weight: 0.3,
    description: "Contains a link to a raw IP address.",
    evaluate: (ctx) => ctx.hostnames.find((h) => isIP(h.replace(/^\[|\]$/g, "")) !== 0) ?? null,
  },
  {
    id: "link.unofficial_with_brand",
    category: "phishing",
    severity: "medium",
    weight: 0.25,
    description: "Mentions a bank/brand but links to a website that is not that brand's official site.",
    evaluate: (ctx) => {
      const brandMention = /\b(sbi|hdfc|icici|axis|kotak|pnb|paytm|phonepe|amazon|flipkart|paypal|netflix|india post|irctc|uidai|aadhaar|income tax|epfo|fedex|dhl|bluedart|airtel|jio)\b/.exec(
        ctx.text.lower,
      );
      if (!brandMention) return null;
      const unofficial = ctx.hostnames.find((h) => !isOfficialBrandHost(h) && !URL_SHORTENERS.has(h));
      return unofficial ? `mentions "${brandMention[1]}", links to ${unofficial}` : null;
    },
  },
];
