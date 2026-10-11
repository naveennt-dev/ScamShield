import os from "node:os";
import path from "node:path";
import { getEnv } from "@/lib/config/env";
import { metrics } from "@/lib/observability/metrics";

/**
 * OCR abstraction. Implementations must treat the image as untrusted and enforce a timeout.
 * Swap providers via OCR_PROVIDER without touching the pipeline.
 */
export interface OcrResult {
  text: string;
  confidence: number | null;
  provider: string;
  latencyMs: number;
}

export interface OcrProvider {
  readonly name: string;
  readonly available: boolean;
  extractText(image: Uint8Array, opts: { timeoutMs: number }): Promise<OcrResult>;
}

export class OcrError extends Error {
  constructor(
    readonly code: "OCR_DISABLED" | "OCR_TIMEOUT" | "OCR_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "OcrError";
  }
}

/** Local OCR with tesseract.js (WASM). Language data is downloaded once from the tesseract.js CDN
 *  unless OCR_TESSERACT_LANG_PATH points at a local/self-hosted copy. */
export class TesseractOcrProvider implements OcrProvider {
  readonly name = "tesseract";
  readonly available = true;

  constructor(private readonly langPath?: string) {}

  async extractText(image: Uint8Array, opts: { timeoutMs: number }): Promise<OcrResult> {
    const started = Date.now();
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", 1, {
      cachePath: path.join(os.tmpdir(), "scamshield-tesseract"),
      ...(this.langPath ? { langPath: this.langPath } : {}),
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const recognized = await Promise.race([
        worker.recognize(Buffer.from(image)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new OcrError("OCR_TIMEOUT", "OCR timed out")), opts.timeoutMs);
        }),
      ]);
      return {
        text: recognized.data.text ?? "",
        confidence: typeof recognized.data.confidence === "number" ? recognized.data.confidence / 100 : null,
        provider: this.name,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      if (e instanceof OcrError) throw e;
      throw new OcrError("OCR_FAILED", "OCR could not process the image");
    } finally {
      clearTimeout(timer);
      await worker.terminate().catch(() => undefined);
    }
  }
}

export class DisabledOcrProvider implements OcrProvider {
  readonly name = "disabled";
  readonly available = false;
  async extractText(): Promise<OcrResult> {
    throw new OcrError("OCR_DISABLED", "OCR is disabled");
  }
}

let provider: OcrProvider | null = null;

export function getOcrProvider(): OcrProvider {
  if (provider) return provider;
  const env = getEnv();
  provider = env.OCR_PROVIDER === "tesseract" ? new TesseractOcrProvider(env.OCR_TESSERACT_LANG_PATH) : new DisabledOcrProvider();
  return provider;
}

export function setOcrProvider(p: OcrProvider | null): void {
  provider = p;
}

export async function runOcr(image: Uint8Array): Promise<OcrResult> {
  const env = getEnv();
  try {
    return await getOcrProvider().extractText(image, { timeoutMs: env.OCR_TIMEOUT_MS });
  } catch (e) {
    metrics.ocrFailure(e instanceof OcrError ? e.code : "unknown");
    throw e;
  }
}
