export type RateLimitCheck = { ok: true } | { ok: false; retryAfterSeconds: number };

export type IpLimiterOptions = {
  windowMs: number;
  max: number;
  now?: () => number;
};

export type IpLimiter = {
  check(ip: string): RateLimitCheck;
  recordFailure(ip: string): void;
  recordSuccess(ip: string): void;
  size(): number;
};

type Bucket = {
  failures: number[];
  lockedUntil: number;
};

export const createIpLimiter = (options: IpLimiterOptions): IpLimiter => {
  const { windowMs, max } = options;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  const prune = (bucket: Bucket, t: number): void => {
    bucket.failures = bucket.failures.filter((ts) => ts > t - windowMs);
  };

  return {
    check(ip: string): RateLimitCheck {
      const t = now();
      const bucket = buckets.get(ip);
      if (bucket === undefined) return { ok: true };
      if (bucket.lockedUntil > t) {
        return { ok: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - t) / 1000) };
      }
      prune(bucket, t);
      return { ok: true };
    },
    recordFailure(ip: string): void {
      const t = now();
      let bucket = buckets.get(ip);
      if (bucket === undefined) {
        bucket = { failures: [], lockedUntil: 0 };
        buckets.set(ip, bucket);
      }
      prune(bucket, t);
      bucket.failures.push(t);
      if (bucket.failures.length >= max) {
        bucket.lockedUntil = t + windowMs;
      }
    },
    recordSuccess(ip: string): void {
      buckets.delete(ip);
    },
    size(): number {
      return buckets.size;
    },
  };
};
