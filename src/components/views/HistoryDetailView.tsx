"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AnalysisResultView } from "@/components/analysis/AnalysisResultView";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import type { AnalysisResult } from "@/lib/schemas/analysis";

type Stored = AnalysisResult & { preview: string | null; expiresAt: string };

export function HistoryDetailView({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["history", "item", id], queryFn: () => apiFetch<Stored>(`/api/v1/history/${encodeURIComponent(id)}`) });
  const del = useMutation({
    mutationFn: () => apiFetch(`/api/v1/history/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Scan deleted.");
      qc.invalidateQueries({ queryKey: ["history"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      router.replace("/history");
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Link href="/history" className="flex items-center gap-1 text-sm text-sky-700 hover:underline">
          <ArrowLeft className="size-4" /> Back to history
        </Link>
        {q.data && (
          <Button variant="outline" size="sm" onClick={() => del.mutate()} disabled={del.isPending}>
            <Trash2 /> Delete
          </Button>
        )}
      </div>
      {q.isLoading && <Loader2 className="size-5 animate-spin text-slate-500" />}
      {q.error && (
        <p className="text-sm text-red-700">{q.error instanceof ApiClientError && q.error.status === 404 ? "This scan was not found or has expired." : "Could not load this scan."}</p>
      )}
      {q.data && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <p className="text-xs text-slate-500">
              Scanned {new Date(q.data.createdAt).toLocaleString()} · kept until {new Date(q.data.expiresAt).toLocaleDateString()}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-slate-800">{q.data.preview ?? "Content preview was not stored for this scan."}</p>
          </div>
          <AnalysisResultView result={q.data} />
        </>
      )}
    </div>
  );
}
