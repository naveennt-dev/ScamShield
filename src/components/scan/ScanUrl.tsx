"use client";

import { useRef, useState } from "react";
import { Loader2, ScanSearch, ScanEye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LinkReportView } from "@/components/analysis/LinkReportView";
import { apiFetch } from "@/lib/client/api";
import type { LinkReport } from "@/lib/schemas/link";

const STAGES = ["Checking the address…", "Following redirects safely…", "Reading the page (without running it)…", "Checking threat lists and AI second opinion…"];
const DYNAMIC_STAGES = ["Starting an isolated browser…", "Loading the page with test data only…", "Watching what the page does…", "Closing and deleting the isolated browser…"];

export function ScanUrl() {
  const [url, setUrl] = useState("");
  const [online, setOnline] = useState(true);
  const [report, setReport] = useState<LinkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "scan" | "inspect">(null);
  const [stage, setStage] = useState(0);
  const ctrl = useRef<AbortController | null>(null);

  async function run(inspectBehaviour: boolean) {
    if (!url.trim()) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(inspectBehaviour ? "inspect" : "scan");
    setError(null);
    setStage(0);
    const ticker = setInterval(() => setStage((s) => Math.min(s + 1, 3)), inspectBehaviour ? 5000 : 2000);
    try {
      const r = await apiFetch<LinkReport>("/api/v1/analyze/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), analysisMode: online ? "remote-assisted" : "local", inspectBehaviour }),
        signal: c.signal,
      });
      setReport(r);
    } catch (e) {
      setError(c.signal.aborted ? "Cancelled. Nothing was marked safe." : e instanceof Error ? e.message : "The link couldn't be checked.");
    } finally {
      clearInterval(ticker);
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(false);
        }}
      >
        <label htmlFor="url" className="text-sm font-medium">Link to check</label>
        <Input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a link — it is never opened in your browser" maxLength={4096} autoComplete="off" spellCheck={false} className="bg-white font-mono" />
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} className="mt-0.5 size-4" />
          <span>
            Online checks: ScamShield&apos;s inspector contacts the website (never your browser, never with your cookies), configured threat lists and the AI second opinion.
            Off = on this device only: just the address is analysed.
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={Boolean(busy) || !url.trim()}>
            {busy === "scan" ? <Loader2 className="animate-spin" /> : <ScanSearch />}
            Check link
          </Button>
          <Button type="button" variant="outline" disabled={Boolean(busy) || !url.trim() || !online} onClick={() => void run(true)} title="Loads the page in a disposable isolated browser with test data only (10–25 s)">
            {busy === "inspect" ? <Loader2 className="animate-spin" /> : <ScanEye />}
            Inspect page behaviour
          </Button>
          {busy && (
            <Button type="button" variant="ghost" onClick={() => ctrl.current?.abort()}>
              <X /> Cancel
            </Button>
          )}
        </div>
        {busy && <p className="text-sm text-slate-600" role="status">{(busy === "inspect" ? DYNAMIC_STAGES : STAGES)[stage]}</p>}
        {!online && <p className="text-xs text-slate-500">Page-behaviour inspection needs online checks.</p>}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </form>
      {report && <LinkReportView report={report} />}
    </div>
  );
}
