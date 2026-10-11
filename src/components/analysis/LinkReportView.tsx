"use client";

import { AlertOctagon, AlertTriangle, CheckCircle2, HelpCircle, ShieldAlert } from "lucide-react";
import type { LinkReport } from "@/lib/schemas/link";
import { cn } from "@/lib/utils";

const VERDICT_STYLE: Record<LinkReport["verdict"], { panel: string; text: string; Icon: typeof ShieldAlert }> = {
  malicious: { panel: "bg-red-50 border-red-300", text: "text-red-800", Icon: AlertOctagon },
  high_risk: { panel: "bg-orange-50 border-orange-300", text: "text-orange-800", Icon: ShieldAlert },
  suspicious: { panel: "bg-amber-50 border-amber-300", text: "text-amber-800", Icon: AlertTriangle },
  no_known_threat: { panel: "bg-emerald-50 border-emerald-200", text: "text-emerald-800", Icon: CheckCircle2 },
  inconclusive: { panel: "bg-slate-50 border-slate-300", text: "text-slate-700", Icon: HelpCircle },
};
const KIND_LABEL = { confirmed_intel: "Confirmed (threat list)", observed_behaviour: "Observed", heuristic: "Warning sign", ai_opinion: "AI opinion" } as const;
const STATUS_LABEL = { done: "Checked", skipped: "Skipped", failed: "Failed", unavailable: "Unavailable", not_applicable: "Not applicable" } as const;
const PAGE_LABEL: Record<LinkReport["page"]["kind"], string> = {
  official_youtube: "Official YouTube page",
  youtube_redirect: "YouTube redirect to another website",
  youtube_imitation: "Imitates YouTube (not a YouTube website)",
  third_party_with_youtube_embed: "Another website with an embedded YouTube video",
  third_party: "Website",
  download: "File download",
  not_inspected: "Page not inspected",
};

export function LinkReportView({ report }: { report: LinkReport }) {
  const s = VERDICT_STYLE[report.verdict];
  return (
    <section aria-live="polite" className="flex flex-col gap-4" data-testid="link-report">
      <div className={cn("rounded-2xl border p-5", s.panel)}>
        <div className="flex items-center gap-2">
          <s.Icon className={cn("size-7", s.text)} aria-hidden />
          <h2 className={cn("text-2xl font-bold", s.text)} data-testid="link-verdict">{report.verdictLabel}</h2>
        </div>
        <p className="mt-2 text-sm text-slate-800">{report.summary}</p>
        <p className="mt-2 text-sm font-medium text-slate-900">{report.recommendedAction}</p>
        {report.displayHostname && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-500">Website</dt>
            <dd className="font-mono break-all">{report.displayHostname}{report.displayHostname !== report.hostname ? ` (${report.hostname})` : ""}</dd>
            <dt className="text-slate-500">Page type</dt>
            <dd>{PAGE_LABEL[report.page.kind]}</dd>
            {report.finalUrl && report.redirectChain.length > 1 && (
              <>
                <dt className="text-slate-500">Leads to</dt>
                <dd className="font-mono break-all">{report.finalUrl}</dd>
              </>
            )}
          </dl>
        )}
        {report.page.youtube.note && <p className="mt-2 text-xs text-slate-700">{report.page.youtube.note}</p>}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-2 font-semibold">Findings by type</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {report.categories.map((c) => (
            <li key={c.category} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="font-medium">{c.label}</div>
              <div className={cn("text-xs", c.status === "indicators_found" ? "text-red-700" : c.status === "none_found" ? "text-slate-600" : "text-slate-400")}>
                {c.status === "indicators_found" ? "Warning signs found" : c.status === "none_found" ? "None found by the checks that ran" : "Not checked"}
              </div>
              {c.evidence.map((e) => <p key={e} className="mt-1 text-xs text-slate-700">• {e}</p>)}
            </li>
          ))}
        </ul>
      </div>

      {report.evidence.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="mb-2 font-semibold">Evidence</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {report.evidence.map((e) => (
              <li key={`${e.id}-${e.detail}`} className="flex gap-2">
                <span className={cn("shrink-0 rounded px-1.5 text-xs leading-5", e.kind === "confirmed_intel" || e.kind === "observed_behaviour" ? "bg-red-100 text-red-800" : e.kind === "ai_opinion" ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-700")}>{KIND_LABEL[e.kind]}</span>
                <span>{e.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.redirectChain.length > 1 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <h3 className="mb-2 font-semibold">Redirect chain</h3>
          <ol className="list-decimal pl-5 font-mono text-xs">{report.redirectChain.map((h) => <li key={h.url} className="break-all">{h.url}{h.status ? ` (${h.status})` : ""}</li>)}</ol>
        </div>
      )}

      {report.dynamic && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <h3 className="mb-1 font-semibold">Page behaviour (isolated browser)</h3>
          <p className="text-xs text-slate-600">{report.dynamic.detail}</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-slate-500">Observed for</dt><dd>{Math.round(report.dynamic.observedWindowMs / 1000)} s</dd>
            <dt className="text-slate-500">Requests</dt><dd>{report.dynamic.requests.total} ({report.dynamic.requests.thirdPartyHosts.length} other websites)</dd>
            <dt className="text-slate-500">Typed data sent away</dt><dd>{report.dynamic.typedDataSentTo.length ? report.dynamic.typedDataSentTo.join(", ") : "not observed"}</dd>
            <dt className="text-slate-500">Downloads tried</dt><dd>{report.dynamic.downloadsAttempted.length ? report.dynamic.downloadsAttempted.join(", ") : "none"}</dd>
            <dt className="text-slate-500">Permissions asked</dt><dd>{report.dynamic.permissionRequests.length ? report.dynamic.permissionRequests.join(", ") : "none"}</dd>
            <dt className="text-slate-500">Blocked internal access</dt><dd>{report.dynamic.requests.blocked.length}</dd>
          </dl>
        </div>
      )}

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-semibold">What was checked, limitations and who received what</summary>
        <table className="mt-2 w-full text-xs">
          <tbody>
            {report.coverage.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="py-1 pr-2">{c.label}</td>
                <td className={cn("py-1 pr-2", c.status === "failed" ? "text-red-700" : c.status === "done" ? "text-emerald-700" : "text-slate-500")}>{STATUS_LABEL[c.status]}</td>
                <td className="py-1 text-slate-600">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.limitations.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-slate-700">{report.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
        <p className="mt-3 text-xs font-medium">Sent outside this device</p>
        {report.disclosures.length ? <ul className="list-disc pl-5 text-xs text-slate-700">{report.disclosures.map((d) => <li key={d}>{d}</li>)}</ul> : <p className="text-xs text-slate-600">Nothing.</p>}
      </details>
    </section>
  );
}
