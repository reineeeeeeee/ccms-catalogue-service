/**
 * Small in-memory fixed-window rate limiter for the public (no login) endpoints. It is per process:
 * fine for one catalogue instance behind the gateway; use a shared store if the service is scaled out.
 */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = 0;

  function sweep(time) {
    if (time - lastSweep < 60_000 && hits.size < 10_000) return;
    lastSweep = time;
    for (const [key, entry] of hits) if (entry.resetAt <= time) hits.delete(key);
  }

  return {
    /** Counts one request. Returns { allowed, retryAfterSeconds }. */
    check(key, { limit, windowMs }) {
      const time = now();
      sweep(time);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= time) {
        entry = { count: 0, resetAt: time + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) };
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}

export const publicLimiter = createRateLimiter();

/** Team-set numbers; override with PUBLIC_RATE_LIMIT (requests) and PUBLIC_RATE_WINDOW_SECONDS. */
export function publicLimits() {
  const limit = Number(process.env.PUBLIC_RATE_LIMIT);
  const windowSeconds = Number(process.env.PUBLIC_RATE_WINDOW_SECONDS);
  return {
    limit: Number.isInteger(limit) && limit > 0 ? limit : 60,
    windowMs: (Number.isInteger(windowSeconds) && windowSeconds > 0 ? windowSeconds : 60) * 1000,
  };
}
