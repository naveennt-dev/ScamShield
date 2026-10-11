"use client";

import Link from "next/link";
import { FileText, Image as ImageIcon, Link2, Mail } from "lucide-react";
import { RiskBadge } from "@/components/analysis/RiskBadge";
import type { HistoryItem, InputType } from "@/lib/schemas/analysis";

const ICON: Record<InputType, typeof FileText> = { message: FileText, url: Link2, image: ImageIcon, email: Mail };

export function HistoryList({ items }: { items: HistoryItem[] }) {
  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
      {items.map((i) => {
        const Icon = ICON[i.inputType];
        return (
          <li key={i.id}>
            <Link href={`/history/${i.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
              <Icon className="size-4 shrink-0 text-slate-500" aria-label={i.inputType} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-800">{i.preview ?? <span className="italic text-slate-500">Preview not stored</span>}</p>
                <p className="text-xs text-slate-500">
                  {new Date(i.createdAt).toLocaleString()} · {i.riskLevel === "safe" ? "No scam detected" : i.categoryLabel}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <RiskBadge level={i.riskLevel} />
                <span className="text-xs text-slate-500">{i.riskScore}/100</span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
