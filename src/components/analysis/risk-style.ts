import type { RiskLevel } from "@/lib/schemas/analysis";

export const RISK_STYLE: Record<RiskLevel, { badge: string; ring: string; text: string; panel: string; stroke: string }> = {
  safe: { badge: "bg-emerald-600 text-white", ring: "ring-emerald-200", text: "text-emerald-700", panel: "bg-emerald-50 border-emerald-200", stroke: "#059669" },
  suspicious: { badge: "bg-amber-500 text-white", ring: "ring-amber-200", text: "text-amber-700", panel: "bg-amber-50 border-amber-200", stroke: "#d97706" },
  high: { badge: "bg-orange-600 text-white", ring: "ring-orange-200", text: "text-orange-700", panel: "bg-orange-50 border-orange-200", stroke: "#ea580c" },
  critical: { badge: "bg-red-700 text-white", ring: "ring-red-200", text: "text-red-700", panel: "bg-red-50 border-red-200", stroke: "#b91c1c" },
};
