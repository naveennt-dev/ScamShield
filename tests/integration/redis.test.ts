import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RedisRateLimitStore } from "@/lib/rate-limit/redis";

const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)("Redis rate-limit store", () => {
  it("counts atomically within a window and expires", async () => {
    const store = new RedisRateLimitStore(url!);
    const key = `test:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => store.hit(key, 1000)));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(results.every((r) => r.ttlMs > 0 && r.ttlMs <= 1000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await store.hit(key, 1000)).count).toBe(1);
    expect(await store.ping()).toBe(true);
  });

  it("rejects (so the caller can fall back) when Redis is unreachable", async () => {
    const store = new RedisRateLimitStore("redis://127.0.0.1:1");
    await expect(store.hit("x", 1000)).rejects.toBeTruthy();
  });
});
