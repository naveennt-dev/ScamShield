import { RISK_LEVEL_LABELS, type RiskLevel } from "@/lib/schemas/analysis";
import { cn } from "@/lib/utils";
import { RISK_STYLE } from "./risk-style";

export function RiskBadge({ level, className }: { level: RiskLevel; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide", RISK_STYLE[level].badge, className)}>
      {RISK_LEVEL_LABELS[level]}
    </span>
  );
}
