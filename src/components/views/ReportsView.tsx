"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flag, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/PageHeader";
import { ReportForm } from "@/components/analysis/ReportForm";
import { apiFetch } from "@/lib/client/api";
import type { ReportItem } from "@/lib/schemas/analysis";

const STATUS: Record<ReportItem["status"], string> = { pending: "Under review", confirmed: "Confirmed scam", rejected: "Not confirmed" };

export function ReportsView() {
  const [showForm, setShowForm] = useState(false);
  const q = useQuery({ queryKey: ["reports"], queryFn: () => apiFetch<{ items: ReportItem[] }>("/api/v1/reports") });

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        {showForm ? (
          <ReportForm onDone={() => setShowForm(false)} />
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-700">Got a scam message or link? Report it so ScamShield can warn others.</p>
            <Button onClick={() => setShowForm(true)}>
              <Flag /> Report a scam
            </Button>
          </div>
        )}
      </div>

      <h2 className="text-lg font-semibold">Your reports</h2>
      {q.isLoading ? (
        <Loader2 className="size-5 animate-spin text-slate-500" />
      ) : q.error ? (
        <p className="text-sm text-red-700">Could not load your reports.</p>
      ) : !q.data?.items.length ? (
        <EmptyState title="You haven't reported anything yet" />
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {q.data.items.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-800">{r.preview}</p>
                <p className="text-xs text-slate-500">
                  {r.categoryLabel} · {new Date(r.createdAt).toLocaleDateString()} · {STATUS[r.status]}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-xs text-slate-600" title="People who reported the same content">
                <Users className="size-3.5" aria-hidden /> {r.communityReports} {r.communityReports === 1 ? "report" : "reports"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
