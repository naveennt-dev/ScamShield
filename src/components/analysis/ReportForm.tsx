"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Flag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ApiClientError, postJson } from "@/lib/client/api";
import { CATEGORY_LABELS, SCAM_CATEGORIES, type ReportItem, type ScamCategory } from "@/lib/schemas/analysis";

export function ReportForm({
  initialContent = "",
  initialCategory = "other",
  initialType = "message",
  analysisId,
  onDone,
  lockContent = false,
}: {
  initialContent?: string;
  initialCategory?: ScamCategory;
  initialType?: "message" | "url" | "other";
  analysisId?: string | null;
  onDone?: () => void;
  lockContent?: boolean;
}) {
  const qc = useQueryClient();
  const [content, setContent] = useState(initialContent);
  const [category, setCategory] = useState<ScamCategory>(initialCategory);
  const [reportType, setReportType] = useState(initialType);
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState<"scam" | "suspicious" | "false_positive">("scam");

  const mutation = useMutation({
    mutationFn: () =>
      postJson<ReportItem>("/api/v1/reports", {
        reportType,
        content,
        category,
        verdict,
        ...(analysisId ? { analysisId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: (r) => {
      toast.success(
        r.communityReports > 1 ? `Reported. ${r.communityReports} people have now reported this.` : "Thanks — your report was recorded.",
      );
      qc.invalidateQueries({ queryKey: ["reports"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      onDone?.();
    },
    onError: (e) => toast.error(e instanceof ApiClientError ? e.message : "Could not submit the report."),
  });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Your verdict</span>
        <select
          className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as typeof verdict)}
        >
          <option value="scam">This is a scam</option>
          <option value="suspicious">This looks suspicious</option>
          <option value="false_positive">ScamShield got this wrong (not a scam)</option>
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">What are you reporting?</span>
          <select
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
            value={reportType}
            onChange={(e) => setReportType(e.target.value as typeof reportType)}
          >
            <option value="message">Message</option>
            <option value="url">Link / URL</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Scam type</span>
          <select
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as ScamCategory)}
          >
            {SCAM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!lockContent && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{reportType === "url" ? "Link" : "Message"}</span>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} maxLength={10000} required rows={4} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Note (optional)</span>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} placeholder="e.g. They called pretending to be from my bank" />
      </label>
      <p className="text-xs text-slate-500">
        Only a fingerprint and a masked preview are stored. Other users never see your report — only how many people reported the same thing.
      </p>
      <Button type="submit" disabled={mutation.isPending || !content.trim()} className="self-start">
        {mutation.isPending ? <Loader2 className="animate-spin" /> : <Flag />}
        Submit report
      </Button>
    </form>
  );
}
