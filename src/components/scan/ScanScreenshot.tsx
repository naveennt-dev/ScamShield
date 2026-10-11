"use client";

import { useEffect, useState } from "react";
import { ImageUp, Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnalysisResultView } from "@/components/analysis/AnalysisResultView";
import { apiFetch } from "@/lib/client/api";
import type { AnalysisResult } from "@/lib/schemas/analysis";
import { RemoteAnalysisToggle } from "./RemoteAnalysisToggle";
import { useAnalysis } from "./useAnalysis";

type ImageResult = AnalysisResult & { ocr: { extractedText: string; confidence: number | null } };

const MAX_BYTES = 5 * 1024 * 1024;

export function ScanScreenshot() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState(false);
  const analysis = useAnalysis((f: File) => {
    const fd = new FormData();
    fd.append("image", f);
    fd.append("analysisMode", remote ? "remote-assisted" : "local");
    return apiFetch<ImageResult>("/api/v1/analyze/image", { method: "POST", body: fd });
  });

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (f: File | null) => {
    setError(null);
    if (!f) return setFile(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) return setError("Please choose a PNG, JPEG or WebP image.");
    if (f.size > MAX_BYTES) return setError("The image must be 5 MB or smaller.");
    setFile(f);
  };

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (file) analysis.mutate(file);
        }}
      >
        <label
          htmlFor="image"
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 px-4 py-8 text-center hover:bg-slate-50"
        >
          <ImageUp className="size-8 text-slate-500" aria-hidden />
          <span className="text-sm font-medium">Choose a screenshot</span>
          <span className="text-xs text-slate-500">PNG, JPEG or WebP, up to 5 MB</span>
          <input id="image" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element -- local blob preview, not optimisable
          <img src={preview} alt="Selected screenshot preview" className="max-h-72 self-center rounded-lg border border-slate-200 object-contain" />
        )}
        <Button type="submit" disabled={!file || analysis.isPending} className="self-start">
          {analysis.isPending ? <Loader2 className="animate-spin" /> : <ScanSearch />}
          {analysis.isPending ? "Reading & analysing…" : "Analyse screenshot"}
        </Button>
        <RemoteAnalysisToggle checked={remote} onChange={setRemote} />
        <p className="text-xs text-slate-500">The image is processed to extract text and is not stored.</p>
      </form>
      {analysis.data && (
        <>
          <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <summary className="cursor-pointer font-semibold">Text we read from the image</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-slate-700">{analysis.data.ocr.extractedText}</pre>
          </details>
          <AnalysisResultView result={analysis.data} reportContent={analysis.data.ocr.extractedText} />
        </>
      )}
    </div>
  );
}
