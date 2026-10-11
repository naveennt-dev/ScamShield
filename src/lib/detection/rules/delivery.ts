import { re, rule } from "./shared";
import { findAll } from "./matchers";
import type { RuleDefinition } from "../types";

/** Held-parcel / customs / redelivery fee scams. */
export const DELIVERY_RULES: RuleDefinition[] = [
  rule(
    {
      id: "delivery.customs_threat",
      category: "government_impersonation",
      severity: "high",
      weight: 0.5,
      description: "Says a parcel in your name was seized (illegal items / customs) and pushes you to an 'officer' — the start of 'digital arrest' scams.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(parcel|package|courier|shipment|consignment)\b`),
        re(String.raw`\b(illegal|drugs|narcotics|contraband|seized|confiscated|detained|held by customs|customs)\b`),
        re(String.raw`\b(officer|police|aadhaar|press \d|call|legal action|arrest\w*|blocked)\b`),
      ]),
  ),
  rule(
    {
      id: "delivery.held_parcel",
      category: "delivery",
      severity: "medium",
      weight: 0.35,
      description: "Says a parcel is held/failed and asks you to pay, click or update details.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(parcel|package|shipment|courier|consignment|delivery|fedex|dhl|india post|blue ?dart|delhivery|usps)\b`),
        re(String.raw`\b(held|on hold|pending|failed|unable to deliver|could not be delivered|undeliver\w*|customs|re-?delivery|re-?schedule|incomplete address|address (is )?(incomplete|incorrect|invalid)|returned to sender|seized)\b`),
        re(String.raw`\b(fee|pay|charge|click|tap|link|update|confirm|call|reply)\b`),
      ]),
  ),
];
