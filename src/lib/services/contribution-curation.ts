/**
 * Curation: which contributions may become training data. Pure function so it can be tested.
 *
 * User feedback is never ground truth by itself. Only rows a human reviewer marked ACCEPTED become
 * training examples (`verified`). Rows that pass the automatic checks below but were not reviewed
 * go to a review queue (`reviewQueue`) — never into training.
 *
 *  - Only labelled rows ("unsure" carries no label) that are not REJECTED.
 *  - Flagged rows (prompt-injection text; "safe" on an OTP/PIN/password request) are excluded
 *    unless a reviewer ACCEPTED them; prompt-injection text is never exported.
 *  - Consensus per message: at least MIN_CONTRIBUTORS distinct contributors and ≥ MIN_AGREEMENT on
 *    the label — or a reviewer-ACCEPTED row (then its label is used).
 *  - Unreliable contributors (disagree with a ≥3-contributor consensus more than half the time,
 *    over ≥ RELIABILITY_MIN_ITEMS messages) are dropped entirely.
 *  - One contributor's votes count on at most max(MIN_CAP, MAX_SHARE × messages) messages (never
 *    more than MAX_ITEMS_PER_CONTRIBUTOR); extra votes are ignored. MIN_CAP keeps small datasets
 *    usable; together with the two-contributor consensus and rate limits it bounds flooding.
 */

export const MIN_CONTRIBUTORS = 2;
export const MIN_AGREEMENT = 0.8;
export const RELIABILITY_MIN_ITEMS = 10;
export const MAX_SHARE = 0.05;
export const MAX_ITEMS_PER_CONTRIBUTOR = 200;
export const MIN_CAP = 10;

const TRAINING_CATEGORIES = new Set([
  "phishing", "banking", "upi", "kyc", "job", "investment", "lottery", "delivery", "loan",
  "romance", "tech_support", "government_impersonation", "malware", "credential_theft", "other",
]);

export interface ContributionRow {
  fingerprint: string;
  contributorHash: string;
  text: string;
  label: string | null;
  category: string | null;
  flags: string[];
  status: "QUARANTINED" | "ACCEPTED" | "REJECTED";
  createdAt: Date;
}

export interface CuratedExample {
  text: string;
  label: "scam" | "safe";
  category: string;
  source: "user-contribution";
  language: "en" | "hi" | "mixed";
  contributors: number;
  agreement: number;
}

export interface CurationReport {
  /** Reviewer-ACCEPTED only: the only rows that may be used for training. */
  verified: CuratedExample[];
  /** Passed consensus/reliability checks but not reviewed: for a human to check, never trained on. */
  reviewQueue: CuratedExample[];
  excluded: { flagged: number; noConsensus: number; tooFewContributors: number; unreliableContributors: number; cappedVotes: number };
}

const language = (t: string) => (/[ऀ-ॿ]/.test(t) ? (/[a-z]{3,}/i.test(t) ? "mixed" : "hi") : "en");

export function curate(rows: ContributionRow[]): CurationReport {
  const excluded = { flagged: 0, noConsensus: 0, tooFewContributors: 0, unreliableContributors: 0, cappedVotes: 0 };
  let usable = rows.filter((r) => r.status !== "REJECTED" && (r.label === "scam" || r.label === "safe"));
  usable = usable.filter((r) => {
    const bad = r.flags.includes("prompt_injection") || (r.flags.length > 0 && r.status !== "ACCEPTED");
    if (bad) excluded.flagged++;
    return !bad;
  });

  const group = (rs: ContributionRow[]) => {
    const g = new Map<string, ContributionRow[]>();
    for (const r of rs) g.set(r.fingerprint, [...(g.get(r.fingerprint) ?? []), r]);
    return g;
  };
  const majority = (rs: ContributionRow[]) => {
    const scam = rs.filter((r) => r.label === "scam").length;
    const label = scam * 2 >= rs.length ? "scam" : "safe";
    return { label, agreement: Math.max(scam, rs.length - scam) / rs.length };
  };

  // Reliability against strong consensus.
  const disagreements = new Map<string, { n: number; bad: number }>();
  for (const rs of group(usable).values()) {
    if (new Set(rs.map((r) => r.contributorHash)).size < 3) continue;
    const { label, agreement } = majority(rs);
    if (agreement < MIN_AGREEMENT) continue;
    for (const r of rs) {
      const d = disagreements.get(r.contributorHash) ?? { n: 0, bad: 0 };
      d.n++;
      if (r.label !== label) d.bad++;
      disagreements.set(r.contributorHash, d);
    }
  }
  const unreliable = new Set([...disagreements].filter(([, d]) => d.n >= RELIABILITY_MIN_ITEMS && d.bad / d.n > 0.5).map(([c]) => c));
  usable = usable.filter((r) => {
    if (unreliable.has(r.contributorHash)) excluded.unreliableContributors++;
    return !unreliable.has(r.contributorHash);
  });

  // Per-contributor influence cap (oldest votes kept).
  const groups = group(usable);
  const cap = Math.min(MAX_ITEMS_PER_CONTRIBUTOR, Math.max(MIN_CAP, Math.floor(groups.size * MAX_SHARE)));
  const used = new Map<string, number>();
  const capped = [...usable].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).filter((r) => {
    const n = used.get(r.contributorHash) ?? 0;
    if (n >= cap && r.status !== "ACCEPTED") {
      excluded.cappedVotes++;
      return false;
    }
    used.set(r.contributorHash, n + 1);
    return true;
  });

  const verified: CuratedExample[] = [];
  const reviewQueue: CuratedExample[] = [];
  for (const rs of group(capped).values()) {
    const accepted = rs.find((r) => r.status === "ACCEPTED");
    const contributors = new Set(rs.map((r) => r.contributorHash)).size;
    let label: "scam" | "safe";
    let agreement: number;
    if (accepted) {
      label = accepted.label as "scam" | "safe";
      agreement = 1;
    } else {
      if (contributors < MIN_CONTRIBUTORS) {
        excluded.tooFewContributors++;
        continue;
      }
      const m = majority(rs);
      if (m.agreement < MIN_AGREEMENT) {
        excluded.noConsensus++;
        continue;
      }
      label = m.label as "scam" | "safe";
      agreement = m.agreement;
    }
    const category = label === "safe" ? "other" : rs.map((r) => r.category).find((c) => c && TRAINING_CATEGORIES.has(c)) ?? "other";
    const ex: CuratedExample = { text: rs[0].text, label, category, source: "user-contribution", language: language(rs[0].text), contributors, agreement: Number(agreement.toFixed(3)) };
    (accepted ? verified : reviewQueue).push(ex);
  }
  return { verified, reviewQueue, excluded };
}
