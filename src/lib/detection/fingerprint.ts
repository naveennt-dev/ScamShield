import { createHash } from "node:crypto";

/**
 * Content fingerprints for duplicate / near-duplicate scam detection.
 *
 * `fingerprint` – SHA-256 over a canonical form that removes volatile tokens (amounts, OTPs,
 *   phone numbers, reference IDs, URL paths), so the same campaign sent to different victims
 *   collapses to one value. One-way: the text cannot be recovered from it.
 * `simhash` – 64-bit SimHash over word 3-shingles, for near-duplicates (Hamming distance ≤ 3).
 *   Split into four 16-bit bands: by the pigeonhole principle two hashes within distance 3 share
 *   at least one identical band, which lets the DB find candidates through indexed equality.
 */

export function canonicalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‏⁠-⁤﻿]/g, "")
    // URLs → host only (paths often carry per-victim tokens)
    // Bounded label lengths + lookbehind keep this linear on adversarial input (e.g. long hyphen runs).
    .replace(/(?<![a-z0-9-])(?:https?:\/\/)?(?:www\.)?([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10})(?:\/[^\s]*)?/g, " $1 ")
    .replace(/[0-9]+/g, "#")
    .replace(/[^\p{L}\p{N}#.\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(`v1|${canonicalize(text)}`).digest("hex");
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(s, "utf8")) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

export function simhash(text: string): bigint {
  const words = canonicalize(text).split(" ").filter(Boolean);
  const shingles = words.length < 3 ? [words.join(" ")] : words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(" "));
  const v = new Array<number>(64).fill(0);
  for (const sh of shingles) {
    const h = fnv1a64(sh);
    for (let i = 0; i < 64; i++) v[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= 1n << BigInt(i);
  return out;
}

export function simhashHex(h: bigint): string {
  return h.toString(16).padStart(16, "0");
}

export function simhashBands(h: bigint): [number, number, number, number] {
  return [0, 1, 2, 3].map((i) => Number((h >> BigInt(i * 16)) & 0xffffn)) as [number, number, number, number];
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
