"use client";

import { useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AnalysisResultView } from "@/components/analysis/AnalysisResultView";
import { postJson } from "@/lib/client/api";
import type { AnalysisResult } from "@/lib/schemas/analysis";
import { RemoteAnalysisToggle } from "./RemoteAnalysisToggle";
import { useAnalysis } from "./useAnalysis";

const MAX = 10000;

export function ScanMessage() {
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [remote, setRemote] = useState(false);
  const analysis = useAnalysis((m: string) =>
    postJson<AnalysisResult>("/api/v1/analyze/message", { message: m, analysisMode: remote ? "remote-assisted" : "local" }),
  );

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!message.trim()) return;
          setSubmitted(message);
          analysis.mutate(message);
        }}
      >
        <label htmlFor="message" className="text-sm font-medium">
          Paste the suspicious SMS, WhatsApp or chat message
        </label>
        <Textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={MAX}
          rows={7}
          placeholder="Paste the full message here…"
          className="bg-white"
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {message.length.toLocaleString()}/{MAX.toLocaleString()}
            </span>
            <Button type="submit" disabled={analysis.isPending || !message.trim()}>
              {analysis.isPending ? <Loader2 className="animate-spin" /> : <ScanSearch />}
              {analysis.isPending ? "Analysing…" : "Check message"}
            </Button>
          </div>
        </div>
        <RemoteAnalysisToggle checked={remote} onChange={setRemote} />
        <p className="text-xs text-slate-500">
          Don&apos;t paste passwords or full card numbers. We store only a masked preview in your history (you can turn this off in Settings).
        </p>
      </form>
      {analysis.data && <AnalysisResultView result={analysis.data} reportContent={submitted} />}
    </div>
  );
}
