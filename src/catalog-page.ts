import type { StremioMeta } from "./meta";
import type { StremioCatalog } from "./library";
import { CATALOG_TTL_SECONDS, cacheKey, upstreamFetch } from "./cache";
import { normalizeAddonUrl } from "./library";

export interface CatalogWindow {
  start: number;
  limit: number;
}

export interface CatalogWindowResult {
  metas: StremioMeta[];
  hasMore: boolean;
  failed: boolean;
}

const MAX_CATALOG_PAGES = 25;
const MAX_WINDOW_PAGES = 12;
const MAX_PAGE_LENGTH = 500;
const CATALOG_PAGE_CONCURRENCY = 4;
const CATALOG_STRIDE_TTL_SECONDS = 3600;

const strides = new Map<string, { length: number; at: number }>();

export function resetCatalogStrides(): void {
  strides.clear();
}

function strideKey(base: string, type: string, id: string, extra: string | null): string {
  return `${normalizeAddonUrl(base)}|${type}|${id}|${extra ?? ""}`;
}

function rememberStride(key: string, length: number): void {
  if (!Number.isFinite(length) || length < 1 || length > MAX_PAGE_LENGTH) return;
  strides.set(key, { length: Math.round(length), at: Date.now() / 1000 });
}

function knownStride(key: string): number | null {
  const hit = strides.get(key);
  if (!hit) return null;
  if (Date.now() / 1000 - hit.at > CATALOG_STRIDE_TTL_SECONDS) {
    strides.delete(key);
    return null;
  }
  return hit.length;
}

function catalogTarget(base: string, type: string, id: string, extra: string | null): string {
  return `${normalizeAddonUrl(base)}/catalog/${type}/${id}${extra ? `/${extra}` : ""}.json`;
}

function catalogUrl(base: string, type: string, id: string, extra: string | null, skip: number): string {
  const parts = [...(extra ? [extra] : []), ...(skip > 0 ? [`skip=${skip}`] : [])];
  const segment = parts.length > 0 ? `/${parts.join("&")}` : "";
  return `${normalizeAddonUrl(base)}/catalog/${type}/${id}${segment}.json`;
}

interface PageRecord {
  metas: StremioMeta[];
}

interface PageFetch {
  metas: StremioMeta[];
  ok: boolean;
  notFound: boolean;
}

function validMetas(raw: unknown): StremioMeta[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((meta): meta is StremioMeta => !!meta && typeof (meta as { id?: unknown }).id === "string");
}

async function readPage(cache: Cache, key: Request): Promise<StremioMeta[] | null> {
  try {
    const stored = await cache.match(key);
    if (!stored) return null;
    const record = (await stored.json()) as PageRecord | null;
    const metas = validMetas(record?.metas);
    if (record && Array.isArray(record.metas) && metas.length !== record.metas.length) {
      await cache.delete(key);
      return null;
    }
    return metas;
  } catch {
    await cache.delete(key).catch(() => undefined);
    return null;
  }
}

async function writePage(cache: Cache, key: Request, metas: StremioMeta[]): Promise<void> {
  try {
    await cache.put(
      key,
      new Response(JSON.stringify({ metas }), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${CATALOG_TTL_SECONDS}` },
      }),
    );
  } catch {
    void 0;
  }
}

interface FetchPageOptions {
  extra: string | null;
  skip: number;
  pageIndex: number | null;
  cache: Cache;
  fetchImpl: typeof fetch;
}

async function fetchPage(base: string, type: string, id: string, options: FetchPageOptions): Promise<PageFetch> {
  const target = catalogTarget(base, type, id, options.extra);
  const index = options.pageIndex;
  const key = cacheKey(index === null ? `${target}?skip=${options.skip}` : `${target}?page=${index}`);
  const cached = await readPage(options.cache, key);
  if (cached) return { metas: cached, ok: true, notFound: false };
  const url = catalogUrl(base, type, id, options.extra, options.skip);
  try {
    const res = await upstreamFetch(options.fetchImpl, url, { headers: { accept: "application/json" } });
    if (!res.ok) return { metas: [], ok: false, notFound: res.status === 404 || res.status === 400 };
    const body = (await res.json()) as { metas?: unknown };
    const metas = validMetas(body?.metas);
    await writePage(options.cache, key, metas);
    return { metas, ok: true, notFound: false };
  } catch {
    return { metas: [], ok: false, notFound: false };
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return out;
}

function dedupePush(seen: Set<string>, out: StremioMeta[], metas: StremioMeta[]): number {
  let added = 0;
  for (const meta of metas) {
    const key = `${meta.type}:${meta.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(meta);
    added += 1;
  }
  return added;
}

async function alignedWindow(
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  type: string,
  id: string,
  extra: string | null,
  window: CatalogWindow,
  stride: number,
): Promise<CatalogWindowResult> {
  const start = Math.max(0, window.start);
  const limit = Math.max(1, window.limit);
  const firstPage = Math.floor(start / stride);
  const alignedStart = firstPage * stride;
  const offset = start - alignedStart;
  const needed = offset + limit;
  const pageCount = Math.max(1, Math.min(MAX_WINDOW_PAGES, Math.ceil(needed / stride)));
  const skips = Array.from({ length: pageCount }, (_, i) => alignedStart + i * stride);
  const pages = await mapLimit(skips, CATALOG_PAGE_CONCURRENCY, (skip, i) =>
    fetchPage(base, type, id, { extra, skip, pageIndex: firstPage + i, cache, fetchImpl }),
  );
  const seen = new Set<string>();
  const merged: StremioMeta[] = [];
  let short = false;
  let failed = false;
  for (const page of pages) {
    if (!page.ok) {
      if (page.notFound) short = true;
      else failed = true;
    } else if (page.metas.length < stride) {
      short = true;
    }
    dedupePush(seen, merged, page.metas);
  }
  const items = merged.slice(offset, offset + limit);
  if (merged.length > offset + items.length) return { metas: items, hasMore: true, failed };
  if (short) return { metas: items, hasMore: false, failed };
  if (failed) return { metas: items, hasMore: true, failed };
  const lookahead = await fetchPage(base, type, id, {
    extra,
    skip: alignedStart + pageCount * stride,
    pageIndex: firstPage + pageCount,
    cache,
    fetchImpl,
  });
  const fresh = lookahead.metas.some((meta) => !seen.has(`${meta.type}:${meta.id}`));
  return { metas: items, hasMore: fresh, failed: failed || !lookahead.ok };
}

async function chainedWindow(
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  type: string,
  id: string,
  extra: string | null,
  window: CatalogWindow,
): Promise<CatalogWindowResult> {
  const start = Math.max(0, window.start);
  const limit = Math.max(1, window.limit);
  const seen = new Set<string>();
  const metas: StremioMeta[] = [];
  let skip = start;
  let lastFull = false;
  let failed = false;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const result = await fetchPage(base, type, id, { extra, skip, pageIndex: null, cache, fetchImpl });
    if (result.metas.length === 0) {
      failed = !result.ok;
      lastFull = false;
      break;
    }
    const added = dedupePush(seen, metas, result.metas);
    if (added === 0) {
      lastFull = false;
      break;
    }
    if (page === 0) rememberStride(strideKey(base, type, id, extra), result.metas.length);
    skip += result.metas.length;
    lastFull = true;
    if (metas.length >= limit) break;
  }
  const items = metas.slice(0, limit);
  const hasMore = metas.length > limit || (lastFull && metas.length >= limit);
  return { metas: items, hasMore, failed };
}

export async function catalogWindow(
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  type: string,
  id: string,
  window: CatalogWindow,
  extra: string | null = null,
): Promise<CatalogWindowResult> {
  const stride = knownStride(strideKey(base, type, id, extra));
  if (stride && stride >= 1) {
    return alignedWindow(cache, fetchImpl, base, type, id, extra, window, stride);
  }
  return chainedWindow(cache, fetchImpl, base, type, id, extra, window);
}
