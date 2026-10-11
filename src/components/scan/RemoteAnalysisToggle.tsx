"use client";

/**
 * Per-scan consent for remote analysis (Phase 4). Unchecked by default: the scan stays on this
 * ScamShield server (rules + local ML). When checked, only minimised text (no images, URL paths,
 * numbers or e-mail addresses) is sent to OpenRouter — and only if the server enables it.
 */
export function RemoteAnalysisToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-xs text-slate-600">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-slate-800">Also get an AI second opinion</span> — off by default. Sends the
        message text with links shortened to their domain and numbers/e-mails masked. Never the image. The local result is
        always shown, and the AI can only add warnings, never remove them.
      </span>
    </label>
  );
}
