/**
 * Free-model policy for OpenRouter (Phase 4).
 *
 * ScamShield only ever calls models that are free *right now*:
 *   1. Static check: the configured id must end in `:free` (OpenRouter's free variants).
 *   2. Live check: the model must be listed in OpenRouter's public catalogue (`GET /models`,
 *      no credentials, no user content) with prompt and completion price "0".
 *
 * Anything else is dropped from the chain — there is no automatic switch to a paid model. If no
 * configured model passes, remote analysis is skipped and the local result stands. The catalogue is
 * cached (default 1 h) so this adds at most one small request per hour, and only when a user has
 * requested remote analysis.
 */

export type ModelRejection = "not_free_variant" | "not_in_catalogue" | "not_free_price" | "catalogue_unavailable";

export interface FreeModelCheck {
  usable: string[];
  rejected: { model: string; reason: ModelRejection }[];
}

interface CatalogueEntry {
  id: string;
  pricing?: { prompt?: string | number; completion?: string | number };
}

export class FreeModelGuard {
  private cache: { at: number; prices: Map<string, boolean> } | null = null;

  constructor(
    private readonly opts: {
      baseUrl: string;
      requireFree: boolean;
      fetchImpl?: typeof fetch;
      ttlMs?: number;
      timeoutMs?: number;
      now?: () => number;
    },
  ) {}

  static isFreeVariant(model: string): boolean {
    return /:free$/i.test(model.trim());
  }

  async check(models: string[]): Promise<FreeModelCheck> {
    if (!this.opts.requireFree) return { usable: models, rejected: [] };
    const rejected: FreeModelCheck["rejected"] = [];
    const candidates = models.filter((m) => {
      if (FreeModelGuard.isFreeVariant(m)) return true;
      rejected.push({ model: m, reason: "not_free_variant" });
      return false;
    });
    if (candidates.length === 0) return { usable: [], rejected };

    const prices = await this.catalogue();
    if (!prices) return { usable: [], rejected: [...rejected, ...candidates.map((model) => ({ model, reason: "catalogue_unavailable" as const }))] };
    const usable: string[] = [];
    for (const m of candidates) {
      const free = prices.get(m);
      if (free === undefined) rejected.push({ model: m, reason: "not_in_catalogue" });
      else if (!free) rejected.push({ model: m, reason: "not_free_price" });
      else usable.push(m);
    }
    return { usable, rejected };
  }

  /** model id → true if both prices are zero. null when the catalogue can't be fetched/parsed. */
  private async catalogue(): Promise<Map<string, boolean> | null> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cache && now - this.cache.at < (this.opts.ttlMs ?? 3_600_000)) return this.cache.prices;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 4000);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/models`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: CatalogueEntry[] };
      if (!Array.isArray(body?.data)) return null;
      const prices = new Map<string, boolean>();
      for (const m of body.data) {
        if (typeof m?.id !== "string") continue;
        const zero = (v: unknown) => v !== undefined && v !== null && Number(v) === 0;
        prices.set(m.id, zero(m.pricing?.prompt) && zero(m.pricing?.completion));
      }
      this.cache = { at: now, prices };
      return prices;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
