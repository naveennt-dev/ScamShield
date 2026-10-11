import { re, rule } from "./shared";
import { findAll, findAny, MONEY } from "./matchers";
import type { RuleDefinition } from "../types";

/** Job and task scams (fees, "earn by liking videos"). */
export const JOB_RULES: RuleDefinition[] = [
  rule(
    {
      id: "job.fee_required",
      category: "job",
      severity: "high",
      weight: 0.45,
      description: "Job or work offer that asks you to pay a fee or deposit.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(job|jobs|work from home|wfh|part[- ]time|full[- ]time|vacancy|vacancies|hiring|recruit\w*|offer letter|interview|position|salary|naukri|ghar baithe|kamaiye|kamao)\b`),
        re(String.raw`\b(registration|joining|security|training|processing|onboarding|refundable|kit)\s+(fee|fees|deposit|charge|charges|amount)\b|\bpay\b[^.!?\n]{0,30}?\b(fee|deposit)\b`),
      ]),
  ),
  rule(
    {
      id: "job.easy_money_tasks",
      category: "job",
      severity: "medium",
      weight: 0.35,
      description: "Promises easy money for simple online tasks (liking videos, reviews, ratings).",
    },
    (t) =>
      findAny(t, [
        // Spans the danda: offer and fee are often separate sentences.
        re(`(?:घर बैठे|नौकरी)[^\\n]{0,80}?(?:रजिस्ट्रेशन फीस|फीस|शुल्क)`),
        re(String.raw`\b(ghar baithe|roz|daily)\b[^.!?\n]{0,40}?\b(kamaiye|kamao|kamaye|kamayein)\b`),
        re(String.raw`\b(like|subscribe|review|rate|follow)\b[^.!?\n]{0,25}?\b(videos?|youtube|products?|hotels?|google maps|posts?|channels?)\b[^.!?\n]{0,60}?\b(earn|paid|pay|commission|income|salary|${MONEY})`),
        re(String.raw`\b(earn|income|salary|make)\b[^.!?\n]{0,25}?(${MONEY})[^.!?\n]{0,30}?\b(per day|daily|a day|per hour|per task|per week|from home|in \d+ (hours?|days?))\b`),
      ]),
  ),
];
