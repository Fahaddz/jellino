export const MANIFEST_TTL_SECONDS = 21600;
export const META_TTL_SECONDS = 86400;
export const CATALOG_TTL_SECONDS = 7200;

const UPSTREAM_TIMEOUT_MS = 30000;

export interface CacheOutcome<T> {
  data: T;
  hit: boolean;
}

export function cacheKey(url: string): Request {
  return new Request(url, { method: "GET" });
}

export function upstreamFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs ?? UPSTREAM_TIMEOUT_MS) });
}

export function upstreamTimeoutMs(): number {
  return UPSTREAM_TIMEOUT_MS;
}

const inFlight = new Map<string, Promise<unknown>>();

export function resetInFlight(): void {
  inFlight.clear();
}

async function singleFlight<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const task = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
}

export async function cachedJson<T>(
  cache: Cache,
  url: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<CacheOutcome<T>> {
  if (!cache) {
    const data = await loader();
    return { data, hit: false };
  }
  const key = cacheKey(url);
  const stored = await cache.match(key);
  if (stored) {
    try {
      const data = (await stored.json()) as T;
      return { data, hit: true };
    } catch {
      await cache.delete(key);
    }
  }

  const data = await singleFlight(url, async () => {
    const recheck = await cache.match(key).catch(() => null);
    if (recheck) {
      try {
        return (await recheck.json()) as T;
      } catch {
        void 0;
      }
    }
    const fresh = await loader();
    const res = new Response(JSON.stringify(fresh), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${ttlSeconds}`,
      },
    });
    await cache.put(key, res).catch(() => undefined);
    return fresh;
  });
  return { data, hit: false };
}

export async function evict(cache: Cache, url: string): Promise<boolean> {
  return cache.delete(cacheKey(url));
}
