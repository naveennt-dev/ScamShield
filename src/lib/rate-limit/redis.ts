import Redis from "ioredis";
import type { RateLimitStore } from "./types";

/** Atomic INCR + PEXPIRE-on-first-hit + PTTL. Works on Redis, Valkey, KeyDB, Upstash (TCP). */
const SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}
`;

export class RedisRateLimitStore implements RateLimitStore {
  readonly name = "redis";
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1000,
    });
    // Errors surface through rejected commands; avoid unhandled 'error' events crashing the process.
    this.client.on("error", () => undefined);
  }

  /**
   * The offline queue is disabled (so an outage fails fast instead of piling up requests), which
   * means commands must wait until the initial connection is ready — otherwise the first requests
   * of every cold start would fail over to the in-memory limiter.
   */
  private ready(timeoutMs = 2000): Promise<void> {
    if (this.client.status === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Redis not ready"));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("Redis connection ended"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.client.off("ready", onReady);
        this.client.off("end", onEnd);
      };
      this.client.once("ready", onReady);
      this.client.once("end", onEnd);
    });
  }

  async hit(key: string, windowMs: number) {
    await this.ready();
    const [count, ttl] = (await this.client.eval(SCRIPT, 1, `ss:rl:${key}`, String(windowMs))) as [number, number];
    return { count: Number(count), ttlMs: Number(ttl) };
  }

  async ping(): Promise<boolean> {
    try {
      await this.ready();
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}
