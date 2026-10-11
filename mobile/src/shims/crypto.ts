// Browser replacement for node:crypto createHash("sha256") (synchronous, hex digest) and randomUUID.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
export function createHash(alg: string) {
  if (alg !== "sha256") throw new Error(`hash ${alg} is not available on the device`);
  const chunks: Uint8Array[] = [];
  const h = {
    update(s: string | Uint8Array) { chunks.push(typeof s === "string" ? utf8ToBytes(s) : s); return h; },
    digest(enc: "hex") {
      if (enc !== "hex") throw new Error("only hex digests are supported");
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      return bytesToHex(sha256(all));
    },
  };
  return h;
}
export const randomUUID = () => globalThis.crypto.randomUUID();
/** Web Crypto random bytes with a Node-Buffer-like toString("hex"). */
export function randomBytes(n: number) {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(n));
  return Object.assign(b, { toString: (enc?: string) => (enc === "hex" || enc === undefined ? bytesToHex(b) : (() => { throw new Error(`encoding ${enc} is not available`); })()) });
}
export default { createHash, randomUUID, randomBytes };
