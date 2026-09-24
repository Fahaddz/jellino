import type { Context, Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "./db";
import { cachedJson } from "./cache";
import { pageParams, queryIgnoreCase } from "./query";
import { catalogDto, catalogMetas } from "./browse";
import { decodeItem, decodeLibrary, decodeView, parseItemKey } from "./ids";
import { communityRating, extractGenresAndTags, extractStudios, officialRating, productionYear, profileMeta, type StremioMeta } from "./meta";
import { boxsetSources, catalogMediaKind, profileCollections, profileLibraries } from "./library";
import { attachProfileUserData, readWatchRows } from "./resume";
import { attachListUserData, readFavoriteKeys } from "./watch-state";
import { ownerForRequest } from "./session";

const RECOMMENDATIONS_CACHE_TTL_SECONDS = 600;

export interface ItemQuery {
  genreIds: string[];
  genres: string[];
  years: number[];
  tags: string[];
  studios: string[];
  personIds: string[];
  officialRatings: string[];
  sortBy: string[];
  sortOrder: "Ascending" | "Descending";
}


function splitList(raw: string, delimiter: string): string[] {
  return raw
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function listParam(c: Context<{ Bindings: Env }>, name: string, delimiters: string[]): string[] {
  const raw = queryIgnoreCase(c, name);
  if (!raw) return [];
  for (const delimiter of delimiters) {
    if (raw.includes(delimiter)) return splitList(raw, delimiter);
  }
  const single = raw.trim();
  return single.length > 0 ? [single] : [];
}

export function itemQuery(c: Context<{ Bindings: Env }>): ItemQuery {
  const years: number[] = [];
  for (const part of listParam(c, "Years", [","])) {
    const year = Number(part);
    if (Number.isInteger(year) && year > 0) years.push(year);
  }
  const orderRaw = (queryIgnoreCase(c, "SortOrder") ?? "").toLowerCase();
  return {
    genreIds: listParam(c, "GenreIds", [","]),
    genres: listParam(c, "Genres", ["|", ","]),
    years,
    tags: listParam(c, "Tags", ["|", ","]),
    studios: listParam(c, "Studios", ["|", ","]),
    personIds: listParam(c, "PersonIds", [","]),
    officialRatings: listParam(c, "OfficialRatings", ["|", ","]),
    sortBy: listParam(c, "SortBy", [","]),
    sortOrder: orderRaw.startsWith("desc") ? "Descending" : "Ascending",
  };
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function objectNames(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = (entry as Record<string, unknown>)[key];
    if (typeof raw === "string" && raw.length > 0) out.push(raw);
  }
  return out;
}

function matchAny(values: string[], wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const lower = new Set(wanted.map((value) => value.toLowerCase()));
  return values.some((value) => lower.has(value.toLowerCase()));
}

function hasItemFacets(query: ItemQuery): boolean {
  return (
    query.genreIds.length > 0 ||
    query.genres.length > 0 ||
    query.years.length > 0 ||
    query.tags.length > 0 ||
    query.studios.length > 0 ||
    query.personIds.length > 0 ||
    query.officialRatings.length > 0
  );
}

function matchesItemQuery(item: Record<string, unknown>, query: ItemQuery): boolean {
  if (query.genres.length > 0 || query.genreIds.length > 0) {
    if (!matchAny(stringList(item.Genres), [...query.genres, ...query.genreIds])) return false;
  }
  if (query.years.length > 0) {
    const year = Number(item.ProductionYear);
    if (!Number.isInteger(year) || !query.years.includes(year)) return false;
  }
  if (query.tags.length > 0 && !matchAny(stringList(item.Tags), query.tags)) return false;
  if (query.studios.length > 0 && !matchAny(objectNames(item.Studios, "Name"), query.studios)) return false;
  if (query.personIds.length > 0 && !matchAny(objectNames(item.People, "Id"), query.personIds)) return false;
  if (query.officialRatings.length > 0) {
    const rating = typeof item.OfficialRating === "string" ? item.OfficialRating : "";
    if (!matchAny([rating], query.officialRatings)) return false;
  }
  return true;
}

function sortKey(item: Record<string, unknown>, key: string): number | string | null {
  switch (key.toLowerCase()) {
    case "sortname":
      return String(item.Name ?? "").toLowerCase();
    case "premieredate":
      return Number.isInteger(Number(item.ProductionYear)) && Number(item.ProductionYear) > 0 ? Number(item.ProductionYear) : null;
    case "officialrating":
      return typeof item.OfficialRating === "string" && item.OfficialRating.length > 0 ? item.OfficialRating : null;
    case "runtime":
      return Number(item.RunTimeTicks) > 0 ? Number(item.RunTimeTicks) : null;
    case "criticrating":
      return typeof item.CriticRating === "number" ? item.CriticRating : null;
    case "communityrating":
      return typeof item.CommunityRating === "number" ? item.CommunityRating : null;
    case "playcount": {
      const data = item.UserData as { PlayCount?: unknown } | undefined;
      return typeof data?.PlayCount === "number" ? data.PlayCount : 0;
    }
    case "genre": {
      const genres = stringList(item.Genres);
      return genres[0]?.toLowerCase() ?? null;
    }
    case "isfolder":
      return item.IsFolder === true ? 0 : 1;
    default:
      return null;
  }
}

function sortSupported(key: string): boolean {
  const lower = key.toLowerCase();
  return lower !== "random" && lower !== "datecreated" && lower !== "datelastcontentadded" && lower !== "dateplayed";
}

function shuffled(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export function applyItemQuery(items: Record<string, unknown>[], query: ItemQuery): Record<string, unknown>[] {
  const filtered = hasItemFacets(query) ? items.filter((item) => matchesItemQuery(item, query)) : items;
  if (query.sortBy.length === 0) return filtered;
  if (query.sortBy.some((key) => key.toLowerCase() === "random")) return shuffled(filtered);
  const key = query.sortBy.find((candidate) => sortSupported(candidate)) ?? query.sortBy[0];
  if (!key) return filtered;
  const direction = query.sortOrder === "Descending" ? -1 : 1;
  return [...filtered].sort((a, b) => {
    const left = sortKey(a, key);
    const right = sortKey(b, key);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (left < right) return -direction;
    if (left > right) return direction;
    return 0;
  });
}

interface CatalogRef {
  base: string;
  type: string;
  id: string;
}

async function refsForParent(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  parentId: string | null,
  serverId: string,
): Promise<CatalogRef[]> {
  if (parentId) {
    const view = decodeView(parentId);
    if (view) return [{ base: view.addonUrl, type: view.catalogType, id: view.catalogId }];
    const libraryId = decodeLibrary(parentId);
    if (libraryId) {
      const box = await boxsetSources(db, profileId, parentId).catch(() => null);
      if (box) return box.refs.map((ref) => ({ base: ref.base, type: ref.type, id: ref.id }));
    }
    return [];
  }
  const views = await profileLibraries(db, cache, fetchImpl, profileId, serverId).catch(() => null);
  const refs: CatalogRef[] = [];
  for (const view of views ?? []) {
    const decoded = decodeView(String(view.Id ?? ""));
    if (!decoded) continue;
    refs.push({ base: decoded.addonUrl, type: decoded.catalogType, id: decoded.catalogId });
    if (refs.length >= 12) break;
  }
  return refs;
}

interface FacetSummary {
  genres: Map<string, { movie: number; series: number }>;
  studios: Map<string, number>;
  years: Map<number, number>;
  tags: Map<string, number>;
  officialRatings: Map<string, number>;
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function facetSummary(
  cache: Cache,
  fetchImpl: typeof fetch,
  refs: CatalogRef[],
): Promise<FacetSummary> {
  const summary: FacetSummary = {
    genres: new Map(),
    studios: new Map(),
    years: new Map(),
    tags: new Map(),
    officialRatings: new Map(),
  };
  if (refs.length === 0) return summary;
  const pages = await Promise.all(refs.map((ref) => catalogMetas(cache, fetchImpl, ref.base, ref.type, ref.id, null)));
  const seen = new Set<string>();
  for (const metas of pages) {
    for (const meta of metas) {
      const key = `${meta.type}:${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { genres, tags } = extractGenresAndTags(meta);
      const series = catalogMediaKind(meta.type) === "tvshows";
      for (const genre of genres) {
        const entry = summary.genres.get(genre) ?? { movie: 0, series: 0 };
        if (series) entry.series += 1;
        else entry.movie += 1;
        summary.genres.set(genre, entry);
      }
      for (const tag of tags) bump(summary.tags, tag);
      for (const studio of extractStudios(meta)) bump(summary.studios, studio.Name);
      const year = productionYear(meta.released ?? meta.releaseInfo);
      if (year !== null) bump(summary.years, year);
      const rating = officialRating(meta);
      if (rating) bump(summary.officialRatings, rating);
    }
  }
  return summary;
}



function slicePage<T>(items: T[], start: number, limit: number): T[] {
  return limit > 0 ? items.slice(start, start + limit) : items.slice(start);
}

function sortOrderFor(c: Context<{ Bindings: Env }>): "Ascending" | "Descending" {
  return (queryIgnoreCase(c, "SortOrder") ?? "").toLowerCase().startsWith("desc") ? "Descending" : "Ascending";
}

function genreDto(serverId: string, name: string, movie: number, series: number): Record<string, unknown> {
  return {
    Name: name,
    ServerId: serverId,
    Id: name,
    Type: "Genre",
    IsFolder: true,
    ChildCount: movie + series,
    MovieCount: movie,
    SeriesCount: series,
  };
}

function studioDto(serverId: string, name: string, count: number): Record<string, unknown> {
  return {
    Name: name,
    ServerId: serverId,
    Id: name,
    Type: "Studio",
    IsFolder: true,
    ChildCount: count,
  };
}

function sortedKeys<T>(map: Map<string, T>): string[] {
  return [...map.keys()].sort((a, b) => a.localeCompare(b));
}

export function registerDiscover(app: Hono<{ Bindings: Env }>, serverId: string) {
  function facetPage(
    c: Context<{ Bindings: Env }>,
    names: Iterable<string>,
    dtoFor: (name: string) => Record<string, unknown>,
  ): Response {
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    if (sortOrderFor(c) === "Descending") sorted.reverse();
    const { limit, start } = pageParams(c);
    const page = slicePage(sorted, start, limit);
    return c.json({ Items: page.map(dtoFor), TotalRecordCount: sorted.length, StartIndex: start });
  }

  async function ownerAndSummary(c: Context<{ Bindings: Env }>, userId?: string) {
    const ctx = await ownerAndRefs(c, userId);
    if (ctx instanceof Response) return ctx;
    return { profileId: ctx.profileId, refs: ctx.refs, summary: await facetSummary(caches.default, fetch, ctx.refs) };
  }

  async function ownerAndRefs(c: Context<{ Bindings: Env }>, userId?: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const parentId = queryIgnoreCase(c, "ParentId") ?? queryIgnoreCase(c, "parentId") ?? null;
    const refs = await refsForParent(c.env.DB, caches.default, fetch, profileId, parentId, serverId);
    return { profileId, refs };
  }

  async function genreResponse(c: Context<{ Bindings: Env }>, userId?: string) {
    const ctx = await ownerAndSummary(c, userId);
    if (ctx instanceof Response) return ctx;
    const { summary } = ctx;
    return facetPage(c, summary.genres.keys(), (name) => {
      const entry = summary.genres.get(name) ?? { movie: 0, series: 0 };
      return genreDto(serverId, name, entry.movie, entry.series);
    });
  }

  async function studioResponse(c: Context<{ Bindings: Env }>, userId?: string) {
    const ctx = await ownerAndSummary(c, userId);
    if (ctx instanceof Response) return ctx;
    const { summary } = ctx;
    return facetPage(c, summary.studios.keys(), (name) => studioDto(serverId, name, summary.studios.get(name) ?? 0));
  }

  app.get("/Genres", (c) => genreResponse(c));
  app.get("/Users/:userId/Genres", (c) => genreResponse(c, c.req.param("userId")));
  app.get("/Studios", (c) => studioResponse(c));
  app.get("/Users/:userId/Studios", (c) => studioResponse(c, c.req.param("userId")));

  async function facetItemsResponse(c: Context<{ Bindings: Env }>, kind: "genre" | "studio", name: string, userId?: string) {
    const ctx = await ownerAndRefs(c, userId);
    if (ctx instanceof Response) return ctx;
    const { refs } = ctx;
    const pages = await Promise.all(refs.map((ref) => catalogMetas(caches.default, fetch, ref.base, ref.type, ref.id, null)));
    const seen = new Set<string>();
    const items: Record<string, unknown>[] = [];
    const wanted = name.toLowerCase();
    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i];
      if (!ref) continue;
      for (const meta of pages[i] ?? []) {
        const key = `${meta.type}:${meta.id}`;
        if (seen.has(key)) continue;
        const matched =
          kind === "genre"
            ? extractGenresAndTags(meta).genres.some((genre) => genre.toLowerCase() === wanted)
            : extractStudios(meta).some((studio) => studio.Name.toLowerCase() === wanted);
        if (!matched) continue;
        seen.add(key);
        items.push(catalogDto(serverId, ref.base, meta, null));
      }
    }
    const { limit, start } = pageParams(c);
    const page = slicePage(items, start, limit);
    return c.json({ Items: page, TotalRecordCount: items.length, StartIndex: start });
  }

  app.get("/Genres/:name", (c) => facetItemsResponse(c, "genre", c.req.param("name")));
  app.get("/Users/:userId/Genres/:name", (c) => facetItemsResponse(c, "genre", c.req.param("name"), c.req.param("userId")));
  app.get("/Studios/:name", (c) => facetItemsResponse(c, "studio", c.req.param("name")));
  app.get("/Users/:userId/Studios/:name", (c) => facetItemsResponse(c, "studio", c.req.param("name"), c.req.param("userId")));

  async function filtersResponse(c: Context<{ Bindings: Env }>, extended: boolean) {
    const ctx = await ownerAndSummary(c);
    if (ctx instanceof Response) return ctx;
    const { summary } = ctx;
    const genres = sortedKeys(summary.genres);
    const tags = sortedKeys(summary.tags);
    if (extended) {
      return c.json({
        Genres: genres.map((name) => ({ Name: name })),
        Tags: tags,
        AudioLanguages: [],
        SubtitleLanguages: [],
      });
    }
    return c.json({
      Genres: genres,
      OfficialRatings: sortedKeys(summary.officialRatings),
      Tags: tags,
      Years: [...summary.years.keys()].sort((a, b) => b - a),
    });
  }

  app.get("/Items/Filters", (c) => filtersResponse(c, false));
  app.get("/Items/Filters2", (c) => filtersResponse(c, true));

  app.get("/Items/Counts", async (c) => {
    const profileId = await ownerForRequest(c, c.req.query("userId") ?? c.req.query("UserId"));
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const refs = await refsForParent(c.env.DB, caches.default, fetch, profileId, null, serverId);
    const [summary, collections] = await Promise.all([
      facetSummary(caches.default, fetch, refs),
      profileCollections(c.env.DB, caches.default, fetch, profileId, serverId),
    ]);
    let movies = 0;
    let series = 0;
    for (const entry of summary.genres.values()) {
      movies += entry.movie;
      series += entry.series;
    }
    return c.json({
      MovieCount: movies,
      SeriesCount: series,
      EpisodeCount: 0,
      ArtistCount: 0,
      AlbumCount: 0,
      SongCount: 0,
      BookCount: 0,
      BoxSetCount: collections?.length ?? 0,
      TrailerCount: 0,
    });
  });

  app.get("/Items/Root", async (c) => {
    const profileId = await ownerForRequest(c);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    return c.json({ Name: "Media", ServerId: serverId, Id: "root", Type: "Folder", IsFolder: true, CollectionType: null });
  });

  async function similarForItem(
    c: Context<{ Bindings: Env }>,
    profileId: string,
    metaType: string,
    stremioId: string,
    base: string,
    limit: number,
  ): Promise<{ name: string; items: Record<string, unknown>[] }> {
    const resolved = await profileMeta(c.env.DB, caches.default, fetch, profileId, base, metaType, stremioId);
    const name = resolved?.meta.name ?? stremioId;
    const wanted = new Set((resolved ? extractGenresAndTags(resolved.meta).genres : []).map((genre) => genre.toLowerCase()));
    if (wanted.size === 0) return { name, items: [] };
    const refs = await refsForParent(c.env.DB, caches.default, fetch, profileId, null, serverId);
    const pages = await Promise.all(refs.map((ref) => catalogMetas(caches.default, fetch, ref.base, ref.type, ref.id, null)));
    const seen = new Set<string>([`${metaType}:${stremioId}`]);
    const scored: { ref: CatalogRef; meta: StremioMeta; score: number }[] = [];
    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i];
      if (!ref) continue;
      for (const meta of pages[i] ?? []) {
        if (catalogMediaKind(meta.type) !== catalogMediaKind(metaType)) continue;
        const key = `${meta.type}:${meta.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const overlap = extractGenresAndTags(meta).genres.filter((genre) => wanted.has(genre.toLowerCase())).length;
        if (overlap === 0) continue;
        const rating = communityRating(meta.imdbRating ?? meta.imdb_rating ?? meta.rating ?? meta.communityRating) ?? 0;
        scored.push({ ref, meta, score: overlap * 10 + rating });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return { name, items: scored.slice(0, limit).map((entry) => catalogDto(serverId, entry.ref.base, entry.meta, null)) };
  }

  async function similarResponse(c: Context<{ Bindings: Env }>, id: string, userId?: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const decoded = decodeItem(id);
    if (!decoded || (decoded.kind !== "movie" && decoded.kind !== "series")) {
      return c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
    const metaType = decoded.kind === "movie" ? "movie" : "series";
    const rawLimit = Number(queryIgnoreCase(c, "Limit") ?? queryIgnoreCase(c, "limit") ?? 12);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 12;
    const { items } = await similarForItem(c, profileId, metaType, decoded.stremioId, decoded.addonUrl, limit);
    await attachProfileUserData(c.env.DB, profileId, items);
    return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
  }

  async function recommendationsResponse(c: Context<{ Bindings: Env }>, userId?: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const rawLimit = Number(queryIgnoreCase(c, "itemLimit") ?? queryIgnoreCase(c, "ItemLimit") ?? 12);
    const itemLimit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 12;
    const [rows, favKeys] = await Promise.all([readWatchRows(c.env.DB, profileId), readFavoriteKeys(c.env.DB, profileId)]);
    const baselines: { source: string; metaType: string; stremioId: string }[] = [];
    const seen = new Set<string>();
    const addBaseline = (source: string, key: string) => {
      if (baselines.length >= 2) return;
      const parsed = parseItemKey(key);
      if (!parsed || parsed.kind === "episode") return;
      const metaType = parsed.kind === "movie" ? "movie" : "series";
      const dedupe = `${metaType}:${parsed.stremioId}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      baselines.push({ source, metaType, stremioId: parsed.stremioId });
    };
    for (const row of [...rows].filter((entry) => entry.updatedAt > 0).sort((a, b) => b.updatedAt - a.updatedAt)) {
      addBaseline("SimilarToRecentlyPlayed", row.itemKey);
    }
    for (const key of favKeys) addBaseline("SimilarToLikedItem", key);
    const outcome = await cachedJson<Record<string, unknown>[]>(
      caches.default,
      `https://jellino.local/recommendations/${profileId}/${itemLimit}`,
      RECOMMENDATIONS_CACHE_TTL_SECONDS,
      async () => {
        const containers: Record<string, unknown>[] = [];
        for (const baseline of baselines) {
          const { name, items } = await similarForItem(c, profileId, baseline.metaType, baseline.stremioId, "", itemLimit);
          if (items.length === 0) continue;
          containers.push({
            Items: items,
            RecommendationType: baseline.source,
            BaselineItemName: name,
            CategoryId: `${baseline.source}-${baseline.stremioId}`,
          });
        }
        return containers;
      },
    );
    for (const container of outcome.data) {
      const items = (container as { Items?: Record<string, unknown>[] }).Items;
      if (Array.isArray(items)) attachListUserData(items, rows, null, favKeys);
    }
    return c.json(outcome.data);
  }

  app.get("/Items/:id/Similar", (c) => similarResponse(c, c.req.param("id")));
  app.get("/Users/:userId/Items/:id/Similar", (c) => similarResponse(c, c.req.param("id"), c.req.param("userId")));
  app.get("/Movies/Recommendations", (c) => recommendationsResponse(c, c.req.query("userId") ?? c.req.query("UserId")));
}
