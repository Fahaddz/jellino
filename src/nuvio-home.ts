import { deleteSetting } from "./db";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { parseItemKey } from "./ids";
import {
  NUVIO_ANON_KEY,
  NUVIO_API_URL,
  getValidNuvioToken,
  matchesNuvioAddon,
  nuvioAddonTarget,
  nuvioDeleteLibraryItems,
  nuvioDeleteWatchProgress,
  nuvioDeleteWatchedItems,
  nuvioPullAddons,
  nuvioPullLibrary,
  nuvioPullProfiles,
  nuvioPullWatchProgress,
  nuvioPullWatchedItems,
  readNuvioAccount,
  resolveNuvioAvatarUrl,
  saveNuvioAccount,
  type NuvioAccountSettings,
  type NuvioAddon,
} from "./nuvio";
import {
  catalogBases,
  catalogKey,
  catalogSupported,
  fetchManifests,
  manifestCatalogIndex,
  normalizeAddonUrl,
  writeNuvioHomeSnapshot,
  type NuvioSnapshotCollection,
  type NuvioSnapshotFolder,
  type NuvioSnapshotItem,
  type NuvioSnapshotRef,
} from "./library";
import { MAX_RESUME_PCT, setPlayed, writeWatchPosition } from "./watch-state";
import { bumpTokenEpoch } from "./session";

export interface NuvioHomeItem {
  addon_id: string;
  type: string;
  catalog_id: string;
  enabled: boolean;
  order: number;
  custom_title: string;
  is_collection: boolean;
  collection_id: string;
}

export interface NuvioHomeSettings {
  hide_unreleased_content: boolean;
  show_catalog_type?: boolean;
  items: NuvioHomeItem[];
}

export interface NuvioFolderRpc {
  id: string;
  title: string;
  coverImageUrl?: string | null;
  catalogSources?: { addonId: string; type: string; catalogId: string }[];
  sources?: { addonId?: string; type: string; catalogId: string }[];
}

export interface NuvioCollectionRpc {
  id: string;
  title: string;
  backdropImageUrl?: string | null;
  folders?: NuvioFolderRpc[];
}

export interface NuvioWatchProgressRpc {
  content_id: string;
  content_type: string;
  video_id: string;
  season?: number | null;
  episode?: number | null;
  position: number;
  duration: number;
  last_watched: number | string;
  progress_key: string;
}

export interface NuvioWatchedItemRpc {
  content_id: string;
  content_type: string;
  title: string;
  season: number | null;
  episode: number | null;
  watched_at: number | string;
}

async function nuvioRpc<T>(
  fetchImpl: typeof fetch,
  accessToken: string,
  fn: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await fetchImpl(`${NUVIO_API_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: NUVIO_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`${fn} status ${res.status}`);
  return (await res.json()) as T;
}

function collectionsFromRows(rows: unknown): NuvioCollectionRpc[] | null {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const raw = (rows[0] as { collections_json?: unknown })?.collections_json;
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is NuvioCollectionRpc => !!c && typeof (c as NuvioCollectionRpc).id === "string");
  } catch {
    return null;
  }
}

export async function nuvioPullCollectionsRpc(
  fetchImpl: typeof fetch,
  accessToken: string,
  profileIndex: number,
): Promise<{ ok: boolean; collections?: NuvioCollectionRpc[]; error?: string }> {
  try {
    const rows = await nuvioRpc<unknown[]>(fetchImpl, accessToken, "sync_pull_collections", { p_profile_id: profileIndex });
    const parsed = collectionsFromRows(rows);
    return { ok: true, collections: parsed ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function nuvioPullHomeSettings(
  fetchImpl: typeof fetch,
  accessToken: string,
  profileIndex: number,
): Promise<{ ok: boolean; home?: NuvioHomeSettings | null; error?: string }> {
  try {
    const res = await nuvioRpc<unknown>(fetchImpl, accessToken, "sync_pull_home_catalog_settings", {
      p_profile_id: profileIndex,
      p_platform: "home_catalog_shared",
    });
    const list = Array.isArray(res) ? res : res ? [res] : [];
    const first = list[0] as { settings_json?: unknown } | undefined;
    const raw = first?.settings_json ?? (res as { settings_json?: unknown })?.settings_json;
    if (!raw) return { ok: true, home: null };
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object") return { ok: true, home: null };
    const itemsRaw = (obj as { items?: unknown }).items;
    if (Array.isArray(itemsRaw) && itemsRaw.length > 0) {
      const items = itemsRaw.filter((i): i is NuvioHomeItem => !!i && typeof (i as NuvioHomeItem).addon_id === "string");
      const hideUnreleased = Boolean((obj as { hide_unreleased_content?: boolean }).hide_unreleased_content);
      const showCatalogType = (obj as { show_catalog_type?: unknown }).show_catalog_type !== false;
      return { ok: true, home: { hide_unreleased_content: hideUnreleased, show_catalog_type: showCatalogType, items } };
    }
    return { ok: true, home: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const NUVIO_PROGRESS_SNAPSHOT_LIMIT = 200;
const NUVIO_WATCHED_SNAPSHOT_LIMIT = 100;

const TT_PROGRESS_ID = /^tt\d+$/;

async function nuvioPullWatchProgressRpc(
  fetchImpl: typeof fetch,
  accessToken: string,
  profileIndex: number,
): Promise<{ ok: boolean; progress?: NuvioWatchProgressRpc[]; error?: string }> {
  try {
    const rows = await nuvioRpc<unknown>(fetchImpl, accessToken, "sync_pull_watch_progress", {
      p_profile_id: profileIndex,
      p_limit: NUVIO_PROGRESS_SNAPSHOT_LIMIT,
    });
    if (!Array.isArray(rows)) return { ok: false, error: "unexpected watch progress payload" };
    return { ok: true, progress: rows as NuvioWatchProgressRpc[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function nuvioPullWatchedRpc(
  fetchImpl: typeof fetch,
  accessToken: string,
  profileIndex: number,
): Promise<{ ok: boolean; watched?: NuvioWatchedItemRpc[]; error?: string }> {
  try {
    const rows = await nuvioRpc<NuvioWatchedItemRpc[]>(fetchImpl, accessToken, "sync_pull_watched_items", {
      p_profile_id: profileIndex,
      p_page: 1,
      p_page_size: NUVIO_WATCHED_SNAPSHOT_LIMIT,
    });
    return { ok: true, watched: Array.isArray(rows) ? rows : [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type TombstoneKind = "progress" | "watched" | "favorite";

export async function recordTombstone(
  db: D1Database,
  profileId: string,
  kind: TombstoneKind,
  itemKey: string,
  now: number,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO sync_tombstones (profile_id, kind, item_key, deleted_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(profile_id, kind, item_key) DO UPDATE SET deleted_at = excluded.deleted_at",
      )
      .bind(profileId, kind, itemKey, now)
      .run();
  } catch {
    void 0;
  }
}

export async function readTombstones(
  db: D1Database,
  profileId: string,
  kind: TombstoneKind,
): Promise<Map<string, number>> {
  try {
    const rows = await db
      .prepare("SELECT item_key AS itemKey, deleted_at AS deletedAt FROM sync_tombstones WHERE profile_id = ?1 AND kind = ?2")
      .bind(profileId, kind)
      .all<{ itemKey: string; deletedAt: number }>();
    return new Map((rows.results ?? []).map((row) => [row.itemKey, row.deletedAt]));
  } catch {
    return new Map();
  }
}

export async function clearTombstone(
  db: D1Database,
  profileId: string,
  kind: TombstoneKind,
  itemKey: string,
): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM sync_tombstones WHERE profile_id = ?1 AND kind = ?2 AND item_key = ?3")
      .bind(profileId, kind, itemKey)
      .run();
  } catch {
    void 0;
  }
}

interface NuvioProgressEntryRpc {
  content_id: string;
  content_type: string;
  video_id: string;
  season?: number | null;
  episode?: number | null;
  position: number;
  duration: number;
  last_watched: number;
  progress_key: string;
}

async function nuvioPushWatchProgressRpc(
  fetchImpl: typeof fetch,
  accessToken: string,
  profileIndex: number,
  entries: NuvioProgressEntryRpc[],
): Promise<boolean> {
  if (entries.length === 0) return true;
  try {
    await nuvioRpc(fetchImpl, accessToken, "sync_push_watch_progress", { p_profile_id: profileIndex, p_entries: entries });
    return true;
  } catch {
    return false;
  }
}

interface NuvioWatchedEntryRpc {
  content_id: string;
  content_type: string;
  title: string;
  season?: number | null;
  episode?: number | null;
  watched_at: number;
}

async function nuvioPushWatchedRpc(
  fetchImpl: typeof fetch,
  accessToken: string,
  profileIndex: number,
  items: NuvioWatchedEntryRpc[],
): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    await nuvioRpc(fetchImpl, accessToken, "sync_push_watched_items", { p_profile_id: profileIndex, p_items: items });
    return true;
  } catch {
    return false;
  }
}

async function runWithNuvioToken(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  run: (token: string, index: number) => Promise<boolean>,
): Promise<boolean> {
  const profile = await db
    .prepare("SELECT nuvio_profile_index AS nuvioIndex FROM profiles WHERE id = ?")
    .bind(jellinoProfileId)
    .first<{ nuvioIndex: number | null }>()
    .catch(() => null);
  const index = profile?.nuvioIndex;
  if (index === null || index === undefined) return false;
  let tokenData = await getValidNuvioToken(db, fetchImpl);
  if (!tokenData) return false;
  if (await run(tokenData.token, index)) return true;
  tokenData = await getValidNuvioToken(db, fetchImpl, true);
  if (!tokenData) return false;
  return run(tokenData.token, index);
}

export async function deleteNuvioWatchedFor(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  itemKey: string,
): Promise<boolean> {
  const parsed = parseItemKey(itemKey);
  if (!parsed || parsed.kind === "series" || !TT_PROGRESS_ID.test(parsed.stremioId)) return false;
  return runWithNuvioToken(db, fetchImpl, jellinoProfileId, async (token, index) => {
    const res = await nuvioDeleteWatchedItems(fetchImpl, token, index, [
      {
        content_id: parsed.stremioId,
        season: parsed.kind === "episode" ? parsed.season : null,
        episode: parsed.kind === "episode" ? parsed.episode : null,
      },
    ]);
    return res.ok;
  });
}

export async function pushNuvioFavoriteFor(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  itemKey: string,
  meta: { name?: string; poster?: string | null },
  now: number,
): Promise<boolean> {
  const parsed = parseItemKey(itemKey);
  if (!parsed) return false;
  return runWithNuvioToken(db, fetchImpl, jellinoProfileId, async (token, index) => {
    try {
      await nuvioRpc(fetchImpl, token, "sync_push_library_items", {
        p_profile_id: index,
        p_items: [
          {
            content_id: parsed.stremioId,
            content_type: parsed.kind === "movie" ? "movie" : "series",
            name: meta.name ?? "",
            poster: meta.poster ?? null,
            added_at: now * 1000,
          },
        ],
      });
      return true;
    } catch {
      return false;
    }
  });
}

export async function deleteNuvioFavoriteFor(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  itemKey: string,
): Promise<boolean> {
  const parsed = parseItemKey(itemKey);
  if (!parsed) return false;
  return runWithNuvioToken(db, fetchImpl, jellinoProfileId, async (token, index) => {
    const res = await nuvioDeleteLibraryItems(fetchImpl, token, index, [
      {
        content_id: parsed.stremioId,
        content_type: parsed.kind === "movie" ? "movie" : "series",
      },
    ]);
    return res.ok;
  });
}

const normalizeBaseUrl: (url: string) => string = normalizeAddonUrl;

interface NuvioManifestLookup {
  idToUrl: Map<string, string>;
  catalogNames: Map<string, string>;
  catalogsByBase: Map<string, Set<string>>;
}

async function manifestLookup(fetchImpl: typeof fetch, cache: Cache | null, urls: string[]): Promise<NuvioManifestLookup> {
  const idToUrl = new Map<string, string>();
  const catalogNames = new Map<string, string>();
  const catalogsByBase = new Map<string, Set<string>>();
  for (const url of urls) {
    const base = normalizeBaseUrl(url);
    idToUrl.set(base, base);
  }
  const fetched = await fetchManifests(cache, fetchImpl, urls).catch(() => []);
  for (const entry of fetched) {
    const base = normalizeBaseUrl(entry.url);
    if (entry.manifest.id) idToUrl.set(entry.manifest.id, base);
    idToUrl.set(base, base);
  }
  const { manifestNames, validCatalogsByBase } = manifestCatalogIndex(fetched);
  for (const [key, value] of manifestNames) catalogNames.set(key, value);
  for (const [key, value] of validCatalogsByBase) catalogsByBase.set(key, value);
  return { idToUrl, catalogNames, catalogsByBase };
}

export async function deriveLibraryFromNuvio(
  db: D1Database,
  fetchImpl: typeof fetch,
  cache: Cache | null,
  jellinoProfileId: string,
  home: NuvioHomeSettings,
  collections: NuvioCollectionRpc[] | null,
  addons: NuvioAddon[],
): Promise<void> {
  const addonUrls = [...new Set(addons.filter((a) => a.url).map((a) => normalizeBaseUrl(a.url)))];
  const lookup = await manifestLookup(fetchImpl, cache, addonUrls);
  const idToUrl = lookup.idToUrl;
  const urlFor = (addonId: string): string | null => {
    if (idToUrl.has(addonId)) return idToUrl.get(addonId) ?? null;
    const direct = normalizeBaseUrl(addonId);
    if (addonUrls.includes(direct)) return direct;
    const matched = addonUrls.find((u) => u.toLowerCase().includes(addonId.toLowerCase()) || addonId.toLowerCase().includes(u.toLowerCase()));
    if (matched) return matched;
    return null;
  };
  const byId = new Map((collections ?? []).map((c) => [c.id, c]));
  const ordered = [...home.items].sort((a, b) => a.order - b.order);
  const items: NuvioSnapshotItem[] = [];
  const outCollections: NuvioSnapshotCollection[] = [];

  for (const item of ordered) {
    if (item.is_collection) {
      const col = byId.get(item.collection_id);
      if (!col) continue;
      const folders: NuvioSnapshotFolder[] = [];
      for (const folder of col.folders ?? []) {
        const folderId = folder.id || folder.title;
        if (!folderId) continue;
        const refs: NuvioSnapshotRef[] = [];
        const seenRefs = new Set<string>();
        for (const src of folder.catalogSources ?? folder.sources ?? []) {
          if (!src || typeof src.type !== "string" || typeof src.catalogId !== "string") continue;
          if (!catalogSupported(src.type)) continue;
          const base = urlFor(src.addonId ?? "");
          if (!base) continue;
          const knownCats = lookup.catalogsByBase.get(base);
          if (knownCats && !knownCats.has(`${src.type}:${src.catalogId}`)) continue;
          const dup = catalogKey(base, src.type, src.catalogId);
          if (seenRefs.has(dup)) continue;
          seenRefs.add(dup);
          refs.push({ base, type: src.type, id: src.catalogId });
        }
        if (refs.length === 0) continue;
        folders.push({
          id: folderId,
          title: folder.title ?? col.title ?? "",
          coverImageUrl: folder.coverImageUrl ?? null,
          refs,
        });
      }
      if (folders.length === 0) continue;
      outCollections.push({
        id: col.id,
        title: col.title,
        backdropImageUrl: col.backdropImageUrl ?? null,
        folders,
      });
      items.push({
        addon_id: item.addon_id,
        base: null,
        type: "",
        catalog_id: "",
        enabled: item.enabled !== false,
        order: item.order,
        custom_title: item.custom_title ?? "",
        is_collection: true,
        collection_id: col.id,
      });
      continue;
    }
    if (!item.type || !item.catalog_id || !catalogSupported(item.type)) continue;
    const base = urlFor(item.addon_id);
    if (!base) continue;
    const knownCats = lookup.catalogsByBase.get(base);
    if (knownCats && !knownCats.has(`${item.type}:${item.catalog_id}`)) continue;
    items.push({
      addon_id: item.addon_id,
      base,
      type: item.type,
      catalog_id: item.catalog_id,
      enabled: item.enabled !== false,
      order: item.order,
      custom_title: item.custom_title ?? "",
      is_collection: false,
      collection_id: "",
    });
  }

  await writeNuvioHomeSnapshot(db, jellinoProfileId, {
    hide_unreleased_content: home.hide_unreleased_content === true,
    show_catalog_type: home.show_catalog_type !== false,
    items,
    collections: outCollections,
  });
}

const TT_RE = /^tt\d+$/;

function remoteSeconds(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
    }
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.floor(ms / 1000);
    }
  }
  return 0;
}

function nuvioKeyFor(contentId: string, season: number | null, episode: number | null): string | null {
  const clean = contentId ? contentId.trim() : "";
  if (!clean) return null;
  if (season !== null && season !== undefined && episode !== null && episode !== undefined) {
    return `episode:${clean}:${season}:${episode}`;
  }
  return `movie:${clean}`;
}

function nuvioWatchedKeyFor(
  contentId: string,
  contentType: string,
  season: number | null,
  episode: number | null,
): string | null {
  const clean = contentId.trim();
  if (clean === "") return null;
  if (season !== null && season !== undefined && episode !== null && episode !== undefined) {
    return `episode:${clean}:${season}:${episode}`;
  }
  const type = contentType.trim().toLowerCase();
  if (type === "series" || type === "show" || type === "shows" || type === "tv" || type === "tvshow" || type === "tvshows" || type === "anime") {
    return null;
  }
  return `movie:${clean}`;
}

export async function mergeNuvioProgress(
  db: D1Database,
  profileId: string,
  list: NuvioWatchProgressRpc[],
  now: number,
): Promise<{ applied: number }> {
  const tombstones = await readTombstones(db, profileId, "progress");
  let applied = 0;
  for (const entry of list) {
    if (typeof entry.content_id !== "string") continue;
    const key = nuvioKeyFor(entry.content_id, entry.season ?? null, entry.episode ?? null);
    if (!key) continue;
    if (key.startsWith("movie:") && entry.content_type === "series") continue;
    const remoteAt = remoteSeconds(entry.last_watched);
    const tombstone = tombstones.get(key);
    if (tombstone !== undefined) {
      if (remoteAt <= tombstone) continue;
      await clearTombstone(db, profileId, "progress", key);
    }
    const row = await db
      .prepare("SELECT updated_at AS updatedAt, played FROM watch_state WHERE profile_id = ?1 AND item_key = ?2")
      .bind(profileId, key)
      .first<{ updatedAt: number; played: number }>()
      .catch(() => null);
    if (row) {
      if (row.played === 1 && remoteAt <= row.updatedAt) continue;
      if (remoteAt > 0 && row.updatedAt > remoteAt + 60) continue;
    }
    const ticks = Math.max(0, Math.round(entry.position * 10000));
    const durTicks = Math.max(0, Math.round((entry.duration || 0) * 10000));
    if (durTicks > 0 && ticks >= (durTicks * MAX_RESUME_PCT) / 100) {
      await setPlayed(db, profileId, key, true, remoteAt || now).catch(() => undefined);
      applied += 1;
      continue;
    }
    await writeWatchPosition(db, profileId, key, ticks, remoteAt || now).catch(() => undefined);
    applied += 1;
  }
  return { applied };
}

async function mergeNuvioWatched(
  db: D1Database,
  profileId: string,
  list: NuvioWatchedItemRpc[],
  now: number,
): Promise<{ applied: number }> {
  const tombstones = await readTombstones(db, profileId, "watched");
  let applied = 0;
  for (const entry of list) {
    const key = nuvioWatchedKeyFor(entry.content_id, entry.content_type, entry.season ?? null, entry.episode ?? null);
    if (!key) continue;
    const remoteAt = remoteSeconds(entry.watched_at);
    const tombstone = tombstones.get(key);
    if (tombstone !== undefined) {
      if (remoteAt <= tombstone) continue;
      await clearTombstone(db, profileId, "watched", key);
    }
    const row = await db
      .prepare("SELECT updated_at AS updatedAt, played, position_ticks AS positionTicks FROM watch_state WHERE profile_id = ?1 AND item_key = ?2")
      .bind(profileId, key)
      .first<{ updatedAt: number; played: number; positionTicks: number }>()
      .catch(() => null);
    if (row && row.played === 1) continue;
    if (row && remoteAt === 0 && row.positionTicks > 0) continue;
    if (row && row.played === 0 && now - row.updatedAt < 60) continue;
    await setPlayed(db, profileId, key, true, remoteAt || now).catch(() => undefined);
    await writeWatchPosition(db, profileId, key, 0, remoteAt || now).catch(() => undefined);
    applied += 1;
  }
  return { applied };
}

const RECONCILE_WRITE_GUARD_SECONDS = 600;

async function reconcileWatchState(
  db: D1Database,
  profileId: string,
  remoteProgressKeys: Set<string>,
  remoteWatchedKeys: Set<string>,
  now: number,
): Promise<{ cleared: number; unwatched: number }> {
  const progressTombstones = await readTombstones(db, profileId, "progress");
  const watchedTombstones = await readTombstones(db, profileId, "watched");
  const rows = await db
    .prepare("SELECT item_key AS itemKey, position_ticks AS positionTicks, played, updated_at AS updatedAt FROM watch_state WHERE profile_id = ?1")
    .bind(profileId)
    .all<{ itemKey: string; positionTicks: number; played: number; updatedAt: number }>();
  let cleared = 0;
  let unwatched = 0;
  for (const row of rows.results ?? []) {
    const parsed = parseItemKey(row.itemKey);
    if (!parsed || parsed.kind === "series") continue;
    if (!TT_PROGRESS_ID.test(parsed.stremioId)) continue;
    if (row.updatedAt > now - RECONCILE_WRITE_GUARD_SECONDS) continue;
    if (row.positionTicks > 0 && row.played === 0 && !remoteProgressKeys.has(row.itemKey)) {
      const tombstone = progressTombstones.get(row.itemKey);
      if (tombstone === undefined || tombstone < row.updatedAt) {
        await writeWatchPosition(db, profileId, row.itemKey, 0, now).catch(() => undefined);
        cleared += 1;
      }
    }
    if (row.played === 1 && !remoteWatchedKeys.has(row.itemKey) && !remoteProgressKeys.has(row.itemKey)) {
      const tombstone = watchedTombstones.get(row.itemKey);
      if (tombstone === undefined || tombstone < row.updatedAt) {
        await setPlayed(db, profileId, row.itemKey, false, now).catch(() => undefined);
        unwatched += 1;
      }
    }
  }
  return { cleared, unwatched };
}

function profileAddonStatements(
  db: D1Database,
  profileId: string,
  addons: NuvioAddon[],
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM profile_addons WHERE profile_id = ?").bind(profileId),
    ...addons.map((addon, pos) =>
      db
        .prepare(
          "INSERT INTO profile_addons (profile_id, url, position, enabled) VALUES (?, ?, ?, 1) ON CONFLICT(profile_id, url) DO UPDATE SET position = excluded.position, enabled = 1",
        )
        .bind(profileId, addon.url, pos),
    ),
  ];
}

function selectedProfileAddons(
  addons: NuvioAddon[],
  target: { targetAddonId: number; targetNuvioUuid: string | null; isPrimary: boolean },
): NuvioAddon[] {
  return addons
    .filter((a) => matchesNuvioAddon(a, target.targetAddonId, target.isPrimary, target.targetNuvioUuid))
    .sort((a, b) => a.sort_order - b.sort_order);
}

function itemKeyParts(
  itemKey: string,
): { contentId: string; contentType: "movie" | "series"; season: number | null; episode: number | null } | null {
  const movie = /^movie:(.+)$/.exec(itemKey);
  if (movie) return { contentId: movie[1] ?? "", contentType: "movie", season: null, episode: null };
  const ep = /^episode:(.+):(\d+):(\d+)$/.exec(itemKey);
  if (!ep) return null;
  return { contentId: ep[1] ?? "", contentType: "series", season: Number(ep[2]), episode: Number(ep[3]) };
}

function progressKeyFor(contentId: string, season: number | null, episode: number | null): string {
  if (season !== null && season !== undefined && episode !== null && episode !== undefined) {
    return `${contentId}_s${season}e${episode}`;
  }
  return contentId;
}

export async function pushNuvioProgressFor(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  itemKey: string,
  positionTicks: number,
  runtimeTicks: number | null,
  now: number,
): Promise<boolean> {
  const parts = itemKeyParts(itemKey);
  if (!parts) return false;
  const { contentId, contentType, season, episode } = parts;
  if (!TT_RE.test(contentId)) return false;
  if (!runtimeTicks || runtimeTicks <= 0) return false;
  const ms = Math.max(0, Math.round(positionTicks / 10000));
  const dur = Math.max(0, Math.round(runtimeTicks / 10000));
  return runWithNuvioToken(db, fetchImpl, jellinoProfileId, async (token, index) => {
    return nuvioPushWatchProgressRpc(fetchImpl, token, index, [
      {
        content_id: contentId,
        content_type: contentType,
        video_id: contentType === "series" ? `${contentId}:${season ?? 0}:${episode ?? 0}` : contentId,
        season,
        episode,
        position: ms,
        duration: dur,
        last_watched: now * 1000,
        progress_key: progressKeyFor(contentId, season, episode),
      },
    ]);
  });
}

export async function pushNuvioWatchedFor(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  itemKey: string,
  now: number,
): Promise<boolean> {
  const parts = itemKeyParts(itemKey);
  if (!parts) return false;
  const { contentId, contentType, season, episode } = parts;
  if (!TT_RE.test(contentId)) return false;
  return runWithNuvioToken(db, fetchImpl, jellinoProfileId, async (token, index) => {
    return nuvioPushWatchedRpc(fetchImpl, token, index, [
      { content_id: contentId, content_type: contentType, title: "", season, episode, watched_at: now * 1000 },
    ]);
  });
}

export async function deleteNuvioProgressFor(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  itemKey: string,
): Promise<boolean> {
  const parsed = parseItemKey(itemKey);
  if (!parsed || parsed.kind === "series" || !TT_PROGRESS_ID.test(parsed.stremioId)) return false;
  const progressKey = parsed.kind === "movie" ? parsed.stremioId : `${parsed.stremioId}_s${parsed.season}e${parsed.episode}`;
  return runWithNuvioToken(db, fetchImpl, jellinoProfileId, async (token, index) => {
    const res = await nuvioDeleteWatchProgress(fetchImpl, token, index, [progressKey]);
    return res.ok;
  });
}

interface NuvioProgressRestEntry {
  content_id: string;
  content_type: string;
  season?: number | null;
  episode?: number | null;
  position?: number;
  duration?: number;
  last_watched?: number;
}

interface NuvioWatchedRestEntry {
  content_id: string;
  content_type: string;
  season?: number | null;
  episode?: number | null;
  watched_at?: number;
}

interface NuvioLibraryRestEntry {
  content_id: string;
  content_type: string;
  name?: string;
  poster?: string | null;
  added_at?: number;
}

export interface NuvioSnapshotApplyResult {
  progress: number;
  watched: number;
  favorites: number;
  cleared: number;
  unwatched: number;
}

async function safeBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (!statements || statements.length === 0) return;
  const CHUNK_SIZE = 50;
  for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
    const chunk = statements.slice(i, i + CHUNK_SIZE);
    if (chunk.length > 0) {
      await db.batch(chunk);
    }
  }
}

export async function applyNuvioWatchSnapshot(
  db: D1Database,
  profileId: string,
  progress: NuvioProgressRestEntry[] | null,
  watched: NuvioWatchedRestEntry[] | null,
  library: NuvioLibraryRestEntry[] | null,
  now: number,
): Promise<NuvioSnapshotApplyResult> {
  const [progressTombstones, watchedTombstones, favoriteTombstones] = await Promise.all([
    readTombstones(db, profileId, "progress"),
    readTombstones(db, profileId, "watched"),
    readTombstones(db, profileId, "favorite"),
  ]);
  const statements: D1PreparedStatement[] = [];
  const remoteProgressKeys = new Set<string>();
  let progressCount = 0;
  for (const entry of progress ?? []) {
    if (!entry.content_id) continue;
    const isMovie = entry.content_type === "movie" || !entry.season;
    const itemKey = isMovie ? `movie:${entry.content_id}` : `episode:${entry.content_id}:${entry.season}:${entry.episode}`;
    const positionTicks = Math.floor((entry.position || 0) * 10000);
    const durationTicks = Math.floor((entry.duration || 0) * 10000);
    const isPlayed = durationTicks > 0 && positionTicks / durationTicks >= 0.9;
    const updatedAt = Math.floor((entry.last_watched || 0) / 1000) || now;
    const tombstone = progressTombstones.get(itemKey);
    if (tombstone !== undefined && updatedAt <= tombstone) continue;
    remoteProgressKeys.add(itemKey);
    progressCount += 1;
    statements.push(
      db
        .prepare(
          `INSERT INTO watch_state (profile_id, item_key, position_ticks, played, play_count, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, item_key) DO UPDATE SET
             position_ticks = CASE WHEN excluded.updated_at >= watch_state.updated_at THEN excluded.position_ticks ELSE watch_state.position_ticks END,
             played = CASE WHEN excluded.updated_at >= watch_state.updated_at THEN excluded.played ELSE watch_state.played END,
             play_count = CASE WHEN excluded.played = 1 AND watch_state.played = 0 THEN watch_state.play_count + 1 ELSE watch_state.play_count END,
             updated_at = MAX(watch_state.updated_at, excluded.updated_at)`,
        )
        .bind(profileId, itemKey, positionTicks, isPlayed ? 1 : 0, isPlayed ? 1 : 0, updatedAt),
    );
  }
  const remoteWatchedKeys = new Set<string>();
  let watchedCount = 0;
  for (const item of watched ?? []) {
    const itemKey = nuvioWatchedKeyFor(item.content_id, item.content_type, item.season ?? null, item.episode ?? null);
    if (!itemKey) continue;
    const updatedAt = Math.floor((item.watched_at || 0) / 1000) || now;
    const tombstone = watchedTombstones.get(itemKey);
    if (tombstone !== undefined && updatedAt <= tombstone) continue;
    remoteWatchedKeys.add(itemKey);
    watchedCount += 1;
    statements.push(
      db
        .prepare(
          `INSERT INTO watch_state (profile_id, item_key, position_ticks, played, play_count, updated_at)
           VALUES (?, ?, 0, 1, 1, ?)
           ON CONFLICT(profile_id, item_key) DO UPDATE SET
             played = 1,
             position_ticks = 0,
             play_count = MAX(watch_state.play_count, 1),
             updated_at = MAX(watch_state.updated_at, excluded.updated_at)`,
        )
        .bind(profileId, itemKey, updatedAt),
    );
  }
  await safeBatch(db, statements);

  let favoriteCount = 0;
  if (library) {
    const remoteFavoriteKeys = new Set<string>();
    const favoriteStatements: D1PreparedStatement[] = [];
    for (const item of library) {
      const isMovie = item.content_type === "movie";
      const itemKey = isMovie ? `movie:${item.content_id}` : `series:${item.content_id}`;
      const addedAt = item.added_at ? Math.floor(item.added_at / 1000) : now;
      const tombstone = favoriteTombstones.get(itemKey);
      if (tombstone !== undefined && addedAt <= tombstone) continue;
      remoteFavoriteKeys.add(itemKey);
      favoriteCount += 1;
      favoriteStatements.push(
        db
          .prepare(
            `INSERT INTO profile_favorites (profile_id, item_key, content_id, content_type, name, poster, added_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_id, item_key) DO UPDATE SET
               name = excluded.name,
               poster = excluded.poster`,
          )
          .bind(profileId, itemKey, item.content_id, item.content_type, item.name || "", item.poster || null, addedAt),
      );
    }
    const local = await db
      .prepare("SELECT item_key AS itemKey, added_at AS addedAt FROM profile_favorites WHERE profile_id = ?1")
      .bind(profileId)
      .all<{ itemKey: string; addedAt: number }>()
      .catch(() => ({ results: [] as { itemKey: string; addedAt: number }[] }));
    for (const row of local.results ?? []) {
      if (remoteFavoriteKeys.has(row.itemKey)) continue;
      if (row.addedAt > now - RECONCILE_WRITE_GUARD_SECONDS) continue;
      const tombstone = favoriteTombstones.get(row.itemKey);
      if (tombstone !== undefined && tombstone >= row.addedAt) continue;
      favoriteStatements.push(
        db.prepare("DELETE FROM profile_favorites WHERE profile_id = ?1 AND item_key = ?2").bind(profileId, row.itemKey),
      );
    }
    await safeBatch(db, favoriteStatements);
  }

  const reconciled =
    progress && watched ? await reconcileWatchState(db, profileId, remoteProgressKeys, remoteWatchedKeys, now) : { cleared: 0, unwatched: 0 };
  return { progress: progressCount, watched: watchedCount, favorites: favoriteCount, ...reconciled };
}

const NUVIO_PULL_INTERVAL_SECONDS = 60;

const resumePullLast = new Map<string, number>();
const resumePullInFlight = new Map<string, Promise<void>>();
const resumePullFingerprint = new Map<string, string>();

export function resetNuvioWatchState(): void {
  resumePullLast.clear();
  resumePullInFlight.clear();
  resumePullFingerprint.clear();
}

function fingerprintOf(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export async function refreshNuvioWatch(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
  now: number,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!options.force) {
    const last = resumePullLast.get(jellinoProfileId) ?? 0;
    if (now - last < NUVIO_PULL_INTERVAL_SECONDS) return;
  }
  const existing = resumePullInFlight.get(jellinoProfileId);
  if (existing) return existing;
  const task = (async () => {
    resumePullLast.set(jellinoProfileId, now);
    try {
      const profile = await db
        .prepare("SELECT nuvio_profile_index AS nuvioIndex FROM profiles WHERE id = ?")
        .bind(jellinoProfileId)
        .first<{ nuvioIndex: number | null }>();
      const index = profile?.nuvioIndex;
      if (index === null || index === undefined) return;
      const tokenData = await getValidNuvioToken(db, fetchImpl);
      if (!tokenData) return;
      const [prog, watched] = await Promise.all([
        nuvioPullWatchProgressRpc(fetchImpl, tokenData.token, index),
        nuvioPullWatchedRpc(fetchImpl, tokenData.token, index),
      ]);
      if (!prog.ok || !watched.ok) return;
      const fingerprint = fingerprintOf([
        (prog.progress ?? []).map((entry) => [entry.content_id, entry.season ?? null, entry.episode ?? null, entry.position, entry.last_watched]),
        (watched.watched ?? []).map((entry) => [entry.content_id, entry.season ?? null, entry.episode ?? null, entry.watched_at]),
      ]);
      if (resumePullFingerprint.get(jellinoProfileId) === fingerprint) return;
      resumePullFingerprint.set(jellinoProfileId, fingerprint);
      if (prog.progress) await mergeNuvioProgress(db, jellinoProfileId, prog.progress, now);
      if (watched.watched) await mergeNuvioWatched(db, jellinoProfileId, watched.watched, now);
    } catch {
      void 0;
    } finally {
      resumePullInFlight.delete(jellinoProfileId);
    }
  })();
  resumePullInFlight.set(jellinoProfileId, task);
  return task;
}

export async function syncHomeLibraries(
  db: D1Database,
  fetchImpl: typeof fetch,
  cache: Cache | null,
): Promise<{ derived: number }> {
  let derived = 0;
  try {
    const tokenData = await getValidNuvioToken(db, fetchImpl);
    if (!tokenData) return { derived };
    const existing = await db
      .prepare("SELECT id, nuvio_profile_index FROM profiles")
      .all<{ id: string; nuvio_profile_index: number | null }>()
      .catch(() => ({ results: [] as { id: string; nuvio_profile_index: number | null }[] }));
    for (const row of existing.results ?? []) {
      const index = row.nuvio_profile_index;
      if (index === null || index === undefined) continue;
      try {
        const [homeRes, collRes] = await Promise.all([
          nuvioPullHomeSettings(fetchImpl, tokenData.token, index),
          nuvioPullCollectionsRpc(fetchImpl, tokenData.token, index),
        ]);
        if (!homeRes.ok || !homeRes.home) continue;
        const urls = await catalogBases(db, row.id);
        const effectiveUrls = urls && urls.length > 0 ? urls : [];
        if (effectiveUrls.length === 0) continue;
        const addons: NuvioAddon[] = effectiveUrls.map((url, pos) => ({
          profile_id: index,
          url,
          name: url,
          enabled: true,
          sort_order: pos,
        }));
        await deriveLibraryFromNuvio(db, fetchImpl, cache, row.id, homeRes.home, collRes.ok ? (collRes.collections ?? null) : null, addons);
        derived += 1;
      } catch {
        void 0;
      }
    }
  } catch {
    void 0;
  }
  return { derived };
}

export async function syncProfileFromNuvio(
  db: D1Database,
  fetchImpl: typeof fetch,
  jellinoProfileId: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    let tokenData = await getValidNuvioToken(db, fetchImpl);
    if (!tokenData) {
      return { ok: false, message: "No active Nuvio account linked" };
    }

    const profile = await db
      .prepare("SELECT id, name, nuvio_profile_id, nuvio_profile_index, uses_primary_addons FROM profiles WHERE id = ? AND disabled = 0")
      .bind(jellinoProfileId)
      .first<{ id: string; name: string; nuvio_profile_id: string | null; nuvio_profile_index: number | null; uses_primary_addons: number | null }>();

    if (!profile || profile.nuvio_profile_index === null || profile.nuvio_profile_index === undefined) {
      return { ok: false, message: "Profile not linked to Nuvio" };
    }

    const adminRow = await db
      .prepare("SELECT id, nuvio_profile_id, nuvio_profile_index FROM profiles WHERE is_admin = 1")
      .first<{ id: string; nuvio_profile_id: string | null; nuvio_profile_index: number | null }>();
    const indexRows = await db
      .prepare("SELECT nuvio_profile_index FROM profiles")
      .all<{ nuvio_profile_index: number | null }>();
    const indexes = (indexRows.results ?? [])
      .map((row) => row.nuvio_profile_index)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const minIndex = indexes.length > 0 ? Math.min(...indexes) : profile.nuvio_profile_index;
    const isPrimary = profile.id === adminRow?.id || profile.nuvio_profile_index === minIndex;
    const targetNuvioUuid = profile.nuvio_profile_id;

    let addonsResult = await nuvioPullAddons(fetchImpl, tokenData.token);
    if (!addonsResult.ok && (addonsResult.error?.includes("401") || addonsResult.error?.includes("403"))) {
      tokenData = await getValidNuvioToken(db, fetchImpl, true);
      if (!tokenData) {
        return { ok: false, message: "nuvio session expired or invalid" };
      }
      addonsResult = await nuvioPullAddons(fetchImpl, tokenData.token);
    }

    if (addonsResult.ok && addonsResult.addons) {
      const hasZero = addonsResult.addons.some((a) => a && (a.profile_id === 0 || Number(a.profile_id) === 0));
      const target = nuvioAddonTarget({
        selfIndex: profile.nuvio_profile_index,
        selfUuid: profile.nuvio_profile_id,
        usesPrimaryAddons: profile.uses_primary_addons === 1,
        primaryIndex: adminRow?.nuvio_profile_index ?? null,
        primaryUuid: adminRow?.nuvio_profile_id ?? null,
        isPrimaryProfile: isPrimary,
        minIndex,
        hasZeroAddon: hasZero,
      });
      const profileAddons = selectedProfileAddons(addonsResult.addons, target);

      if (profileAddons.length > 0) {
        await safeBatch(db, profileAddonStatements(db, jellinoProfileId, profileAddons));
      }
    }

    let progressEntries: NuvioProgressRestEntry[] | null = null;
    let progressResult = await nuvioPullWatchProgress(fetchImpl, tokenData.token, profile.nuvio_profile_index);
    if (!progressResult.ok && (progressResult.error?.includes("401") || progressResult.error?.includes("403"))) {
      tokenData = await getValidNuvioToken(db, fetchImpl, true);
      if (!tokenData) {
        return { ok: false, message: "nuvio session expired or invalid" };
      }
      progressResult = await nuvioPullWatchProgress(fetchImpl, tokenData.token, profile.nuvio_profile_index);
    }
    if (progressResult.ok) progressEntries = progressResult.entries ?? [];

    let watchedEntries: NuvioWatchedRestEntry[] | null = null;
    let watchedResult = await nuvioPullWatchedItems(fetchImpl, tokenData.token, profile.nuvio_profile_index);
    if (!watchedResult.ok && (watchedResult.error?.includes("401") || watchedResult.error?.includes("403"))) {
      tokenData = await getValidNuvioToken(db, fetchImpl, true);
      if (!tokenData) {
        return { ok: false, message: "nuvio session expired or invalid" };
      }
      watchedResult = await nuvioPullWatchedItems(fetchImpl, tokenData.token, profile.nuvio_profile_index);
    }
    if (watchedResult.ok) watchedEntries = watchedResult.items ?? [];

    let libraryEntries: NuvioLibraryRestEntry[] | null = null;
    let libraryResult = await nuvioPullLibrary(fetchImpl, tokenData.token, profile.nuvio_profile_index);
    if (!libraryResult.ok && (libraryResult.error?.includes("401") || libraryResult.error?.includes("403"))) {
      tokenData = await getValidNuvioToken(db, fetchImpl, true);
      if (!tokenData) {
        return { ok: false, message: "nuvio session expired or invalid" };
      }
      libraryResult = await nuvioPullLibrary(fetchImpl, tokenData.token, profile.nuvio_profile_index);
    }
    if (libraryResult.ok) libraryEntries = libraryResult.items ?? [];

    const applied = await applyNuvioWatchSnapshot(
      db,
      jellinoProfileId,
      progressEntries,
      watchedEntries,
      libraryEntries,
      Math.floor(Date.now() / 1000),
    );
    return {
      ok: true,
      message: `pulled progress ${applied.progress}, watched ${applied.watched}, favorites ${applied.favorites}, cleared ${applied.cleared}, unwatched ${applied.unwatched}`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function syncFromNuvio(
  db: D1Database,
  fetchImpl: typeof fetch,
  options: { force?: boolean } = {},
): Promise<{ ok: boolean; message: string; profilesCount: number }> {
  try {
    const nowMsLock = Math.floor(Date.now() / 1000);
    if (!options.force) {
      const lockRow = await db
        .prepare("SELECT value FROM settings WHERE key = 'nuvio_sync_lock'")
        .first<{ value: string }>();
      const lastStart = lockRow ? Number(lockRow.value) : NaN;
      if (Number.isFinite(lastStart) && nowMsLock - lastStart < 60) {
        return { ok: true, message: "sync skipped, another sync ran recently", profilesCount: 0 };
      }
    }
    await db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("nuvio_sync_lock", String(nowMsLock))
      .run();

    let tokenData = await getValidNuvioToken(db, fetchImpl);
    if (!tokenData) {
      await deleteSetting(db, "nuvio_sync_lock");
      return { ok: false, message: "No active Nuvio account linked", profilesCount: 0 };
    }

    let [profilesResult, addonsResult] = await Promise.all([
      nuvioPullProfiles(fetchImpl, tokenData.token),
      nuvioPullAddons(fetchImpl, tokenData.token),
    ]);

    if (!profilesResult.ok && (profilesResult.error?.includes("401") || profilesResult.error?.includes("403"))) {
      tokenData = await getValidNuvioToken(db, fetchImpl, true);
      if (!tokenData) {
        await deleteSetting(db, "nuvio_sync_lock");
        return { ok: false, message: "Nuvio session expired or invalid", profilesCount: 0 };
      }
      profilesResult = await nuvioPullProfiles(fetchImpl, tokenData.token);
      addonsResult = await nuvioPullAddons(fetchImpl, tokenData.token);
    }

    if (!profilesResult.ok || !profilesResult.profiles) {
      await deleteSetting(db, "nuvio_sync_lock");
      return { ok: false, message: profilesResult.error || "Failed to fetch profiles from Nuvio", profilesCount: 0 };
    }

    const nuvioProfiles = profilesResult.profiles.slice(0, 6);
    const nuvioAddons = addonsResult.addons ?? [];

    const now = Math.floor(Date.now() / 1000);

    const existingProfiles = await db
      .prepare("SELECT id, name, nuvio_profile_id, nuvio_profile_index, is_admin FROM profiles")
      .all<{ id: string; name: string; nuvio_profile_id: string | null; nuvio_profile_index: number | null; is_admin: number }>();

    const existingList = existingProfiles.results ?? [];
    const existingByNuvioId = new Map<string, (typeof existingList)[0]>();
    const existingByName = new Map<string, (typeof existingList)[0]>();
    for (const p of existingList) {
      if (p.nuvio_profile_id) existingByNuvioId.set(p.nuvio_profile_id, p);
      existingByName.set(p.name.toLowerCase(), p);
    }

    const activeNuvioIds = new Set<string>();
    const importedProfileIds = new Map<string, string>();
    const minIndex = Math.min(...nuvioProfiles.map((p) => p.profile_index ?? 0));
    const primaryProfile = nuvioProfiles.find((p) => p.profile_index === minIndex) ?? nuvioProfiles[0];
    const hasZero = nuvioAddons.some((a) => a && (a.profile_id === 0 || Number(a.profile_id) === 0));

    for (const np of nuvioProfiles) {
      if (!np) continue;
      const profileName = (np.name || ("Profile " + ((np.profile_index ?? 0) + 1))).trim();
      activeNuvioIds.add(np.id);
      const matched = existingByNuvioId.get(np.id) ?? existingByName.get(profileName.toLowerCase());
      let jellinoProfileId: string;

      const avatarUrl = resolveNuvioAvatarUrl(np);

      if (matched) {
        jellinoProfileId = matched.id;
      importedProfileIds.set(np.id, jellinoProfileId);
        await db
          .prepare(
            "UPDATE profiles SET name = ?, nuvio_profile_id = ?, nuvio_profile_index = ?, avatar_color_hex = ?, avatar_url = ?, uses_primary_addons = ?, disabled = 0 WHERE id = ?",
          )
          .bind(
            profileName,
            np.id,
            np.profile_index,
            np.avatar_color_hex || "#10b981",
            avatarUrl,
            np.uses_primary_addons ? 1 : 0,
            matched.id,
          )
          .run();
        if (typeof caches !== "undefined" && Boolean(caches?.default)) {
          await caches.default
            .delete(new Request(`https://jellino.local/avatar/${matched.id}`, { method: "GET" }))
            .catch(() => undefined);
        }
      } else {
        jellinoProfileId = crypto.randomUUID();
      importedProfileIds.set(np.id, jellinoProfileId);
        const isAdmin = (existingList.length === 0 && (np.profile_index === minIndex || np.id === nuvioProfiles[0]?.id)) ? 1 : 0;
        await db
          .prepare(
            "INSERT INTO profiles (id, name, password_hash, salt, is_admin, addon_mode, disabled, created_at, nuvio_profile_id, nuvio_profile_index, avatar_color_hex, avatar_url, uses_primary_addons) VALUES (?, ?, '', '', ?, 'custom', 0, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            jellinoProfileId,
            profileName,
            isAdmin,
            now,
            np.id,
            np.profile_index,
            np.avatar_color_hex || "#10b981",
            avatarUrl,
            np.uses_primary_addons ? 1 : 0,
          )
          .run();
      }

      try {
        const isPrimary = np.id === primaryProfile?.id || np.profile_index === minIndex;
        const target = nuvioAddonTarget({
          selfIndex: np.profile_index,
          selfUuid: np.id,
          usesPrimaryAddons: Boolean(np.uses_primary_addons),
          primaryIndex: primaryProfile?.profile_index ?? null,
          primaryUuid: primaryProfile?.id ?? null,
          isPrimaryProfile: isPrimary,
          minIndex,
          hasZeroAddon: hasZero,
        });

        const profileAddons = selectedProfileAddons(nuvioAddons, target);
        if (profileAddons.length > 0) {
          await safeBatch(db, profileAddonStatements(db, jellinoProfileId, profileAddons));
        }
      } catch {
        void 0;
      }
    }

    for (const np of nuvioProfiles) {
      const jellinoProfileId = importedProfileIds.get(np.id);
      if (!jellinoProfileId) continue;
      try {
        let progressEntries: NuvioProgressRestEntry[] | null = null;
        let watchedEntries: NuvioWatchedRestEntry[] | null = null;
        let libraryEntries: NuvioLibraryRestEntry[] | null = null;
        try {
          const progressResult = await nuvioPullWatchProgress(fetchImpl, tokenData.token, np.profile_index);
          if (progressResult.ok) progressEntries = progressResult.entries ?? [];
          const watchedResult = await nuvioPullWatchedItems(fetchImpl, tokenData.token, np.profile_index);
          if (watchedResult.ok) watchedEntries = watchedResult.items ?? [];
          const libraryResult = await nuvioPullLibrary(fetchImpl, tokenData.token, np.profile_index);
          if (libraryResult.ok) libraryEntries = libraryResult.items ?? [];
        } catch {
          void 0;
        }
        await applyNuvioWatchSnapshot(db, jellinoProfileId, progressEntries, watchedEntries, libraryEntries, now);
      } catch {
        void 0;
      }
    }

    for (const existing of existingList) {
      if (existing.nuvio_profile_id && !activeNuvioIds.has(existing.nuvio_profile_id)) {
        await db.prepare("UPDATE profiles SET disabled = 1 WHERE id = ?").bind(existing.id).run();
        await bumpTokenEpoch(db, existing.id);
      }
    }

    const previousAccount = await readNuvioAccount(db);
    const updatedAccount: NuvioAccountSettings = {
      email: tokenData.email,
      access_token: tokenData.token,
      refresh_token: previousAccount?.refresh_token ?? "",
      expires_at: previousAccount?.expires_at ?? now + 3600,
      last_sync: now,
    };
    await saveNuvioAccount(db, updatedAccount);

    return { ok: true, message: "Sync successful", profilesCount: nuvioProfiles.length };
  } catch (err) {
    await deleteSetting(db, "nuvio_sync_lock");
    return { ok: false, message: err instanceof Error ? err.message : String(err), profilesCount: 0 };
  }
}
