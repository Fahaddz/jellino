export async function pullNuvioWatch(
  db: D1Database,
  fetchImpl: typeof fetch,
  profileId: string,
): Promise<void> {
  try {
    await refreshNuvioWatch(db, fetchImpl, profileId, Math.floor(Date.now() / 1000));
  } catch {
    void 0;
  }
}
import type { Context, Hono } from "hono";
import type { Env } from "./db";
import { cachedJson } from "./cache";
import { catalogBases, catalogMediaKind } from "./library";
import { decodeItem, decodeView, encodeEpisode, encodeItem, encodeSeason, parseItemKey } from "./ids";
import { episodeDto, fetchMeta, indexedEpisodes, movieDto, premiereDate, providerIds, runtimeTicks, seasonEpisodes, videoEpisodeNumber, type StremioMeta } from "./meta";
import { csvSet, pageParams } from "./query";
import { verifiedOwner } from "./session";
import { logApp } from "./applog";
import { warmPlaybackFor } from "./streams";
import { refreshNuvioWatch } from "./nuvio-home";
import { readHiddenKeys } from "./hidden";
import { attachListUserData, readFavoriteKeys, type WatchRow } from "./watch-state";

export { parseItemKey };

const RESUME_DEFAULT_LIMIT = 20;
const NEXTUP_LIMIT = 10;
const UPCOMING_DEFAULT_LIMIT = 20;
const UPCOMING_SERIES_SCAN = 8;
const UPCOMING_META_BATCH = 3;
const UPCOMING_CACHE_TTL_SECONDS = 300;

export async function attachProfileUserData(
  db: D1Database,
  profileId: string,
  items: Record<string, unknown>[],
  runTimeTicks: number | null = null,
): Promise<void> {
  const [rows, favKeys] = await Promise.all([readWatchRows(db, profileId), readFavoriteKeys(db, profileId)]);
  attachListUserData(items, rows, runTimeTicks, favKeys);
}

export async function readWatchRows(db: D1Database, profileId: string): Promise<WatchRow[]> {
  const out = await db
    .prepare("SELECT item_key AS itemKey, position_ticks AS positionTicks, played, play_count AS playCount, updated_at AS updatedAt FROM watch_state WHERE profile_id = ?1 ORDER BY updated_at DESC")
    .bind(profileId)
    .all<WatchRow>();
  return out.results ?? [];
}

function userDataForRow(row: WatchRow, runTimeTicks: number | null): Record<string, unknown> {
  const data: Record<string, unknown> = {
    Played: row.played === 1,
    PlaybackPositionTicks: row.positionTicks,
    PlayCount: row.playCount,
    IsFavorite: false,
  };
  if (runTimeTicks !== null && runTimeTicks > 0 && row.positionTicks > 0) {
    const pct = Math.min(100, (row.positionTicks / runTimeTicks) * 100);
    if (pct > 0) data.PlayedPercentage = Math.round(pct * 100) / 100;
  }
  if (row.updatedAt > 0) data.LastPlayedDate = new Date(row.updatedAt * 1000).toISOString();
  return data;
}

function lastPlayedIndex(
  videos: { season: number; episode: number }[],
  stateFor: (season: number, episode: number) => WatchRow | undefined,
): number {
  let lastPlayed = -1;
  videos.forEach((entry, i) => {
    const row = stateFor(entry.season, entry.episode);
    if (row !== undefined && row.played === 1) lastPlayed = i;
  });
  return lastPlayed;
}

function seriesItemUserData(
  key: string,
  row: WatchRow | undefined,
  runTimeTicks: number | null,
  lastActivity: number,
): Record<string, unknown> {
  if (row) return { Key: key, ItemId: key, ...userDataForRow(row, runTimeTicks) };
  return {
    Key: key,
    ItemId: key,
    Played: false,
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: false,
    ...(lastActivity > 0 ? { LastPlayedDate: new Date(lastActivity * 1000).toISOString() } : {}),
  };
}

function prettyNameFor(stremioId: string): string {
  const tmdb = /^tmdb:(\d+)$/i.exec(stremioId);
  if (tmdb) return `TMDB ${tmdb[1]}`;
  const tvdb = /^tvdb:(\d+)$/i.exec(stremioId);
  if (tvdb) return `TVDB ${tvdb[1]}`;
  return stremioId;
}

function displayNameFor(name: string | undefined, stremioId: string): string {
  const clean = typeof name === "string" ? name.trim() : "";
  return clean || prettyNameFor(stremioId);
}

function fallbackBase(urls: string[]): string {
  return urls[0] ?? "";
}

function fallbackTail(id: string, stremioId: string, row: WatchRow): Record<string, unknown> {
  return {
    ProductionYear: null,
    CommunityRating: null,
    CriticRating: null,
    Genres: [],
    Tags: [],
    GenreItems: [],
    Studios: [],
    ProductionCompanies: [],
    ProviderIds: providerIds(stremioId),
    ImageTags: {},
    BackdropImageTags: [],
    UserData: { Key: id, ItemId: id, ...userDataForRow(row, null) },
  };
}

function fallbackMovieDto(serverId: string, base: string, stremioId: string, row: WatchRow, name?: string): Record<string, unknown> {
  const id = encodeItem(base, "movie", stremioId);
  return {
    Name: displayNameFor(name, stremioId),
    ServerId: serverId,
    Id: id,
    Type: "Movie",
    MediaType: "Video",
    IsFolder: false,
    CanDownload: true,
    RunTimeTicks: null,
    Overview: null,
    ...fallbackTail(id, stremioId, row),
  };
}

function fallbackEpisodeDto(
  serverId: string,
  base: string,
  stremioId: string,
  season: number,
  episode: number,
  row: WatchRow,
  seriesName?: string,
): Record<string, unknown> {
  const id = encodeEpisode(base, stremioId, season, episode);
  const seriesId = encodeItem(base, "series", stremioId);
  const seasonId = encodeSeason(base, stremioId, season);
  return {
    Name: `Episode ${episode}`,
    ServerId: serverId,
    Id: id,
    Type: "Episode",
    MediaType: "Video",
    IsFolder: false,
    CanDownload: true,
    SeriesName: displayNameFor(seriesName, stremioId),
    SeriesId: seriesId,
    SeasonName: `Season ${season}`,
    SeasonId: seasonId,
    ParentId: seasonId,
    IndexNumber: episode,
    ParentIndexNumber: season,
    Overview: null,
    RunTimeTicks: null,
    ...fallbackTail(id, stremioId, row),
  };
}

async function rowDto(
  cache: Cache,
  urls: string[],
  serverId: string,
  row: WatchRow,
): Promise<Record<string, unknown> | null> {
  const parsed = parseItemKey(row.itemKey);
  if (!parsed || parsed.kind === "series") return null;
  const base = fallbackBase(urls);
  const metaType = parsed.kind === "movie" ? "movie" : "series";
  const resolved = await fetchMeta(cache, fetch, urls, urls[0] ?? "", metaType, parsed.stremioId);
  if (!resolved) {
    if (parsed.kind === "movie") return fallbackMovieDto(serverId, base, parsed.stremioId, row);
    return fallbackEpisodeDto(serverId, base, parsed.stremioId, parsed.season, parsed.episode, row);
  }
  const meta: StremioMeta = resolved.meta;
  if (parsed.kind === "movie") {
    const dto = movieDto(serverId, resolved.addonUrl, meta);
    dto.UserData = { Key: String(dto.Id ?? ""), ItemId: String(dto.Id ?? ""), ...userDataForRow(row, runtimeTicks(meta.runtime)) };
    return dto;
  }
  const video = seasonEpisodes(meta, parsed.season).find((entry) => videoEpisodeNumber(entry) === parsed.episode);
  if (!video) return fallbackEpisodeDto(serverId, resolved.addonUrl, parsed.stremioId, parsed.season, parsed.episode, row, meta.name);
  const dto = episodeDto(serverId, resolved.addonUrl, meta, video);
  if (!dto) return fallbackEpisodeDto(serverId, resolved.addonUrl, parsed.stremioId, parsed.season, parsed.episode, row, meta.name);
  dto.UserData = { Key: String(dto.Id ?? ""), ItemId: String(dto.Id ?? ""), ...userDataForRow(row, runtimeTicks(meta.runtime)) };
  return dto;
}

interface SeriesState {
  stremioId: string;
  lastActivity: number;
  byEp: Map<string, WatchRow>;
  hasProgress: boolean;
  hasWatched: boolean;
}

function groupEpisodeRows(rows: WatchRow[]): Map<string, SeriesState> {
  const groups = new Map<string, SeriesState>();
  for (const row of rows) {
    const parsed = parseItemKey(row.itemKey);
    if (!parsed || parsed.kind !== "episode") continue;
    let group = groups.get(parsed.stremioId);
    if (!group) {
      group = { stremioId: parsed.stremioId, lastActivity: 0, byEp: new Map(), hasProgress: false, hasWatched: false };
      groups.set(parsed.stremioId, group);
    }
    group.byEp.set(`${parsed.season}:${parsed.episode}`, row);
    if (row.updatedAt > group.lastActivity) group.lastActivity = row.updatedAt;
    if (row.played === 0 && row.positionTicks > 0) group.hasProgress = true;
    if (row.played === 1) group.hasWatched = true;
  }
  return groups;
}

async function nextUpCandidateDto(
  cache: Cache,
  urls: string[],
  serverId: string,
  group: SeriesState,
): Promise<Record<string, unknown> | null> {
  const resolved = await fetchMeta(cache, fetch, urls, urls[0] ?? "", "series", group.stremioId);
  if (!resolved) return null;
  const videos = indexedEpisodes(resolved.meta);
  if (videos.length === 0) return null;
  const stateFor = (season: number, episode: number) => group.byEp.get(`${season}:${episode}`);

  let lastPlayed = lastPlayedIndex(videos, stateFor);

  if (lastPlayed < 0) return null;
  const candidate = videos[lastPlayed + 1];
  if (!candidate) return null;

  const candidateRow = stateFor(candidate.season, candidate.episode);
  if (candidateRow?.played === 1) return null;

  const fallbackItem = (): Record<string, unknown> => {
    return fallbackEpisodeDto(
      serverId,
      resolved.addonUrl,
      group.stremioId,
      candidate.season,
      candidate.episode,
      candidateRow ?? {
        itemKey: `episode:${group.stremioId}:${candidate.season}:${candidate.episode}`,
        positionTicks: 0,
        played: 0,
        playCount: 0,
        updatedAt: group.lastActivity,
      },
      resolved.meta.name,
    );
  };

  const dto = episodeDto(serverId, resolved.addonUrl, resolved.meta, candidate.video);
  if (!dto) return fallbackItem();

  const key = String(dto.Id ?? "");
  dto.UserData = seriesItemUserData(key, candidateRow, runtimeTicks(resolved.meta.runtime), group.lastActivity);

  return dto;
}

export type ResumeKind = "movie" | "series" | "episode";

export interface ResumeOptions {
  limit: number;
  start: number;
  types?: Set<ResumeKind> | null;
}

export async function resumeItems(
  db: D1Database,
  cache: Cache,
  urls: string[],
  serverId: string,
  profileId: string,
  opts: ResumeOptions,
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const hidden = await readHiddenKeys(db, profileId);
  const allRows = await readWatchRows(db, profileId);

  const inProgressCandidates = allRows.filter((r) => {
    if (hidden.has(r.itemKey)) return false;
    if (r.played !== 0 || r.positionTicks <= 0) return false;
    const parsed = parseItemKey(r.itemKey);
    if (!parsed || parsed.kind === "series") return false;
    if (opts.types && opts.types.size > 0 && !opts.types.has(parsed.kind)) return false;
    return true;
  });

  type UnifiedCandidate =
    | { kind: "in_progress"; row: WatchRow; sortTime: number }
    | { kind: "next_up"; stremioId: string; group: SeriesState; sortTime: number };

  const candidates: UnifiedCandidate[] = [];
  const latestBySeries = new Map<string, WatchRow>();

  for (const row of inProgressCandidates) {
    const parsed = parseItemKey(row.itemKey);
    if (parsed?.kind === "episode") {
      const current = latestBySeries.get(parsed.stremioId);
      if (!current || row.updatedAt > current.updatedAt) latestBySeries.set(parsed.stremioId, row);
      continue;
    }
    candidates.push({ kind: "in_progress", row, sortTime: row.updatedAt });
  }

  for (const row of latestBySeries.values()) {
    candidates.push({ kind: "in_progress", row, sortTime: row.updatedAt });
  }

  const allowEpisodes = !opts.types || opts.types.size === 0 || opts.types.has("episode");
  if (allowEpisodes) {
    const groups = groupEpisodeRows(allRows);
    for (const group of groups.values()) {
      if (hidden.has(`series:${group.stremioId}`)) continue;
      if (latestBySeries.has(group.stremioId)) continue;
      if (!group.hasWatched) continue;
      candidates.push({ kind: "next_up", stremioId: group.stremioId, group, sortTime: group.lastActivity });
    }
  }

  candidates.sort((a, b) => b.sortTime - a.sortTime);
  const total = candidates.length;
  const page = candidates.slice(opts.start, opts.start + opts.limit);
  const dtos = await Promise.all(
    page.map(async (c) => {
      if (c.kind === "in_progress") {
        return rowDto(cache, urls, serverId, c.row);
      } else {
        return nextUpCandidateDto(cache, urls, serverId, c.group);
      }
    }),
  );
  const items = dtos.filter((dto): dto is Record<string, unknown> => dto !== null);
  return { items, total };
}

interface NextUpOptions {
  limit: number;
  start: number;
  enableResumable: boolean;
  seriesId?: string | null;
}

async function nextUpItems(
  db: D1Database,
  cache: Cache,
  urls: string[],
  serverId: string,
  profileId: string,
  opts: NextUpOptions,
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const rows = await readWatchRows(db, profileId);
  const groups = groupEpisodeRows(rows);
  let targets: SeriesState[];
  if (opts.seriesId) {
    const existing = groups.get(opts.seriesId);
    targets = [
      existing ?? { stremioId: opts.seriesId, lastActivity: 0, byEp: new Map(), hasProgress: false, hasWatched: false },
    ];
  } else {
    targets = [...groups.values()]
      .filter((g) => g.hasProgress || g.hasWatched)
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }
  const total = targets.length;
  const page = targets.slice(opts.start, opts.start + opts.limit);
  const resolvedTargets = await Promise.all(
    page.map(async (group) => {
      const resolved = await fetchMeta(cache, fetch, urls, urls[0] ?? "", "series", group.stremioId);
      return { group, resolved };
    }),
  );
  const items: Record<string, unknown>[] = [];
  for (const { group, resolved } of resolvedTargets) {
    if (!resolved) {
      if (opts.enableResumable) {
        const inProgress = [...group.byEp.entries()]
          .map(([key, row]) => {
            const [s, e] = key.split(":").map(Number);
            return { season: s ?? 0, episode: e ?? 0, row };
          })
          .filter((entry) => entry.row.played === 0 && entry.row.positionTicks > 0)
          .sort((a, b) => a.season - b.season || a.episode - b.episode)[0];
        if (inProgress) {
          items.push(
            fallbackEpisodeDto(serverId, fallbackBase(urls), group.stremioId, inProgress.season, inProgress.episode, inProgress.row),
          );
        }
      }
      continue;
    }
    const videos = indexedEpisodes(resolved.meta);
    if (videos.length === 0) continue;
    const stateFor = (season: number, episode: number) => group.byEp.get(`${season}:${episode}`);
    let picked: { season: number; episode: number } | null = null;
    if (opts.enableResumable) {
      const current = videos.find((entry) => {
        const row = stateFor(entry.season, entry.episode);
        return row !== undefined && row.played === 0 && row.positionTicks > 0;
      });
      if (current) picked = { season: current.season, episode: current.episode };
    }
    if (!picked) {
      const lastPlayed = lastPlayedIndex(videos, stateFor);
      if (lastPlayed >= 0) {
        const candidate = videos[lastPlayed + 1];
        if (candidate) {
          const row = stateFor(candidate.season, candidate.episode);
          if (opts.enableResumable || !row || row.positionTicks <= 0 || row.played !== 0) {
            picked = { season: candidate.season, episode: candidate.episode };
          }
        }
      } else if (opts.seriesId) {
        const first = videos.find((entry) => entry.season > 0) ?? videos[0];
        if (first) picked = { season: first.season, episode: first.episode };
      }
    }
    if (!picked) continue;
    const entry = videos.find((candidate) => candidate.season === picked?.season && candidate.episode === picked?.episode);
    const fallbackItem = (season: number, episode: number): Record<string, unknown> => {
      const row = stateFor(season, episode);
      return fallbackEpisodeDto(
        serverId,
        resolved.addonUrl,
        group.stremioId,
        season,
        episode,
        row ?? { itemKey: `episode:${group.stremioId}:${season}:${episode}`, positionTicks: 0, played: 0, playCount: 0, updatedAt: group.lastActivity },
        resolved.meta.name,
      );
    };
    if (!entry) {
      items.push(fallbackItem(picked.season, picked.episode));
      continue;
    }
    const dto = episodeDto(serverId, resolved.addonUrl, resolved.meta, entry.video);
    if (!dto) {
      items.push(fallbackItem(picked.season, picked.episode));
      continue;
    }
    const row = stateFor(picked.season, picked.episode);
    const key = String(dto.Id ?? "");
    dto.UserData = seriesItemUserData(key, row, runtimeTicks(resolved.meta.runtime), group.lastActivity);
    items.push(dto);
  }
  return { items, total };
}

interface UpcomingOptions {
  limit: number;
  start: number;
}

async function upcomingItems(
  db: D1Database,
  cache: Cache,
  urls: string[],
  serverId: string,
  profileId: string,
  opts: UpcomingOptions,
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const outcome = await cachedJson<{ candidates: { dto: Record<string, unknown>; at: number }[] }>(
    cache,
    `https://jellino.local/upcoming/${profileId}`,
    UPCOMING_CACHE_TTL_SECONDS,
    async () => {
      const rows = await readWatchRows(db, profileId);
      const groups = groupEpisodeRows(rows);
      const seriesIds = [...groups.values()]
        .filter((group) => group.hasProgress || group.hasWatched)
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .map((group) => group.stremioId);
      const favorites = await readFavoriteKeys(db, profileId).catch(() => new Set<string>());
      for (const key of favorites) {
        if (seriesIds.length >= UPCOMING_SERIES_SCAN) break;
        const parsed = parseItemKey(key);
        if (!parsed || parsed.kind === "movie") continue;
        if (!seriesIds.includes(parsed.stremioId)) seriesIds.push(parsed.stremioId);
      }
      const cutoff = new Date();
      cutoff.setUTCHours(0, 0, 0, 0);
      const cutoffMs = cutoff.getTime();
      const scanIds = seriesIds.slice(0, UPCOMING_SERIES_SCAN);
      const resolved: Awaited<ReturnType<typeof fetchMeta>>[] = [];
      for (let i = 0; i < scanIds.length; i += UPCOMING_META_BATCH) {
        const batch = scanIds.slice(i, i + UPCOMING_META_BATCH);
        const chunk = await Promise.all(
          batch.map((stremioId) =>
            fetchMeta(cache, fetch, urls, urls[0] ?? "", "series", stremioId, { merge: false }),
          ),
        );
        resolved.push(...chunk);
      }
      const candidates: { dto: Record<string, unknown>; at: number }[] = [];
      for (const entry of resolved) {
        if (!entry) continue;
        for (const video of entry.meta.videos ?? []) {
          if (typeof video.season !== "number" || videoEpisodeNumber(video) === undefined) continue;
          const premiered = premiereDate(video.released);
          if (!premiered) continue;
          const at = Date.parse(premiered);
          if (!Number.isFinite(at) || at < cutoffMs) continue;
          const dto = episodeDto(serverId, entry.addonUrl, entry.meta, video);
          if (!dto) continue;
          candidates.push({ dto, at });
        }
      }
      candidates.sort((a, b) => a.at - b.at);
      return { candidates };
    },
  );
  const candidates = outcome.data?.candidates ?? [];
  const total = candidates.length;
  const page = candidates.slice(opts.start, opts.start + opts.limit);
  const items = page.map(({ dto }) => {
    const id = String(dto.Id ?? "");
    dto.UserData = { Key: id, ItemId: id, Played: false, PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false };
    return dto;
  });
  return { items, total };
}

async function resumeOwner(c: Context<{ Bindings: Env }>, userId: string | undefined): Promise<string | null> {
  return verifiedOwner(c.env.DB, c.req.raw, Math.floor(Date.now() / 1000), userId);
}

function paging(c: Context<{ Bindings: Env }>, fallback: number): { limit: number; start: number } {
  return pageParams(c, fallback, { positiveLimit: true });
}

const upcomingLogAt = new Map<string, number>();

function logUpcomingOutcome(
  db: D1Database,
  profileId: string,
  count: number,
  total: number,
  limit: number,
  start: number,
  url: string,
  now: number,
): void {
  if ((upcomingLogAt.get(profileId) ?? 0) > now - 300) return;
  upcomingLogAt.set(profileId, now);
  void logApp(db, {
    at: now,
    level: "info",
    kind: "upcoming",
    profileId,
    message: `upcoming ${count}/${total} items limit=${limit} start=${start}`,
    url: url.slice(0, 500),
  });
}

function enableResumable(c: Context<{ Bindings: Env }>): boolean {
  const raw = c.req.query("EnableResumable") ?? c.req.query("enableResumable");
  return raw === null || raw === undefined ? true : raw.toLowerCase() !== "false";
}

function seriesIdParam(c: Context<{ Bindings: Env }>, pathId?: string): string | null {
  const query = c.req.query("SeriesId") ?? c.req.query("seriesId");
  const raw = pathId ?? query;
  if (!raw) return null;
  const decoded = decodeItem(raw);
  if (!decoded) {
    return /^tt\d+$|^(tmdb|tvdb):/i.test(raw) ? raw : null;
  }
  if (decoded.kind !== "series" && decoded.kind !== "episode") return null;
  return decoded.stremioId;
}

function resumeTypes(c: Context<{ Bindings: Env }>): Set<ResumeKind> | null {
  const raw = c.req.query("IncludeItemTypes") ?? c.req.query("includeItemTypes") ?? "";
  const types = new Set<ResumeKind>();
  for (const part of raw.split(",")) {
    const kind = part.trim().toLowerCase();
    if (kind === "movie" || kind === "series" || kind === "episode") types.add(kind);
  }
  return types.size > 0 ? types : null;
}

function mediaTypesParam(c: Context<{ Bindings: Env }>): Set<string> {
  return csvSet(c.req.query("MediaTypes") ?? c.req.query("mediaTypes") ?? c.req.query("MediaType") ?? "");
}

function parentTypeFilter(c: Context<{ Bindings: Env }>, types: Set<ResumeKind> | null): Set<ResumeKind> | null {
  const parentId = c.req.query("ParentId") ?? c.req.query("parentId");
  if (!parentId) return types;
  const view = decodeView(parentId);
  if (!view) return types;
  const kind = catalogMediaKind(view.catalogType);
  if (kind === "movies") {
    const next = new Set<ResumeKind>();
    if (!types || types.has("movie")) next.add("movie");
    return next.size > 0 ? next : new Set<ResumeKind>(["movie"]);
  }
  if (kind === "tvshows") {
    const next = new Set<ResumeKind>();
    if (!types || types.has("episode")) next.add("episode");
    return next.size > 0 ? next : new Set<ResumeKind>(["episode"]);
  }
  return types;
}

function warmFirstPlayback(
  c: Context<{ Bindings: Env }>,
  profileId: string,
  items: Record<string, unknown>[],
): void {
  const first = items[0];
  const id = first ? String(first.Id ?? "") : "";
  const decoded = id ? decodeItem(id) : null;
  if (!decoded || (decoded.kind !== "movie" && decoded.kind !== "episode")) return;
  const streamType = decoded.kind === "movie" ? "movie" : "series";
  try {
    c.executionCtx?.waitUntil(
      warmPlaybackFor(
        c.env.DB,
        profileId,
        caches.default,
        fetch,
        streamType,
        decoded.stremioId,
        decoded.kind === "episode" ? decoded.season : null,
        decoded.kind === "episode" ? decoded.episode : null,
      ),
    );
  } catch {
    void 0;
  }
}

export function warmLikelyEpisode(
  c: Context<{ Bindings: Env }>,
  profileId: string,
  stremioId: string,
  meta: StremioMeta,
  rows: WatchRow[],
  season?: number | null,
): void {
  const videos = indexedEpisodes(meta).filter(
    (entry) => season === undefined || season === null || entry.season === season,
  );
  if (videos.length === 0) return;
  const played = new Set(rows.filter((row) => row.played === 1).map((row) => row.itemKey));
  const next =
    videos.find((entry) => !played.has(`episode:${stremioId}:${entry.season}:${entry.episode}`)) ?? videos[0];
  if (!next) return;
  try {
    c.executionCtx?.waitUntil(
      warmPlaybackFor(c.env.DB, profileId, caches.default, fetch, "series", stremioId, next.season, next.episode),
    );
  } catch {
    void 0;
  }
}

export function registerResume(app: Hono<{ Bindings: Env }>, serverId: string) {
  async function profileAndUrls(c: Context<{ Bindings: Env }>, userId: string | undefined) {
    const profileId = await resumeOwner(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const urls = await catalogBases(c.env.DB, profileId);
    if (!urls) return c.json({ error: "not found" }, 404);
    return { profileId, urls };
  }

  async function pullNuvioWatchForContext(c: Context<{ Bindings: Env }>, profileId: string): Promise<void> {
    return pullNuvioWatch(c.env.DB, fetch, profileId);
  }

  async function resumeResponse(c: Context<{ Bindings: Env }>, userId: string | undefined) {
    const ctx = await profileAndUrls(c, userId);
    if (ctx instanceof Response) return ctx;
    const { profileId, urls } = ctx;
    await pullNuvioWatchForContext(c, profileId);
    const mediaTypes = mediaTypesParam(c);
    if (mediaTypes.size > 0 && !mediaTypes.has("video") && mediaTypes.has("audio")) {
      return c.json({ Items: [], TotalRecordCount: 0 });
    }
    const { limit, start } = paging(c, RESUME_DEFAULT_LIMIT);
    const { items, total } = await resumeItems(c.env.DB, caches.default, urls, serverId, profileId, {
      limit,
      start,
      types: parentTypeFilter(c, resumeTypes(c)),
    });
    if (start === 0) warmFirstPlayback(c, profileId, items);
    return c.json({ Items: items, TotalRecordCount: total });
  }

  async function nextUpResponse(c: Context<{ Bindings: Env }>, userId: string | undefined, pathId?: string) {
    const ctx = await profileAndUrls(c, userId);
    if (ctx instanceof Response) return ctx;
    const { profileId, urls } = ctx;
    await pullNuvioWatchForContext(c, profileId);
    const { limit, start } = paging(c, NEXTUP_LIMIT);
    const { items, total } = await nextUpItems(c.env.DB, caches.default, urls, serverId, profileId, {
      limit,
      start,
      enableResumable: enableResumable(c),
      seriesId: seriesIdParam(c, pathId),
    });
    if (start === 0) warmFirstPlayback(c, profileId, items);
    return c.json({ Items: items, TotalRecordCount: total });
  }

  async function upcomingResponse(c: Context<{ Bindings: Env }>, userId: string | undefined) {
    const ctx = await profileAndUrls(c, userId);
    if (ctx instanceof Response) return ctx;
    const { profileId, urls } = ctx;
    const now = Math.floor(Date.now() / 1000);
    try {
      const refresh = refreshNuvioWatch(c.env.DB, fetch, profileId, now).catch(() => undefined);
      c.executionCtx?.waitUntil(refresh);
    } catch {
      void 0;
    }
    const { limit, start } = paging(c, UPCOMING_DEFAULT_LIMIT);
    try {
      const { items, total } = await upcomingItems(c.env.DB, caches.default, urls, serverId, profileId, {
        limit,
        start,
      });
      logUpcomingOutcome(c.env.DB, profileId, items.length, total, limit, start, c.req.url, now);
      return c.json({ Items: items, TotalRecordCount: total, StartIndex: start });
    } catch (error) {
      try {
        await logApp(c.env.DB, {
          at: now,
          level: "error",
          kind: "upcoming",
          profileId,
          message: `upcoming failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
          url: c.req.url.slice(0, 500),
        });
      } catch {
        void 0;
      }
      return c.json({ Items: [], TotalRecordCount: 0, StartIndex: start });
    }
  }

  app.get("/Users/:userId/Items/Resume", (c) => resumeResponse(c, c.req.param("userId")));
  app.get("/UserItems/Resume", (c) => resumeResponse(c, c.req.query("userId")));
  app.get("/Shows/NextUp", (c) => nextUpResponse(c, c.req.query("userId") ?? c.req.query("UserId")));
  app.get("/Shows/:id/NextUp", (c) => nextUpResponse(c, c.req.query("userId") ?? c.req.query("UserId"), c.req.param("id")));
  app.get("/Users/:userId/Items/NextUp", (c) => nextUpResponse(c, c.req.param("userId")));
  app.get("/Shows/Upcoming", (c) => upcomingResponse(c, c.req.query("userId") ?? c.req.query("UserId")));
  app.get("/UserItems/Upcoming", (c) => upcomingResponse(c, c.req.query("userId")));
  app.get("/Users/:userId/Items/Upcoming", (c) => upcomingResponse(c, c.req.param("userId")));
}
