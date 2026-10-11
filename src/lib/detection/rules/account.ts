import { re, rule } from "./shared";
import { findAll, findAny } from "./matchers";
import type { RuleDefinition } from "../types";

/**
 * Online-account and refund bait: "your account will be deleted — appeal here", tax/ITR refund
 * "submit bank details", reward points "expiring today", mailbox "full", subscription "renewed —
 * call to cancel", insurance "will lapse", and task-scam deposits.
 */

const CHECK_OR_LOGIN = String.raw`\b(verify|confirm|appeal|log ?in|sign ?in|validate|re-?activate|restore|update|submit|click|tap|visit|call)\b`;

export const ACCOUNT_RULES: RuleDefinition[] = [
  rule(
    {
      id: "account.deletion_threat",
      category: "phishing",
      severity: "medium",
      weight: 0.35,
      description: "Says your online account will be deleted, disabled or suspended unless you verify or appeal — platforms show this inside their app, not by message.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(account|page|profile|channel|membership|mailbox|wallet|id)\b[^.!?\n]{0,40}?\b(will be|has been|is being|is|are) (permanently )?(deleted|disabled|suspended|terminated|deactivated|removed|locked|restricted|banned|on hold)\b`),
        re(CHECK_OR_LOGIN),
      ]),
  ),
  rule(
    {
      id: "refund.bank_details_bait",
      category: "phishing",
      severity: "high",
      weight: 0.5,
      description: "Offers a refund, subsidy or payout but needs your bank/card details or a login first — genuine refunds go to the account already on record.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(refund|tax refund|itr refund|cashback|subsidy|installment|instalment|payout|compensation|scholarship|pension|reimbursement)\b`),
        re(String.raw`\b(submit|update|verify|enter|share|provide|confirm|fill)\b[^.!?\n]{0,40}?\b(bank (account )?details|account (details|number|no)|card details|ifsc|aadhaar|pan|upi id|login|details)\b|\bincorrect account\b`),
      ]),
  ),
  rule(
    {
      id: "rewards.points_expiry",
      category: "banking",
      severity: "medium",
      weight: 0.35,
      description: "Says your reward points expire today and asks you to redeem through a link or app — banks show points in their own app.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(reward points?|points? worth|rewardz?|loyalty points?)\b`),
        re(String.raw`\b(expir\w*|lapse|lost)\b[^.!?\n]{0,30}?\b(today|tonight|soon|within)\b|\b(redeem|convert|claim)\b[^.!?\n]{0,30}?\b(now|today|cash|link|here|apk)\b`),
      ]),
  ),
  rule(
    {
      id: "account.mailbox_full",
      category: "phishing",
      severity: "medium",
      weight: 0.3,
      description: "Claims your mailbox is full and asks you to log in to fix it — a classic password-phishing message.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(mailbox|email|inbox|mail)\b[^.!?\n]{0,30}?\b(storage|quota|space)\b[^.!?\n]{0,20}?\b(full|exceeded|limit)|\b(storage|quota) (is )?(full|exceeded)\b`),
        re(String.raw`\b(log ?in|sign ?in|verify|click|upgrade|increase)\b[^.!?\n]{0,40}?\b(here|now|link|free|storage|account)\b|\bwill be (deleted|lost|blocked)\b`),
      ]),
  ),
  rule(
    {
      id: "tech.subscription_refund_call",
      category: "tech_support",
      severity: "high",
      weight: 0.5,
      description: "Reports a large renewal or charge you didn't make and urges you to call a “refund desk” — the callers then ask for remote access or bank details.",
    },
    (t) =>
      findAll(t, [
        // Renewals/orders the reader "didn't make" — not bank debit alerts, which also say "Not you? Call…".
        re(String.raw`\b(renewed|auto-?renew\w*|subscription|membership|order (has been |was )?placed|purchase of)\b`),
        re(String.raw`\b(did not|didn'?t|not authori[sz]ed?|unauthori[sz]ed|to cancel|cancel (this|the|it)|refund)\b`),
        re(String.raw`\b(call|contact|dial|ring)\b[^.!?\n]{0,40}?(\+?\d[\d -]{8,}\d|\b(refund|support|helpline|desk)\b)`),
      ]),
  ),
  rule(
    {
      id: "tech.call_support_scare",
      category: "tech_support",
      severity: "high",
      weight: 0.5,
      description: "Claims your device is infected or hacked and tells you to call “support” on a phone number — real security warnings never ask you to call.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(virus|infected|malware|hacked|trojan|spyware|compromised|security (breach|alert))\b`),
        re(String.raw`\b(call|contact|dial|ring)\b[^.!?\n]{0,40}?(\+?\d[\d -]{8,}\d|\b(support|helpline|technician|toll[- ]free|microsoft|apple|windows)\b)`),
      ]),
  ),
  rule(
    {
      id: "insurance.lapse_threat",
      category: "other",
      severity: "medium",
      weight: 0.35,
      description: "Says your policy will lapse or your bonus will be lost today unless you pay through a link — pay premiums only in the insurer's own app or website.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(policy|premium|bonus|insurance)\b[^.!?\n]{0,40}?\b(will (lapse|be lost|be cancelled|expire)|lapsed|lapsing)\b`),
        re(String.raw`\b(pay|renew|click|link|immediately|today|now)\b`),
      ]),
  ),
  rule(
    {
      id: "job.task_deposit",
      category: "job",
      severity: "high",
      weight: 0.6,
      description: "Asks you to deposit money to “unlock” earnings or complete a prepaid task — the task scam: the payouts stop once you pay.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(prepaid|merchant|recharge|premium|vip|combo) tasks?\b`),
        re(String.raw`\b(deposit|recharge|pay|invest)\b[^.!?\n]{0,50}?\b(to )?(unlock|release|withdraw|claim|receive)\b[^.!?\n]{0,30}?\b(commission|earnings|salary|profit|payout|balance|bonus)\b`),
        re(String.raw`\b(unlock|release|withdraw)\b[^.!?\n]{0,30}?\b(commission|earnings|profit|payout)\b[^.!?\n]{0,50}?\b(deposit|pay|recharge)\b`),
      ]),
  ),
  rule(
    {
      id: "invest.private_group_tips",
      category: "investment",
      severity: "medium",
      weight: 0.35,
      description: "Promotes paid stock or trading “tips”, VIP groups or pre-IPO allotments with promised profits — SEBI-registered advisers don't sell guaranteed gains over WhatsApp/Telegram.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(telegram|whatsapp|vip|premium|private|exclusive)\b[^.!?\n]{0,40}?\b(group|channel|membership|tips|calls|signals|allotment|advisor|adviser)\b|\bpre-?ipo\b`),
        re(String.raw`(\b\d+\s?%|\b\d+x\b)[^.!?\n]{0,30}?\b(profit|returns?|gains?|daily|weekly|monthly)\b|\b(guaranteed|assured|sure[- ]shot|no loss|risk[- ]free)\b|\bearning \d`),
      ]),
  ),
];
