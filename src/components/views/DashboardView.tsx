"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Image as ImageIcon, Link2, Loader2, Mail, MessageSquareText, ScanSearch, ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/app/PageHeader";
import { apiFetch } from "@/lib/client/api";
import type { DashboardStats } from "@/lib/schemas/analysis";
import { HistoryList } from "./HistoryList";

export function DashboardView() {
  const { data, isLoading, error } = useQuery({ queryKey: ["stats"], queryFn: () => apiFetch<DashboardStats>("/api/v1/stats") });

  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <QuickAction href="/scan/message" icon={MessageSquareText} label="Scan message" />
        <QuickAction href="/scan/url" icon={Link2} label="Scan link" />
        <QuickAction href="/scan/screenshot" icon={ImageIcon} label="Scan screenshot" />
        <QuickAction href="/scan/email" icon={Mail} label="Scan email" />
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="size-4 animate-spin" /> Loading your stats…
        </p>
      )}
      {error && <p className="text-sm text-red-700">Could not load your dashboard. Please refresh.</p>}

      {data && (
        <>
          <section aria-label="Your scan statistics" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Total scans" value={data.totalScans} icon={ScanSearch} tone="text-sky-700" />
            <Stat label="Scams detected" value={data.scamsDetected} icon={ShieldAlert} tone="text-red-700" />
            <Stat label="Suspicious" value={data.suspicious} icon={AlertTriangle} tone="text-amber-600" />
            <Stat label="Safe" value={data.safe} icon={CheckCircle2} tone="text-emerald-700" />
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section className="min-w-0">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Recent scans</h2>
                {data.recent.length > 0 && (
                  <Link href="/history" className="text-sm text-sky-700 hover:underline">
                    View all
                  </Link>
                )}
              </div>
              {data.recent.length ? (
                <HistoryList items={data.recent} />
              ) : (
                <EmptyState title="No scans yet">Check your first suspicious message to see results here.</EmptyState>
              )}
            </section>
            <section className="min-w-0">
              <h2 className="mb-3 text-lg font-semibold">Top scam categories</h2>
              {data.topCategories.length ? (
                <ul className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4">
                  {data.topCategories.map((c) => {
                    const max = data.topCategories[0].count;
                    return (
                      <li key={c.category} className="text-sm">
                        <div className="flex justify-between">
                          <span>{c.label}</span>
                          <span className="font-semibold">{c.count}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded bg-slate-100">
                          <div className="h-1.5 rounded bg-red-500" style={{ width: `${Math.max(6, (c.count / max) * 100)}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState title="Nothing risky found yet">Categories appear once a scan is flagged as suspicious or a scam.</EmptyState>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof ScanSearch; tone: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        <Icon className={`size-4 ${tone}`} aria-hidden />
      </div>
      <p className="mt-2 text-2xl font-semibold" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: typeof ScanSearch; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900 hover:bg-sky-100"
    >
      <Icon className="size-5" aria-hidden /> {label}
    </Link>
  );
}
