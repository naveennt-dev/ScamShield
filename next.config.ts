import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Static security headers for every response. The page CSP is nonce-based and set per request in
 * src/middleware.ts. CORS is handled in middleware/route handlers from CORS_ALLOWED_ORIGINS.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

const nextConfig: NextConfig = {
  // The desktop apps bundle a self-contained server ("ScamShield Engine"): scripts/build-engine.sh.
  ...(process.env.SCAMSHIELD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  serverExternalPackages: ["tesseract.js", "ioredis"],
  outputFileTracingIncludes: {
    "/api/**/*": ["./ml/models/*.json", "./node_modules/tesseract.js/src/worker-script/**", "./node_modules/tesseract.js-core/**"],
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "lh3.googleusercontent.com" }],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
