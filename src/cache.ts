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

function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host.includes(":")) {
    return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
  }
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return false;
}

export function upstreamFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error("invalid upstream url"));
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || isPrivateHost(parsed.hostname)) {
    return Promise.reject(new Error("blocked upstream target"));
  }
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
