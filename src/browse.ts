import type { D1Database } from "@cloudflare/workers-types";
import { cachedJson, CATALOG_TTL_SECONDS, upstreamFetch } from "./cache";
import { catalogWindow, mapLimit, type CatalogWindow } from "./catalog-page";
import { decodeItem, decodeView, encodeItem, type DecodedItem } from "./ids";
import {
  episodeDto,
  fetchMeta,
  fetchMetaJson,
  movieDto,
  normalizeBase,
  seasonDto,
  seasonEpisodes,
  seasonNumbers,
  seasonPoster,
  seriesDto,
  videoEpisodeNumber,
  type StremioMeta,
} from "./meta";
import {
  boxsetSources,
  catalogBases,
  catalogKey,
  catalogMediaKind,
  fetchManifests,
  firstLandscapeArt,
  parseBoxsetLibraryId,
  profileHiddenCatalogs,
  profileLibraries,
  readNuvioHomeSnapshot,
  type FetchedManifest,
  type LibraryMediaKind,
  type StremioCatalog,
} from "./library";
import { placeholderMediaSources } from "./streams";

type ImageKind = "primary" | "backdrop" | "logo" | "still";

function imageSizeFor(kind: ImageKind, width: number | null): string {
  if (kind === "backdrop") return width !== null && width > 800 ? "w1280" : "w780";
  if (kind === "logo") return "w185";
  if (kind === "still") return "w300";
  return width !== null && width > 500 ? "w500" : "w342";
}

function sizeImageUrl(url: string | null, kind: ImageKind, width: number | null): string | null {
  if (!url) return null;
  if (!url.startsWith("https://image.tmdb.org/t/p/")) return url;
  return url.replace(/\/t\/p\/(w\d+|original)\//, `/t/p/${imageSizeFor(kind, width)}/`);
}

interface CatalogTarget {
  base: string;
  type: string;
  id: string;
}

function manifestCatalogTargets(
  fetched: FetchedManifest[],
  accepts: (entry: FetchedManifest, catalog: StremioCatalog) => boolean,
): CatalogTarget[] {
  const targets: CatalogTarget[] = [];
  for (const entry of fetched) {
    for (const catalog of entry.manifest.catalogs ?? []) {
      if (!catalog || typeof catalog.id !== "string" || typeof catalog.type !== "string") continue;
      if (!accepts(entry, catalog)) continue;
      targets.push({ base: entry.url, type: catalog.type, id: catalog.id });
    }
  }
  return targets;
}

export async function catalogMetas(
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  type: string,
  id: string,
  extra: string | null,
): Promise<StremioMeta[]> {
  const target = `${normalizeBase(base)}/catalog/${type}/${id}${extra ? `/${extra}` : ""}.json`;
  try {
    const outcome = await cachedJson<{ metas?: StremioMeta[] }>(cache, target, CATALOG_TTL_SECONDS, async () => {
      const res = await upstreamFetch(fetchImpl, target, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`catalog status ${res.status}`);
      return (await res.json()) as { metas?: StremioMeta[] };
    });
    const metas = outcome.data?.metas;
    if (!Array.isArray(metas)) return [];
    return metas.filter((meta) => meta && typeof meta.id === "string");
  } catch {
    return [];
  }
}

export function catalogDto(
  serverId: string,
  base: string,
  meta: StremioMeta,
  parentId: string | null,
  kind?: LibraryMediaKind | null,
): Record<string, unknown> {
  const resolved = kind === "movies" || kind === "tvshows" ? kind : catalogMediaKind(meta.type);
  const dto = resolved === "tvshows" ? seriesDto(serverId, base, meta) : movieDto(serverId, base, meta);
  if (parentId) dto.ParentId = parentId;
  return dto;
}

interface StoredItemArt {
  p?: string;
  b?: string;
  l?: string;
}

function itemArtKey(id: string): Request {
  return new Request(`https://jellino.local/item-art/${id}`, { method: "GET" });
}

async function rememberItemArt(cache: Cache, id: string, meta: StremioMeta): Promise<void> {
  if (!id) return;
  const art: StoredItemArt = {};
  const poster = meta.poster ?? meta.thumbnail;
  if (typeof poster === "string" && poster.trim()) art.p = poster.trim();
  if (typeof meta.background === "string" && meta.background.trim()) art.b = meta.background.trim();
  if (typeof meta.logo === "string" && meta.logo.trim()) art.l = meta.logo.trim();
  if (!art.p && !art.b && !art.l) return;
  try {
    const key = itemArtKey(id);
    const existing = await cache.match(key);
    if (existing) return;
    await cache.put(
      key,
      new Response(JSON.stringify(art), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=604800" },
      }),
    );
  } catch {
    void 0;
  }
}

async function rememberCatalogArt(
  cache: Cache,
  base: string,
  metas: StremioMeta[],
  kind: LibraryMediaKind | null | undefined,
): Promise<void> {
  await Promise.all(
    metas.slice(0, 60).map((meta) => {
      const resolved = kind === "movies" || kind === "tvshows" ? kind : catalogMediaKind(meta.type);
      const itemKind = resolved === "tvshows" ? "series" : "movie";
      return rememberItemArt(cache, encodeItem(base, itemKind, meta.id), meta);
    }),
  );
}

async function readItemArt(cache: Cache, id: string): Promise<StoredItemArt | null> {
  try {
    const stored = await cache.match(itemArtKey(id));
    if (!stored) return null;
    const parsed = (await stored.json()) as StoredItemArt;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const SEARCH_CACHE_TTL_SECONDS = 60;
const SEARCH_FANOUT_CONCURRENCY = 8;

export async function profileSearch(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
  query: string,
  limit: number,
  start = 0,
): Promise<Record<string, unknown>[] | null> {
  const urls = await catalogBases(db, profileId);
  if (!urls) return null;
  const cached = await cachedJson<Record<string, unknown>[]>(
    cache,
    `https://jellino.local/search/${encodeURIComponent(profileId)}/${encodeURIComponent(serverId)}/${encodeURIComponent(query)}/${start}/${limit}`,
    SEARCH_CACHE_TTL_SECONDS,
    async () => {
      const hidden = await profileHiddenCatalogs(db, profileId);
      const fetched = await fetchManifests(cache, fetchImpl, urls);
      const targets = manifestCatalogTargets(
        fetched,
        (entry, catalog) =>
          (catalog.extra ?? []).some((e) => e?.name === "search") &&
          !hidden.has(catalogKey(entry.url, catalog.type, catalog.id)),
      );
      const extra = start > 0 ? `search=${encodeURIComponent(query)}&skip=${start}` : `search=${encodeURIComponent(query)}`;
      const pages = await mapLimit(targets, SEARCH_FANOUT_CONCURRENCY, (target) =>
        catalogMetas(cache, fetchImpl, target.base, target.type, target.id, extra),
      );
      const seen = new Set<string>();
      const items: Record<string, unknown>[] = [];
      for (let i = 0; i < targets.length; i++) {
        const base = targets[i]?.base ?? "";
        for (const meta of pages[i] ?? []) {
          const key = `${meta.type}:${meta.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(catalogDto(serverId, base, meta, null));
          if (items.length >= limit) return items;
        }
      }
      return items;
    },
  );
  return cached.data;
}

export interface CatalogFetchOptions {
  window?: CatalogWindow;
  genre?: string | null;
}

export interface CatalogPageResult {
  items: Record<string, unknown>[];
  viewId: string;
  hasMore: boolean;
  genreApplied: boolean;
  limit: number;
}

function isUnreleased(meta: StremioMeta): boolean {
  const raw = (meta as { released?: unknown }).released;
  if (typeof raw !== "string" || raw.length === 0) return false;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.now();
}

async function hiddenUnreleased(db: D1Database, profileId: string): Promise<boolean> {
  try {
    const snapshot = await readNuvioHomeSnapshot(db, profileId);
    return snapshot?.hide_unreleased_content === true;
  } catch {
    return false;
  }
}

async function catalogFor(
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  type: string,
  id: string,
): Promise<StremioCatalog | null> {
  try {
    const fetched = await fetchManifests(cache, fetchImpl, [base]);
    return (fetched[0]?.manifest.catalogs ?? []).find((entry) => entry?.id === id && entry?.type === type) ?? null;
  } catch {
    return null;
  }
}

export async function profileCatalogItems(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
  viewId: string,
  options?: CatalogFetchOptions,
): Promise<CatalogPageResult | null> {
  if (parseBoxsetLibraryId(viewId)) {
    return boxsetItems(db, cache, fetchImpl, profileId, serverId, viewId, options);
  }
  const view = decodeView(viewId);
  if (!view) return null;
  const window = options?.window;
  const limit = Math.max(1, window?.limit ?? 0);
  const catalog = await catalogFor(cache, fetchImpl, view.addonUrl, view.catalogType, view.catalogId);
  let extraBase: string | undefined;
  let genreApplied = false;
  if (options?.genre && (catalog?.extra ?? []).some((entry) => entry?.name === "genre")) {
    extraBase = `genre=${encodeURIComponent(options.genre)}`;
    genreApplied = true;
  }
  const hideUnreleased = await hiddenUnreleased(db, profileId);
  if (window) {
    const page = await catalogWindow(
      cache,
      fetchImpl,
      view.addonUrl,
      view.catalogType,
      view.catalogId,
      window,
      extraBase ?? null,
    );
    const metas = hideUnreleased ? page.metas.filter((meta) => !isUnreleased(meta)) : page.metas;
    await rememberCatalogArt(cache, view.addonUrl, metas, null);
    return {
      items: metas.map((meta) => catalogDto(serverId, view.addonUrl, meta, viewId)),
      viewId,
      hasMore: page.hasMore,
      genreApplied,
      limit,
    };
  }
  const metas = await catalogMetas(cache, fetchImpl, view.addonUrl, view.catalogType, view.catalogId, extraBase ?? null);
  const visible = hideUnreleased ? metas.filter((meta) => !isUnreleased(meta)) : metas;
  await rememberCatalogArt(cache, view.addonUrl, visible, null);
  return {
    items: visible.map((meta) => catalogDto(serverId, view.addonUrl, meta, viewId)),
    viewId,
    hasMore: false,
    genreApplied,
    limit: visible.length,
  };
}

const MAX_BOXSET_ITEMS = 300;

async function boxsetItems(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
  viewId: string,
  options?: CatalogFetchOptions,
): Promise<CatalogPageResult | null> {
  const info = await boxsetSources(db, profileId, viewId);
  if (!info) return { items: [], viewId, hasMore: false, genreApplied: false, limit: options?.window?.limit ?? 0 };
  const start = Math.max(0, options?.window?.start ?? 0);
  const limit = Math.max(1, options?.window?.limit ?? 50);
  const reach = Math.min(MAX_BOXSET_ITEMS, start + limit);
  const seen = new Set<string>();
  const merged: { base: string; meta: StremioMeta }[] = [];
  let hasMore = false;
  for (const ref of info.refs) {
    const page = await catalogWindow(
      cache,
      fetchImpl,
      ref.base,
      ref.type,
      ref.id,
      { start: 0, limit: reach },
    );
    hasMore = hasMore || page.hasMore;
    for (const meta of page.metas) {
      const key = `${meta.type}:${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ base: ref.base, meta });
    }
    if (merged.length >= reach && !hasMore) break;
  }
  const items = merged.slice(start, start + limit).map((entry) => catalogDto(serverId, entry.base, entry.meta, viewId));
  return { items, viewId, hasMore: hasMore || merged.length > start + items.length, genreApplied: false, limit };
}

export async function personFilmography(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
  names: string[],
  window: CatalogWindow,
): Promise<{ items: Record<string, unknown>[]; hasMore: boolean } | null> {
  const urls = await catalogBases(db, profileId);
  if (!urls) return null;
  const fetched = await fetchManifests(cache, fetchImpl, urls);
  const targets = manifestCatalogTargets(
    fetched,
    (_entry, catalog) =>
      catalog.id.toLowerCase().includes("people_search") &&
      (catalog.type === "movie" || catalog.type === "series"),
  );
  if (targets.length === 0) return null;
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  let hasMore = false;
  for (const name of names.slice(0, 3)) {
    for (const target of targets) {
      const page = await catalogWindow(
        cache,
        fetchImpl,
        target.base,
        target.type,
        target.id,
        window,
        `search=${encodeURIComponent(name)}`,
      );
      for (const meta of page.metas) {
        const key = `${meta.type}:${meta.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(catalogDto(serverId, target.base, meta, null));
      }
      hasMore = hasMore || page.hasMore;
    }
  }
  return { items, hasMore };
}

export async function profileChildItems(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
  viewId: string,
  parent: DecodedItem,
  deep = false,
): Promise<{ items: Record<string, unknown>[]; viewId: string } | null> {
  if (parent.kind !== "series" && parent.kind !== "season" && parent.kind !== "movie") return null;
  const metaType = parent.kind === "movie" ? "movie" : "series";
  const urls = await catalogBases(db, profileId);
  if (!urls) return null;
  const resolved = await fetchMeta(cache, fetchImpl, urls, parent.addonUrl, metaType, parent.stremioId);
  if (!resolved) return null;
  const episodeChildren = (videos: ReturnType<typeof seasonEpisodes>): Record<string, unknown>[] =>
    videos
      .map((video) => withPlaceholderSources(episodeDto(serverId, resolved.addonUrl, resolved.meta, video)))
      .filter((dto): dto is Record<string, unknown> => dto !== null);
  if (parent.kind === "series") {
    if (deep) {
      const items = episodeChildren(seasonNumbers(resolved.meta).flatMap((season) => seasonEpisodes(resolved.meta, season)));
      return { items, viewId };
    }
    const items = seasonNumbers(resolved.meta).map((season) => seasonDto(serverId, resolved.addonUrl, resolved.meta, season));
    return { items, viewId };
  }
  if (parent.kind === "season") {
    return { items: episodeChildren(seasonEpisodes(resolved.meta, parent.season ?? -1)), viewId };
  }
  return { items: [], viewId };
}

function withPlaceholderSources(dto: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!dto) return null;
  const id = String(dto.Id ?? "");
  if (!id) return dto;
  dto.EnableMediaSourceDisplay = true;
  dto.MediaSources = placeholderMediaSources(id);
  return dto;
}

export async function profileLatest(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
  viewId: string | undefined,
  limit: number,
  itemTypes?: string,
): Promise<Record<string, unknown>[] | null> {
  let resolvedView = viewId;
  if (!resolvedView) {
    const views = await profileLibraries(db, cache, fetchImpl, profileId, serverId);
    if (!views || views.length === 0) return [];
    if (itemTypes) {
      const lower = itemTypes.toLowerCase();
      const targetType = lower.includes("series") || lower.includes("episode") ? "tvshows" : lower.includes("movie") ? "movies" : null;
      if (targetType) {
        const match = views.find((v) => v.CollectionType === targetType);
        if (match) resolvedView = String(match.Id ?? "");
      }
    }
    if (!resolvedView) resolvedView = String(views[0]?.Id ?? "");
    if (!resolvedView) return [];
  }
  const page = await profileCatalogItems(db, cache, fetchImpl, profileId, serverId, resolvedView, {
    window: { start: 0, limit: Math.max(1, limit) },
  });
  if (page) return page.items.slice(0, limit);
  const parent = decodeItem(resolvedView);
  if (!parent) return null;
  const children = await profileChildItems(db, cache, fetchImpl, profileId, serverId, resolvedView, parent);
  if (!children) return null;
  return children.items.slice(0, limit);
}

export async function viewArtwork(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  view: { addonUrl: string; catalogType: string; catalogId: string },
): Promise<string | null> {
  let metas: StremioMeta[];
  try {
    metas = await catalogMetas(cache, fetchImpl, view.addonUrl, view.catalogType, view.catalogId, null);
  } catch {
    return null;
  }
  return firstLandscapeArt(
    metas.map((m) => ({
      ...(m.background ?? m.landscapePoster ? { background: m.background ?? m.landscapePoster } : {}),
      ...(m.poster ? { poster: m.poster } : {}),
    })),
  );
}

export async function artworkUrl(
  cache: Cache,
  fetchImpl: typeof fetch,
  id: string,
  kind: string,
  width: number | null = null,
): Promise<string | null> {
  const decoded = decodeItem(id);
  if (!decoded) return null;
  if (!/^https?:\/\//i.test(decoded.addonUrl)) return null;
  if (decoded.kind === "movie" || decoded.kind === "series") {
    const stored = await readItemArt(cache, id);
    if (stored) {
      const direct =
        kind === "backdrop"
          ? stored.b ?? null
          : kind === "logo"
            ? stored.l ?? null
            : kind === "thumb"
              ? stored.b ?? stored.p ?? null
              : stored.p ?? null;
      if (direct) {
        const sizing: ImageKind = kind === "thumb" ? "backdrop" : kind === "logo" ? "logo" : "primary";
        return sizeImageUrl(direct, sizing, width);
      }
    }
  }
  const target = `${decoded.addonUrl}/meta/${decoded.kind === "movie" ? "movie" : "series"}/${decoded.stremioId}.json`;
  let meta: StremioMeta | undefined;
  try {
    const metaOutcome = await cachedJson<{ meta?: StremioMeta }>(cache, target, 86400, () => fetchMetaJson(fetchImpl, target));
    meta = metaOutcome.data?.meta;
  } catch {
    return null;
  }
  if (!meta) return null;
  if (decoded.kind === "season") {
    const seasonPosterUrl = seasonPoster(meta, decoded.season ?? -1);
    if (kind === "primary") return sizeImageUrl(seasonPosterUrl ?? meta.poster ?? null, "primary", width);
    if (kind === "thumb") return sizeImageUrl(meta.landscapePoster ?? meta.background ?? seasonPosterUrl, "backdrop", width);
    if (kind === "backdrop") return sizeImageUrl(meta.background ?? null, "backdrop", width);
    if (kind === "logo") return sizeImageUrl(meta.logo ?? null, "logo", width);
    return null;
  }
  if (decoded.kind === "episode") {
    const video = (meta.videos ?? []).find(
      (v) => v.season === decoded.season && videoEpisodeNumber(v) === decoded.episode,
    );
    if (kind === "primary") {
      if (video?.thumbnail) return sizeImageUrl(video.thumbnail, "still", width);
      return sizeImageUrl(meta.poster ?? null, "primary", width);
    }
    if (kind === "thumb") return sizeImageUrl(video?.thumbnail ?? meta.landscapePoster ?? meta.background ?? null, "still", width);
    if (kind === "backdrop") return sizeImageUrl(meta.background ?? null, "backdrop", width);
    if (kind === "logo") return sizeImageUrl(meta.logo ?? null, "logo", width);
    return null;
  }
  if (kind === "primary") return sizeImageUrl(meta.poster ?? meta.thumbnail ?? null, "primary", width);
  if (kind === "thumb") return sizeImageUrl(meta.landscapePoster ?? meta.background ?? meta.poster ?? null, "backdrop", width);
  if (kind === "backdrop") return sizeImageUrl(meta.background ?? null, "backdrop", width);
  if (kind === "logo") return sizeImageUrl(meta.logo ?? null, "logo", width);
  return null;
}
