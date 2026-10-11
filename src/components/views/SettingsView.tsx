"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/client/api";

interface Settings {
  storeContentPreview: boolean;
  retentionDays: number;
  allowLlmAnalysis: boolean;
}

export function SettingsView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => apiFetch<Settings>("/api/v1/settings") });
  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => apiFetch<Settings>("/api/v1/settings", { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      toast.success("Settings saved.");
    },
    onError: () => toast.error("Could not save settings."),
  });

  if (q.isLoading) return <Loader2 className="size-5 animate-spin text-slate-500" />;
  if (!q.data) return <p className="text-sm text-red-700">Could not load settings.</p>;
  const s = q.data;

  return (
    <div className="flex flex-col gap-4">
      <Toggle
        title="Save a masked preview in history"
        description="Shows the first ~240 characters of each scan in your history, with numbers, emails and UPI IDs masked. When off, only the result is stored."
        checked={s.storeContentPreview}
        onChange={(v) => save.mutate({ storeContentPreview: v })}
      />
      <Toggle
        title="AI second opinion"
        description="Sends the text you scan to a third-party AI model for a second opinion and a plain-language summary. When off, ScamShield uses only its own rules, ML model and link checks."
        checked={s.allowLlmAnalysis}
        onChange={(v) => save.mutate({ allowLlmAnalysis: v })}
      />
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label htmlFor="retention" className="font-medium">
          Keep my scan history for
        </label>
        <p className="mt-1 text-sm text-slate-600">Older scans are deleted automatically. Applies to new scans.</p>
        <select
          id="retention"
          className="mt-3 h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          value={s.retentionDays}
          onChange={(e) => save.mutate({ retentionDays: Number(e.target.value) })}
        >
          {[7, 30, 90, 180, 365].map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Toggle({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <span>
        <span className="font-medium">{title}</span>
        <span className="mt-1 block text-sm text-slate-600">{description}</span>
      </span>
      <input type="checkbox" className="mt-1 size-5 shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
