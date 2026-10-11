"use client";

import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/PageHeader";
import { apiFetch } from "@/lib/client/api";
import type { HistoryItem } from "@/lib/schemas/analysis";
import { HistoryList } from "./HistoryList";

type Page = { items: HistoryItem[]; nextCursor: string | null };

export function HistoryView() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"" | "scam" | "suspicious" | "safe">("");
  const query = useInfiniteQuery({
    queryKey: ["history", filter],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "20" });
      if (pageParam) p.set("cursor", pageParam);
      if (filter) p.set("classification", filter);
      return apiFetch<Page>(`/api/v1/history?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const clearAll = useMutation({
    mutationFn: () => apiFetch<{ deleted: number }>("/api/v1/history", { method: "DELETE" }),
    onSuccess: (r) => {
      toast.success(`Deleted ${r.deleted} saved scans.`);
      qc.invalidateQueries({ queryKey: ["history"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: () => toast.error("Could not delete history."),
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="group" aria-label="Filter">
          {(["", "scam", "suspicious", "safe"] as const).map((f) => (
            <button
              key={f || "all"}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`rounded-full border px-3 py-1 text-xs ${filter === f ? "border-sky-700 bg-sky-700 text-white" : "border-slate-300 text-slate-700 hover:bg-slate-100"}`}
            >
              {f === "" ? "All" : f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={clearAll.isPending || items.length === 0}
          onClick={() => {
            if (window.confirm("Delete all saved scans? This cannot be undone.")) clearAll.mutate();
          }}
        >
          <Trash2 /> Delete all history
        </Button>
      </div>

      {query.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : query.error ? (
        <p className="text-sm text-red-700">Could not load history.</p>
      ) : items.length === 0 ? (
        <EmptyState title="No saved scans">Your scans appear here for as long as your retention setting allows.</EmptyState>
      ) : (
        <HistoryList items={items} />
      )}
      {query.hasNextPage && (
        <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage} className="self-center">
          {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null} Load more
        </Button>
      )}
    </div>
  );
}
