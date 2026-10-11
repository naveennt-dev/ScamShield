// Bundles src/engine.ts (+ the shared detection code in ../src) for the Android/iOS WebView.
//   node mobile/build-engine.mjs   → mobile/www/engine.js
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (f) => path.join(here, "src/shims", f);
const unavailable = shim("unavailable.ts");
// The device engine is local-only: these settings are fixed at build time, not read from a file.
const env = {
  NODE_ENV: "production", SCAMSHIELD_EDITION: "desktop", LOG_LEVEL: "error",
  ML_ENABLED: "true", ML_BACKEND: "embedded", LLM_ENABLED: "false", URL_FETCH_ENABLED: "false",
  DYNAMIC_INSPECTION_ENABLED: "false", CONTRIBUTIONS_ENABLED: "false", RATE_LIMIT_ENABLED: "false",
};

await build({
  entryPoints: [path.join(here, "src/engine.ts")],
  outfile: path.join(here, "www/engine.js"),
  bundle: true, format: "iife", globalName: "ScamShieldEngine", platform: "browser",
  target: ["chrome100", "safari16"], minify: true, sourcemap: false, legalComments: "external",
  tsconfig: path.join(here, "..", "tsconfig.json"),
  banner: { js: `globalThis.process = globalThis.process || { env: ${JSON.stringify(env)}, cwd: () => "/" };` },
  alias: {
    "node:net": shim("net.ts"), "node:url": shim("url.ts"), "node:crypto": shim("crypto.ts"),
    "node:fs/promises": unavailable, "node:fs": unavailable, "node:path": unavailable, "node:dns": unavailable,
    "node:http": unavailable, "node:https": unavailable, "node:os": unavailable, "node:child_process": unavailable,
  },
  logLevel: "warning",
});
console.log("built mobile/www/engine.js");
