"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Flag, Info, Link2, ShieldAlert, Sparkles } from "lucide-react";
import { CircularProgressbar, buildStyles } from "react-circular-progressbar";
import "react-circular-progressbar/dist/styles.css";
import { Button } from "@/components/ui/button";
import { RISK_LEVEL_LABELS, type AnalysisResult, type Severity } from "@/lib/schemas/analysis";
import { cn } from "@/lib/utils";
import { ReportForm } from "./ReportForm";
import { RISK_STYLE } from "./risk-style";

const SOURCE_LABEL: Record<string, string> = {
  rules: "Safety rules",
  ml: "ML classifier",
  url: "Link analysis",
  llm: "AI analysis",
  email: "Email checks",
  intel: "Community reports",
};

const SEVERITY_STYLE: Record<Severity, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

const UNASSESSED_STYLE = { badge: "bg-slate-500 text-white", ring: "ring-slate-200", text: "text-slate-700", panel: "bg-slate-50 border-slate-300", stroke: "#64748b" };

export function AnalysisResultView({ result, reportContent }: { result: AnalysisResult; reportContent?: string }) {
  const [showReport, setShowReport] = useState(false);
  // A "nothing found" from an incomplete check is not a safe verdict.
  const unassessed = result.riskLevel === "safe" && result.assessment?.status === "insufficient";
  const style = unassessed ? UNASSESSED_STYLE : RISK_STYLE[result.riskLevel];
  const Icon = unassessed ? AlertTriangle : result.riskLevel === "safe" ? CheckCircle2 : result.riskLevel === "suspicious" ? AlertTriangle : ShieldAlert;
  const suspiciousUrls = result.urls.filter((u) => u.riskScore >= 30);

  return (
    <section aria-live="polite" className="flex flex-col gap-4" data-testid="analysis-result">
      {/* Verdict */}
      <div className={cn("rounded-2xl border p-5 md:p-6", style.panel)}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="size-28 shrink-0 self-center sm:self-auto">
            <CircularProgressbar
              value={result.riskScore}
              text={`${result.riskScore}`}
              styles={buildStyles({ pathColor: style.stroke, textColor: style.stroke, trailColor: "#e2e8f0", textSize: "26px" })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Icon className={cn("size-7", style.text)} aria-hidden />
              <h2 className={cn("text-2xl font-bold tracking-tight", style.text)} data-testid="risk-level">
                {unassessed ? "Unable to assess" : RISK_LEVEL_LABELS[result.riskLevel]}
              </h2>
            </div>
            {unassessed && (
              <p className="text-sm text-slate-700" data-testid="unable-to-assess">
                No warning signs were found, but {result.assessment.reasons.join(" and ")} — so this is not a safe verdict.
              </p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              <dt className="text-slate-500">Risk score</dt>
              <dd className="font-semibold">{result.riskScore}/100</dd>
              <dt className="text-slate-500">Confidence</dt>
              <dd className="font-semibold">{Math.round(result.confidence * 100)}%</dd>
              {result.riskLevel !== "safe" && (
                <>
                  <dt className="text-slate-500">Category</dt>
                  <dd className="font-semibold">{result.categoryLabel}</dd>
                </>
              )}
            </dl>
            <p className="text-sm text-slate-700">{result.explanation}</p>
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500" data-testid="analysis-source">
        {result.remoteAnalysis?.used
          ? "Checked by ScamShield's local engine + AI second opinion."
          : result.remoteAnalysis?.requested
            ? "Checked by ScamShield's local engine only — remote AI was requested but not used."
            : "Checked by ScamShield's local engine only (no remote AI)."}
      </p>

      {result.warnings.length > 0 && (
        <div className="flex gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <ul className="flex flex-col gap-0.5">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Why */}
        <Card title="Why this was detected">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-slate-800">
            {result.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
        </Card>

        {/* What to do */}
        <Card title="What you should do">
          <ul className="flex flex-col gap-2 text-sm text-slate-800">
            {result.recommendedActions.map((a) => (
              <li key={a} className="flex gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-sky-700" aria-hidden />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {suspiciousUrls.length > 0 && (
        <Card title="Suspicious links">
          <ul className="flex flex-col gap-3">
            {suspiciousUrls.map((u) => (
              <li key={u.url} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-mono text-sm">
                    <Link2 className="size-4 shrink-0 text-slate-500" aria-hidden />
                    {/* Rendered as text, never as a clickable link. */}
                    <span className="truncate">{u.hostname || u.url}</span>
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-slate-600">{u.riskScore}/100</span>
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {u.flags.map((f) => (
                    <li key={f.id + f.detail} className="flex items-start gap-2 text-xs text-slate-700">
                      <span className={cn("rounded px-1.5 py-0.5 font-medium", SEVERITY_STYLE[f.severity])}>{f.severity}</span>
                      {f.detail}
                    </li>
                  ))}
                </ul>
                {u.finalUrl && u.finalUrl !== u.url && <p className="mt-2 text-xs text-slate-500">Leads to: {u.finalUrl}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {result.aiSummary && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <Sparkles className="size-4 text-violet-600" aria-hidden /> AI summary
            </span>
          }
        >
          <p className="text-sm text-slate-700">{result.aiSummary}</p>
          <p className="mt-2 text-xs text-slate-500">
            AI output is one input among several and cannot lower the score below what the safety rules found.
          </p>
        </Card>
      )}

      <Details title={`Detected indicators (${result.indicators.length})`}>
        {result.indicators.length === 0 ? (
          <p className="text-sm text-slate-600">No specific indicators.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {result.indicators.map((i, idx) => (
              <li key={`${i.type}-${idx}`} className="flex flex-col gap-1 rounded-lg bg-slate-50 p-2 text-xs sm:flex-row sm:items-start sm:gap-3">
                <span className={cn("self-start rounded px-1.5 py-0.5 font-medium", SEVERITY_STYLE[i.severity])}>{i.severity}</span>
                <span className="font-medium text-slate-700">{SOURCE_LABEL[i.source] ?? i.source}</span>
                <span className="font-mono text-slate-500">{i.type}</span>
                <span className="text-slate-700 break-words">{i.evidence}</span>
              </li>
            ))}
          </ul>
        )}
      </Details>

      <Details title="How the score was calculated">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 font-medium">Detector</th>
              <th className="py-1 font-medium">Score</th>
              <th className="py-1 font-medium">Confidence</th>
              <th className="py-1 font-medium">Weight used</th>
            </tr>
          </thead>
          <tbody>
            {result.signals.map((s) => (
              <tr key={s.source} className="border-t border-slate-100 align-top">
                <td className="py-1.5 font-medium">
                  {SOURCE_LABEL[s.source]}
                  {s.note && <p className="font-normal text-slate-500">{s.note}</p>}
                </td>
                <td className="py-1.5">{s.available ? s.score : "—"}</td>
                <td className="py-1.5">{s.confidence !== null ? `${Math.round(s.confidence * 100)}%` : "—"}</td>
                <td className="py-1.5">{s.available ? `${Math.round(s.effectiveWeight * 100)}%` : "not used"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.adjustments.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-xs text-slate-600">
            {result.adjustments.map((a) => (
              <li key={a.reason}>
                ↑ {a.reason} ({a.from} → {a.to})
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          {result.modelMetadata.llm ? `AI: ${result.modelMetadata.llm.model} (${result.modelMetadata.llm.status}). ` : "AI: not used. "}
          {result.modelMetadata.ml ? `ML model: ${result.modelMetadata.ml.version}${result.modelMetadata.ml.seedModel ? " (seed)" : ""}.` : "ML model: not used."}
        </p>
      </Details>

      {result.riskLevel !== "safe" || reportContent ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          {showReport ? (
            <ReportForm
              initialContent={reportContent ?? ""}
              initialCategory={result.category}
              initialType={result.inputType === "url" ? "url" : "message"}
              analysisId={result.id}
              lockContent={Boolean(reportContent)}
              onDone={() => setShowReport(false)}
            />
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-slate-700">Received this? Reporting helps protect other people.</p>
              <Button variant="outline" onClick={() => setShowReport(true)} disabled={!reportContent && !result.id}>
                <Flag /> Report scam
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Card({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

function Details({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-slate-900">
        {title}
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
