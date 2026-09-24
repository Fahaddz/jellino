import type { D1Database } from "@cloudflare/workers-types";
import { decodeItem, parseItemKey } from "./ids";
import { catalogBases } from "./library";
import { fetchMeta, runtimeTicks } from "./meta";

export const MAX_RESUME_PCT = 90;
const MIN_STORE_PROGRESS_TICKS = 10_000_000;

export interface WatchEntry {
  positionTicks: number;
  played: number;
  playCount: number;
  updatedAt?: number;
}

export interface WatchRow {
  itemKey: string;
  positionTicks: number;
  played: number;
  playCount: number;
  updatedAt: number;
}

export interface UserDataShape {
  Key?: string;
  ItemId?: string;
  Played: boolean;
  PlaybackPositionTicks: number;
  PlayCount: number;
  IsFavorite: boolean;
  PlayedPercentage?: number;
  UnplayedItemCount?: number;
  LastPlayedDate?: string;
}

const watchStateCache = new Map<string, WatchEntry>();

export function itemKey(id: string): string | null {
  const decoded = decodeItem(id);
  if (!decoded) return null;
  if (decoded.kind === "movie" || decoded.kind === "series") return `${decoded.kind}:${decoded.stremioId}`;
  if (decoded.kind === "episode") {
    return `episode:${decoded.stremioId}:${decoded.season ?? 0}:${decoded.episode ?? 0}`;
  }
  return null;
}

export async function readWatchEntry(db: D1Database, profileId: string, key: string): Promise<WatchEntry | null> {
  const memKey = `${profileId}:${key}`;
  const cached = watchStateCache.get(memKey);
  if (cached) return cached;
  const row = await db
    .prepare("SELECT position_ticks AS positionTicks, played, play_count AS playCount, updated_at AS updatedAt FROM watch_state WHERE profile_id = ?1 AND item_key = ?2")
    .bind(profileId, key)
    .first<WatchEntry>();
  if (row) {
    watchStateCache.set(memKey, row);
    return row;
  }
  return null;
}

export async function readWatchPosition(
  db: D1Database,
  profileId: string,
  key: string,
): Promise<number | null> {
  const entry = await readWatchEntry(db, profileId, key);
  return entry ? entry.positionTicks : null;
}

export async function readFavoriteKeys(db: D1Database, profileId: string): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT item_key FROM profile_favorites WHERE profile_id = ?")
    .bind(profileId)
    .all<{ item_key: string }>();
  return new Set((rows.results ?? []).map((r) => r.item_key));
}

export async function isFavoriteItem(db: D1Database, profileId: string, key: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM profile_favorites WHERE profile_id = ? AND item_key = ?")
    .bind(profileId, key)
    .first();
  return Boolean(row);
}

function userDataFromEntry(
  entry: WatchEntry | null,
  runTimeTicks: number | null = null,
  isFav = false,
  updatedAt: number | null = null,
): UserDataShape {
  const data: UserDataShape = {
    Played: (entry?.played ?? 0) === 1,
    PlaybackPositionTicks: entry?.positionTicks ?? 0,
    PlayCount: entry?.playCount ?? 0,
    IsFavorite: isFav,
  };
  if (runTimeTicks !== null && runTimeTicks > 0 && data.PlaybackPositionTicks > 0) {
    const pct = Math.min(100, (data.PlaybackPositionTicks / runTimeTicks) * 100);
    if (pct > 0) data.PlayedPercentage = Math.round(pct * 100) / 100;
  }
  if (updatedAt !== null && updatedAt > 0) {
    data.LastPlayedDate = new Date(updatedAt * 1000).toISOString();
  }
  return data;
}

export function aggregateUserData(rows: WatchRow[], keys: string[]): UserDataShape {
  const played = new Set(rows.filter((r) => r.played === 1).map((r) => r.itemKey));
  let unplayed = 0;
  for (const key of keys) {
    if (!played.has(key)) unplayed += 1;
  }
  const data: UserDataShape = {
    Played: keys.length > 0 && unplayed === 0,
    PlaybackPositionTicks: 0,
    PlayCount: 0,
    IsFavorite: false,
  };
  if (keys.length > 0) data.UnplayedItemCount = unplayed;
  return data;
}

export function attachListUserData(
  items: Record<string, unknown>[],
  rows: WatchRow[],
  runTimeTicks: number | null = null,
  favoriteKeys?: Set<string> | undefined,
): void {
  const byKey = new Map(rows.map((r) => [r.itemKey, r]));
  for (const item of items) {
    const id = typeof item.Id === "string" ? item.Id : "";
    const key = id ? itemKey(id) : null;
    const row = key ? byKey.get(key) : undefined;
    const isFav = Boolean(key && favoriteKeys?.has(key));
    const base = userDataFromEntry(
      row ? { positionTicks: row.positionTicks, played: row.played, playCount: row.playCount } : null,
      runTimeTicks,
      isFav,
      row?.updatedAt ?? null,
    );
    item.UserData = id ? { Key: id, ItemId: id, ...base } : base;
  }
}

export async function setPlayed(db: D1Database, profileId: string, key: string, played: boolean, now: number): Promise<WatchEntry> {
  const flag = played ? 1 : 0;
  const memKey = `${profileId}:${key}`;
  const prev = watchStateCache.get(memKey);
  if (prev && prev.played === flag) {
    return prev;
  }
  await db
    .prepare(
      "INSERT INTO watch_state (profile_id, item_key, position_ticks, played, play_count, updated_at) VALUES (?1, ?2, 0, ?3, 0, ?4) ON CONFLICT (profile_id, item_key) DO UPDATE SET played = excluded.played, updated_at = excluded.updated_at",
    )
    .bind(profileId, key, flag, now)
    .run();
  let entry: WatchEntry;
  if (prev) {
    entry = { positionTicks: prev.positionTicks, played: flag, playCount: prev.playCount };
  } else {
    const fromDb = await readWatchEntry(db, profileId, key);
    entry = fromDb ?? { positionTicks: 0, played: flag, playCount: 0 };
  }
  watchStateCache.set(memKey, entry);
  return entry;
}

export async function writeWatchPosition(
  db: D1Database,
  profileId: string,
  key: string,
  positionTicks: number,
  now: number,
  mediaSourceId?: string,
  subtitleIndex?: number,
): Promise<void> {
  const memKey = `${profileId}:${key}`;
  const prev = watchStateCache.get(memKey);
  if (prev && prev.positionTicks === positionTicks && (positionTicks === 0 || prev.played === 0) && !mediaSourceId && subtitleIndex === undefined) {
    return;
  }
  await db
    .prepare(
      `INSERT INTO watch_state (profile_id, item_key, position_ticks, played, play_count, updated_at, media_source_id, subtitle_index)
       VALUES (?1, ?2, ?3, 0, 0, ?4, ?5, ?6)
       ON CONFLICT (profile_id, item_key) DO UPDATE SET
         position_ticks = excluded.position_ticks,
         played = CASE WHEN excluded.position_ticks > 0 THEN 0 ELSE played END,
         updated_at = excluded.updated_at,
         media_source_id = COALESCE(excluded.media_source_id, watch_state.media_source_id),
         subtitle_index = COALESCE(excluded.subtitle_index, watch_state.subtitle_index)`,
    )
    .bind(profileId, key, positionTicks, now, mediaSourceId ?? null, subtitleIndex ?? null)
    .run();
  watchStateCache.set(memKey, {
    positionTicks,
    played: positionTicks > 0 ? 0 : (prev?.played ?? 0),
    playCount: prev?.playCount ?? 0,
  });
}

export async function clearWatchPosition(
  db: D1Database,
  profileId: string,
  key: string,
  now: number,
): Promise<void> {
  await writeWatchPosition(db, profileId, key, 0, now);
}

export async function recordPlayStart(db: D1Database, profileId: string, key: string, now: number): Promise<void> {
  const memKey = `${profileId}:${key}`;
  const prev = watchStateCache.get(memKey);
  await db
    .prepare(
      "INSERT INTO watch_state (profile_id, item_key, position_ticks, played, play_count, updated_at) VALUES (?1, ?2, 0, 0, 1, ?3) ON CONFLICT (profile_id, item_key) DO UPDATE SET play_count = play_count + 1, updated_at = excluded.updated_at",
    )
    .bind(profileId, key, now)
    .run();
  watchStateCache.set(memKey, {
    positionTicks: prev?.positionTicks ?? 0,
    played: prev?.played ?? 0,
    playCount: (prev?.playCount ?? 0) + 1,
  });
}

export async function applyStopPosition(
  db: D1Database,
  profileId: string,
  key: string,
  positionTicks: number,
  now: number,
  mediaSourceId?: string,
  subtitleIndex?: number,
): Promise<void> {
  try {
    const parsed = parseItemKey(key);
    if (!parsed || parsed.kind === "series") {
      await writeWatchPosition(db, profileId, key, positionTicks, now, mediaSourceId, subtitleIndex);
      return;
    }
    const urls = await catalogBases(db, profileId);
    if (!urls || urls.length === 0) throw new Error("no addons");
    const metaType = parsed.kind === "movie" ? "movie" : "series";
    const resolved = await fetchMeta(
      caches.default,
      fetch,
      urls,
      urls[0] as string,
      metaType,
      parsed.stremioId,
    );
    const ticks = resolved ? runtimeTicks(resolved.meta.runtime) : null;
    if (!ticks || ticks <= 0) throw new Error("unknown runtime");
    if (positionTicks >= (ticks * MAX_RESUME_PCT) / 100) {
      await setPlayed(db, profileId, key, true, now);
      await clearWatchPosition(db, profileId, key, now);
      return;
    }
    if (positionTicks < MIN_STORE_PROGRESS_TICKS) {
      await clearWatchPosition(db, profileId, key, now);
      return;
    }
    await writeWatchPosition(db, profileId, key, positionTicks, now, mediaSourceId, subtitleIndex);
  } catch {
    await writeWatchPosition(db, profileId, key, positionTicks, now, mediaSourceId, subtitleIndex);
  }
}

export function resetWatchStateCache(profileId?: string, key?: string): void {
  if (profileId && key) {
    watchStateCache.delete(`${profileId}:${key}`);
    return;
  }
  if (profileId) {
    for (const k of watchStateCache.keys()) {
      if (k.startsWith(`${profileId}:`)) watchStateCache.delete(k);
    }
    return;
  }
  watchStateCache.clear();
}
