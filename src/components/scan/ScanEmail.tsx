"use client";

import { useState } from "react";
import { Loader2, Paperclip, ScanSearch, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AnalysisResultView } from "@/components/analysis/AnalysisResultView";
import { postJson } from "@/lib/client/api";
import type { AnalysisResult } from "@/lib/schemas/analysis";
import { useAnalysis } from "./useAnalysis";

interface Attachment {
  filename: string;
  contentType?: string;
  sizeBytes?: number;
}
type EmailResult = AnalysisResult & {
  email: { attachments: Array<{ filename: string; risk: "low" | "medium" | "high"; reason: string | null }> };
};

export function ScanEmail() {
  const [from, setFrom] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [authResults, setAuthResults] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [newAttachment, setNewAttachment] = useState("");
  const analysis = useAnalysis((payload: Record<string, unknown>) => postJson<EmailResult>("/api/v1/analyze/email", payload));

  const addAttachment = () => {
    const name = newAttachment.trim();
    if (name && attachments.length < 20) setAttachments((a) => [...a, { filename: name.slice(0, 255) }]);
    setNewAttachment("");
  };

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          analysis.mutate({
            from,
            ...(replyTo.trim() ? { replyTo } : {}),
            subject,
            body,
            ...(authResults.trim() ? { authenticationResults: authResults } : {}),
            attachments,
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From (as shown in your inbox)" htmlFor="from">
            <Input id="from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder='"SBI Alerts" <alerts@example.com>' required maxLength={512} />
          </Field>
          <Field label="Reply-To (optional)" htmlFor="replyTo">
            <Input id="replyTo" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} maxLength={512} />
          </Field>
        </div>
        <Field label="Subject" htmlFor="subject">
          <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={1000} />
        </Field>
        <Field label="Email body" htmlFor="body">
          <Textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={10000} />
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Attachment names (optional)</span>
          <p className="text-xs text-slate-500">
            Type the attachment file names only. Never upload or open suspicious attachments — ScamShield checks the names, not the files.
          </p>
          <div className="flex gap-2">
            <Input
              value={newAttachment}
              onChange={(e) => setNewAttachment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAttachment();
                }
              }}
              placeholder="e.g. invoice.pdf.exe"
              maxLength={255}
            />
            <Button type="button" variant="outline" onClick={addAttachment}>
              <Paperclip /> Add
            </Button>
          </div>
          {attachments.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <li key={`${a.filename}-${i}`} className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs">
                  {a.filename}
                  <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))}>
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-slate-700">Advanced: Authentication-Results header</summary>
          <Textarea
            className="mt-2 font-mono text-xs"
            value={authResults}
            onChange={(e) => setAuthResults(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="spf=pass smtp.mailfrom=…; dkim=pass …; dmarc=pass …"
          />
        </details>

        <Button type="submit" disabled={analysis.isPending || !from.trim() || (!subject.trim() && !body.trim())} className="self-start">
          {analysis.isPending ? <Loader2 className="animate-spin" /> : <ScanSearch />}
          {analysis.isPending ? "Analysing…" : "Check email"}
        </Button>
      </form>

      {analysis.data && analysis.data.email.attachments.some((a) => a.risk !== "low") && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-semibold text-red-800">Risky attachments — do not open:</p>
          <ul className="mt-1 list-disc pl-5 text-red-800">
            {analysis.data.email.attachments
              .filter((a) => a.risk !== "low")
              .map((a) => (
                <li key={a.filename}>
                  {a.filename}: {a.reason}
                </li>
              ))}
          </ul>
        </div>
      )}
      {analysis.data && <AnalysisResultView result={analysis.data} reportContent={`${subject}\n\n${body}`} />}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}
