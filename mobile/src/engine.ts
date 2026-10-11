/**
 * ScamShield on-device engine for the mobile app: the SAME detection code as the server and the
 * desktop engine (rules, link analysis, embedded ML model, risk fusion), bundled for the WebView.
 * Local-only by construction: no AI service, no threat-list services, no network inspection.
 */
import modelJson from "../../ml/models/scam_classifier.json";
import { createMlEngine } from "@/lib/detection/ml";
import { EmbeddedClassifier } from "@/lib/detection/ml/classifier";
import { runPipeline } from "@/lib/detection/pipeline";
import { runScreenPipeline } from "@/lib/detection/screen";
import { scanLink } from "@/lib/linkscan/scan";

const classifier = EmbeddedClassifier.fromJson(modelJson as never);
const ml = createMlEngine({ service: null, embedded: async () => classifier });
const deps = { ai: null, intel: null, ml };
let counter = 0;
const id = () => `device-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** A pasted or shared message. `screen` = text read from a screenshot (analysed block by block). */
export async function analyzeMessage(text: string, source: "text" | "screen" = "text") {
  const input = { inputType: "message" as const, text, requestId: id(), allowLlm: false, remoteRequested: false };
  const out = source === "screen" ? await runScreenPipeline(input, deps) : await runPipeline(input, deps);
  return out.result;
}

/** A link, checked offline: the address only (the website is never contacted from the device). */
export async function analyzeLink(url: string) {
  return scanLink({ url, requestId: id(), networkAllowed: false, allowAi: false, inspectBehaviour: false }, { pipeline: deps });
}

export const engineInfo = { model: (modelJson as { name?: string; version?: string }).name ?? "embedded", version: (modelJson as { version?: string }).version ?? "?", localOnly: true };
