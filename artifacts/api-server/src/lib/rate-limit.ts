import type { Request, RequestHandler } from "express";

interface RateLimitOptions {
  max?: number;
  windowMs?: number;
  /**
   * Whether X-Forwarded-For may be trusted for identity. Defaults to false and must be
   * kept in sync with the app's `trust proxy` setting.
   */
  trustProxy?: boolean;
  skip?: (req: Request) => boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX = 300;
const DEFAULT_WINDOW_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientIp(req: Request, trustProxy: boolean): string {
  // req.ip is derived from X-Forwarded-For, which any client can set to an arbitrary
  // value. Behind an autoscale proxy that would let an attacker mint unlimited identities
  // and walk straight past the limit, so fall back to the TCP peer unless trust proxy is
  // explicitly configured with a known hop count.
  const ip = (trustProxy ? req.ip : undefined) ?? req.socket.remoteAddress;

  if (!ip) {
    return "unknown";
  }

  // Collapse IPv4-mapped IPv6 peers (::ffff:1.2.3.4) so one client cannot be split
  // across two buckets by address family.
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Fixed-window, dependency-free, in-memory rate limiter keyed by client IP.
 *
 * NOTE: the bucket Map is per-process. On a horizontally scaled (`autoscale`) deployment
 * each instance enforces its own limit, so the effective ceiling is
 * `max x instance count`. Move the window to a shared store (or a gateway/edge limiter)
 * if a global limit is required.
 */
export function createRateLimiter(options: RateLimitOptions = {}): RequestHandler {
  const max =
    options.max ?? positiveIntOr(process.env.RATE_LIMIT_MAX, DEFAULT_MAX);
  const windowMs =
    options.windowMs ??
    positiveIntOr(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
  const trustProxy = options.trustProxy ?? false;
  const skip = options.skip ?? (() => false);

  const buckets = new Map<string, Bucket>();

  // Without this the Map grows for the lifetime of the process (one entry per IP ever
  // seen), which is a memory-exhaustion vector on a long-lived instance. unref() keeps
  // the timer from holding the event loop open.
  const sweeper = setInterval(
    () => {
      const now = Date.now();
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(key);
        }
      }
    },
    Math.min(SWEEP_INTERVAL_MS, windowMs),
  );
  sweeper.unref();

  return (req, res, next) => {
    if (skip(req)) {
      next();
      return;
    }

    const key = clientIp(req, trustProxy);
    const now = Date.now();

    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        status: "error",
        error: "Too Many Requests",
        retryAfter,
      });
      return;
    }

    next();
  };
}