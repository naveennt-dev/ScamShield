import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Classification, ScamCategory } from "@/lib/schemas/analysis";
import { ScamCategorySchema } from "@/lib/schemas/analysis";
import { charFeatures, TOKENIZER_VERSION, wordFeatures } from "./tokenizer";

/**
 * ML prediction types + the EMBEDDED inference backend.
 *
 * Primary inference runs in the local Python service (ml/inference/service.py, joblib artifact).
 * This embedded TypeScript implementation evaluates the same model from its portable JSON export
 * (ml/models/scam_classifier.json) and is used as a fallback when the service is unavailable.
 * Maths identical to sklearn FeatureUnion(TfidfVectorizer word, TfidfVectorizer char) → LogisticRegression:
 *   per block: x_t = (1 + ln count_t) · idf_t, L2-normalised; blocks concatenated (word, char)
 *   multinomial: p = softmax(W·x + b); with calibration: p_k ∝ 1 / (1 + exp(a_k·z_k + b_k)), z = W·x + b
 */

const HeadSchema = z.object({
  classes: z.array(z.string()).min(2),
  coef: z.array(z.array(z.number())),
  intercept: z.array(z.number()),
  binary: z.boolean(),
  /** Per-class sigmoid (Platt) calibration fitted on the validation split. */
  calibration: z.object({ method: z.literal("sigmoid"), a: z.array(z.number()), b: z.array(z.number()) }).optional(),
});
const BlockSchema = z.object({ vocabulary: z.record(z.number().int().nonnegative()), idf: z.array(z.number()) });

const ModelSchema = z.object({
  format: z.literal("scamshield-tfidf-lr"),
  formatVersion: z.literal(2),
  tokenizerVersion: z.string(),
  name: z.string(),
  version: z.string(),
  buildId: z.string(),
  createdAt: z.string(),
  trainingData: z.object({ kind: z.enum(["synthetic", "mixed", "curated"]), rows: z.number() }).passthrough(),
  features: z.object({ word: BlockSchema, char: BlockSchema }),
  label: HeadSchema,
  category: HeadSchema.nullable(),
});
type ModelJson = z.infer<typeof ModelSchema>;
type Head = z.infer<typeof HeadSchema>;

export interface ModelInfo {
  name: string;
  version: string;
  buildId: string;
}

export interface MlPrediction {
  label: Classification;
  labelProba: Partial<Record<Classification, number>>;
  /** P(scam) + 0.5·P(suspicious), scaled to 0–100. */
  riskScore: number;
  /** Raw (uncalibrated) top-class probability, reduced when few known words are present. */
  confidence: number;
  category: ScamCategory | null;
  categoryProba: Record<string, number> | null;
  knownTerms: number;
  model: ModelInfo;
  backend: "service" | "embedded";
  /** True when every training row was hand-written synthetic data (weight is reduced in fusion). */
  seedModel: boolean;
}

/** Shared by both backends so the service and the fallback produce identical MlPredictions. */
export function toPrediction(
  labelProba: Record<string, number>,
  categoryProba: Record<string, number> | null,
  knownTerms: number,
  model: ModelInfo,
  backend: "service" | "embedded",
  seedModel: boolean,
): MlPrediction {
  const entries = Object.entries(labelProba).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  const coverage = Math.min(1, knownTerms / 6);
  const cat = categoryProba ? Object.entries(categoryProba).sort((a, b) => b[1] - a[1])[0]?.[0] : null;
  const parsedCat = cat ? ScamCategorySchema.safeParse(cat) : null;
  return {
    label: top[0] as Classification,
    labelProba: labelProba as Partial<Record<Classification, number>>,
    riskScore: Math.round(100 * Math.min(1, (labelProba.scam ?? 0) + 0.5 * (labelProba.suspicious ?? 0))),
    confidence: Number((top[1] * (0.4 + 0.6 * coverage)).toFixed(3)),
    category: parsedCat?.success ? parsedCat.data : null,
    categoryProba,
    knownTerms,
    model,
    backend,
    seedModel,
  };
}

export interface ScamClassifier {
  readonly info: ModelInfo;
  readonly isSeed: boolean;
  predict(text: string): Promise<MlPrediction>;
}

export class EmbeddedClassifier implements ScamClassifier {
  private readonly wordVocab: Map<string, number>;
  private readonly charVocab: Map<string, number>;
  private readonly offset: number;

  constructor(private readonly model: ModelJson) {
    if (model.tokenizerVersion !== TOKENIZER_VERSION) {
      throw new Error(`ML tokenizer mismatch: model ${model.tokenizerVersion} vs code ${TOKENIZER_VERSION}`);
    }
    this.offset = model.features.word.idf.length;
    const width = this.offset + model.features.char.idf.length;
    for (const head of [model.label, model.category].filter(Boolean) as Head[]) {
      const rows = head.binary ? 1 : head.classes.length;
      if (head.coef.length !== rows || head.coef.some((r) => r.length !== width) || head.intercept.length !== rows) {
        throw new Error("ML model coefficient shape mismatch");
      }
    }
    this.wordVocab = new Map(Object.entries(model.features.word.vocabulary));
    this.charVocab = new Map(Object.entries(model.features.char.vocabulary));
  }

  static fromJson(json: unknown): EmbeddedClassifier {
    return new EmbeddedClassifier(ModelSchema.parse(json));
  }

  get info(): ModelInfo {
    return { name: this.model.name, version: this.model.version, buildId: this.model.buildId };
  }

  get isSeed(): boolean {
    return this.model.trainingData.kind === "synthetic";
  }

  private static block(terms: string[], vocab: Map<string, number>, idf: number[], offset: number, out: Map<number, number>): number {
    const counts = new Map<number, number>();
    for (const t of terms) {
      const i = vocab.get(t);
      if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    let sq = 0;
    const vals: Array<[number, number]> = [];
    for (const [i, c] of counts) {
      const v = (1 + Math.log(c)) * idf[i];
      vals.push([i, v]);
      sq += v * v;
    }
    const norm = Math.sqrt(sq);
    for (const [i, v] of vals) out.set(i + offset, norm > 0 ? v / norm : v);
    return counts.size;
  }

  features(text: string): { x: Map<number, number>; known: number } {
    const x = new Map<number, number>();
    const known = EmbeddedClassifier.block(wordFeatures(text), this.wordVocab, this.model.features.word.idf, 0, x);
    EmbeddedClassifier.block(charFeatures(text), this.charVocab, this.model.features.char.idf, this.offset, x);
    return { x, known };
  }

  private static scores(head: Head, x: Map<number, number>): Record<string, number> {
    const logits = head.coef.map((w, r) => {
      let z = head.intercept[r];
      for (const [i, v] of x) z += w[i] * v;
      return z;
    });
    if (head.calibration) {
      const { a, b } = head.calibration;
      const raw = logits.map((z, k) => 1 / (1 + Math.exp(a[k] * z + b[k])));
      const s = raw.reduce((x, y) => x + y, 0);
      return Object.fromEntries(head.classes.map((c, k) => [c, s > 0 ? raw[k] / s : 1 / raw.length]));
    }
    if (head.binary) {
      const p1 = 1 / (1 + Math.exp(-logits[0]));
      return { [head.classes[0]]: 1 - p1, [head.classes[1]]: p1 };
    }
    const mx = Math.max(...logits);
    const ex = logits.map((z) => Math.exp(z - mx));
    const s = ex.reduce((a, b) => a + b, 0);
    return Object.fromEntries(head.classes.map((c, i) => [c, ex[i] / s]));
  }

  rawPredict(text: string) {
    const { x, known } = this.features(text);
    return {
      label: EmbeddedClassifier.scores(this.model.label, x),
      category: this.model.category ? EmbeddedClassifier.scores(this.model.category, x) : null,
      known,
    };
  }

  async predict(text: string): Promise<MlPrediction> {
    const r = this.rawPredict(text);
    return toPrediction(r.label, r.category, r.known, this.info, "embedded", this.isSeed);
  }
}

let loaded: Promise<EmbeddedClassifier | null> | null = null;

/** Loads the portable model once per process; null (with a warning) if missing or invalid. */
export function loadEmbeddedClassifier(modelPath: string): Promise<EmbeddedClassifier | null> {
  loaded ??= (async () => {
    const abs = path.isAbsolute(modelPath) ? modelPath : path.join(process.cwd(), modelPath);
    try {
      return EmbeddedClassifier.fromJson(JSON.parse(await readFile(abs, "utf8")));
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "ml_embedded_model_unavailable", path: modelPath, error: String(error).slice(0, 200) }));
      return null;
    }
  })();
  return loaded;
}

export function resetClassifierCache(): void {
  loaded = null;
}
