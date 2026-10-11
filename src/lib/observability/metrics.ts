/**
 * In-process metrics registry with Prometheus text exposition.
 *
 * Scope/limitations: counters live in the memory of a single server instance. On serverless
 * platforms each instance has its own registry, so scrape results are per-instance. For
 * fleet-wide metrics, forward these via an OpenTelemetry exporter or push gateway (see
 * docs/deployment/production.md).
 */

type Labels = Record<string, string>;

const HISTOGRAM_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 40000];

interface Series {
  help: string;
  type: "counter" | "histogram";
  values: Map<string, number>;
  histos: Map<string, { buckets: number[]; sum: number; count: number }>;
}

const registry = new Map<string, Series>();

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`)
    .join(",");
}

function series(name: string, help: string, type: Series["type"]): Series {
  let s = registry.get(name);
  if (!s) {
    s = { help, type, values: new Map(), histos: new Map() };
    registry.set(name, s);
  }
  return s;
}

export function incCounter(name: string, help: string, labels: Labels = {}, by = 1): void {
  const s = series(name, help, "counter");
  const k = key(labels);
  s.values.set(k, (s.values.get(k) ?? 0) + by);
}

export function observeMs(name: string, help: string, valueMs: number, labels: Labels = {}): void {
  const s = series(name, help, "histogram");
  const k = key(labels);
  let h = s.histos.get(k);
  if (!h) {
    h = { buckets: HISTOGRAM_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
    s.histos.set(k, h);
  }
  HISTOGRAM_BUCKETS_MS.forEach((b, i) => {
    if (valueMs <= b) h!.buckets[i]++;
  });
  h.sum += valueMs;
  h.count++;
}

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const [name, s] of registry) {
    lines.push(`# HELP ${name} ${s.help}`);
    lines.push(`# TYPE ${name} ${s.type}`);
    if (s.type === "counter") {
      for (const [k, v] of s.values) lines.push(`${name}${k ? `{${k}}` : ""} ${v}`);
    } else {
      for (const [k, h] of s.histos) {
        const sep = k ? `${k},` : "";
        HISTOGRAM_BUCKETS_MS.forEach((b, i) => lines.push(`${name}_bucket{${sep}le="${b}"} ${h.buckets[i]}`));
        lines.push(`${name}_bucket{${sep}le="+Inf"} ${h.count}`);
        lines.push(`${name}_sum${k ? `{${k}}` : ""} ${h.sum}`);
        lines.push(`${name}_count${k ? `{${k}}` : ""} ${h.count}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export function resetMetrics(): void {
  registry.clear();
}

/** Named helpers so metric names stay consistent across the codebase. */
export const metrics = {
  request(route: string, status: number) {
    incCounter("scamshield_http_requests_total", "HTTP requests handled", { route, status: String(status) });
  },
  requestLatency(route: string, ms: number) {
    observeMs("scamshield_http_request_duration_ms", "HTTP request latency (ms)", ms, { route });
  },
  analysis(inputType: string, riskLevel: string) {
    incCounter("scamshield_analyses_total", "Completed analyses", { input_type: inputType, risk_level: riskLevel });
  },
  llmCall(model: string, outcome: string) {
    incCounter("scamshield_llm_calls_total", "LLM call attempts by outcome", { model, outcome });
  },
  llmLatency(model: string, ms: number) {
    observeMs("scamshield_llm_latency_ms", "LLM call latency (ms)", ms, { model });
  },
  llmFallback(reason: string) {
    incCounter("scamshield_llm_fallback_total", "Times the router moved past the first model or to deterministic mode", { reason });
  },
  mlLatency(ms: number) {
    observeMs("scamshield_ml_inference_ms", "ML inference latency (ms)", ms);
  },
  mlFailure(reason: string) {
    incCounter("scamshield_ml_failures_total", "ML inference failures by reason", { reason });
  },
  urlAnalysisFailure(reason: string) {
    incCounter("scamshield_url_analysis_failures_total", "URL analysis failures", { reason });
  },
  ocrFailure(reason: string) {
    incCounter("scamshield_ocr_failures_total", "OCR failures", { reason });
  },
  rateLimited(scope: string, tier: string) {
    incCounter("scamshield_rate_limited_total", "Requests rejected by rate limiting", { scope, tier });
  },
  error(code: string) {
    incCounter("scamshield_errors_total", "Errors returned to clients", { code });
  },
};
