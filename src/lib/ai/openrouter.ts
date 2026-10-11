import { AIError, classifyHttpStatus, parseRetryAfter } from "./errors";

/**
 * Thin OpenRouter client (OpenAI-compatible `/chat/completions`). Provider-specific code lives
 * only here. It performs exactly ONE HTTP call per invocation; retries/fallbacks are the model
 * router's job.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  maxTokens: number;
  /** Ask for JSON mode. Some free models reject this; the router retries without it. */
  jsonMode: boolean;
  requestId: string;
}

export interface ChatResponse {
  content: string;
  /** Model actually used (OpenRouter may route a slug to a concrete version). */
  model: string;
  latencyMs: number;
}

export interface OpenRouterConfig {
  apiKey: string | undefined;
  baseUrl: string;
  appUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

const MAX_RESPONSE_CHARS = 200_000;

export class OpenRouterClient {
  readonly providerName = "openrouter";
  private readonly cfg: OpenRouterConfig;

  constructor(cfg: OpenRouterConfig) {
    this.cfg = cfg;
  }

  get configured(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.cfg.apiKey) throw new AIError("NOT_CONFIGURED", "OPENROUTER_API_KEY is not set");

    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    const started = Date.now();

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: 0,
      max_tokens: req.maxTokens,
    };
    if (req.jsonMode) body.response_format = { type: "json_object" };

    let res: Response;
    try {
      res = await fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter attribution headers (optional)
          ...(this.cfg.appUrl ? { "HTTP-Referer": this.cfg.appUrl } : {}),
          "X-Title": this.cfg.appName ?? "ScamShield",
          "X-Request-Id": req.requestId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (cause) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new AIError("TIMEOUT", `Model call exceeded ${req.timeoutMs}ms`, { model: req.model, cause });
      }
      throw new AIError("NETWORK", "Network error calling OpenRouter", { model: req.model, cause });
    }

    let text: string;
    try {
      text = await res.text();
    } catch (cause) {
      clearTimeout(timer);
      const code = controller.signal.aborted ? "TIMEOUT" : "NETWORK";
      throw new AIError(code, "Failed reading OpenRouter response", { model: req.model, cause });
    }
    clearTimeout(timer);
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      throw new AIError(classifyHttpStatus(res.status), `OpenRouter HTTP ${res.status}`, {
        status: res.status,
        model: req.model,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }

    if (text.length > MAX_RESPONSE_CHARS) {
      throw new AIError("MALFORMED_RESPONSE", "OpenRouter response too large", { model: req.model });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      throw new AIError("MALFORMED_RESPONSE", "OpenRouter returned non-JSON body", { model: req.model, cause });
    }

    // OpenRouter can return `{ error: { code, message } }` with HTTP 200 when an upstream fails.
    const p = payload as {
      error?: { code?: number | string; message?: string };
      model?: string;
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    };
    if (p.error) {
      const status = typeof p.error.code === "number" ? p.error.code : Number(p.error.code) || 502;
      throw new AIError(classifyHttpStatus(status), `OpenRouter upstream error ${status}`, {
        status,
        model: req.model,
      });
    }

    const content = p.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new AIError("MALFORMED_RESPONSE", "OpenRouter returned empty content", { model: req.model });
    }

    return { content, model: typeof p.model === "string" ? p.model : req.model, latencyMs };
  }
}
