import type { Context, Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "./db";
import { decodeItem, parseItemKey } from "./ids";
import { verifiedOwner } from "./session";
import { logApp } from "./applog";
import { maybeMaintenance } from "./cron";
import { catalogBases } from "./library";
import { fetchMeta, indexedEpisodes, profileMeta, runtimeTicks, seasonEpisodes, seasonNumbers, videoEpisodeNumber, type StremioMeta } from "./meta";
import {
  clearTombstone,
  deleteNuvioFavoriteFor,
  deleteNuvioProgressFor,
  deleteNuvioWatchedFor,
  pushNuvioFavoriteFor,
  pushNuvioProgressFor,
  pushNuvioWatchedFor,
  recordTombstone,
} from "./nuvio-home";
import { hideItem, unhideItem } from "./hidden";
import { boolQuery } from "./query";
import { warmPlaybackFor } from "./streams";
import {
  applyStopPosition,
  clearWatchPosition,
  itemKey,
  readWatchEntry,
  readWatchPosition,
  recordPlayStart,
  resetWatchStateCache,
  setPlayed,
  writeWatchPosition,
} from "./watch-state";

function background(c: Context<{ Bindings: Env }>, task: Promise<unknown>): void {
  try {
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(task);
    } else {
      task.catch(() => undefined);
    }
  } catch {
    task.catch(() => undefined);
  }
}

const PROGRESS_DEBOUNCE_TICKS = 100_000_000;
const lastWrittenTicks = new Map<string, number>();
const lastWrittenTime = new Map<string, number>();

async function nuvioRuntime(db: D1Database, profileId: string, key: string): Promise<number | null> {
  try {
    const parsed = parseItemKey(key);
    if (!parsed || parsed.kind === "series") return null;
    const urls = await catalogBases(db, profileId);
    if (!urls || urls.length === 0) return null;
    const resolved = await fetchMeta(
      caches.default,
      fetch,
      urls,
      urls[0] as string,
      parsed.kind === "movie" ? "movie" : "series",
      parsed.stremioId,
    );
    return resolved ? runtimeTicks(resolved.meta.runtime) : null;
  } catch {
    return null;
  }
}

const nuvioPushLast = new Map<string, { at: number; key: string }>();
const NUVIO_PUSH_THROTTLE_SECONDS = 60;

function pushProgressToNuvioRpc(
  c: Context<{ Bindings: Env }>,
  owner: string,
  key: string,
  positionTicks: number,
  now: number,
  force: boolean,
): void {
  const last = nuvioPushLast.get(owner);
  if (!force && last && last.key === key && now - last.at < NUVIO_PUSH_THROTTLE_SECONDS) return;
  nuvioPushLast.set(owner, { at: now, key });
  background(
    c,
    (async () => {
      const runtime = await nuvioRuntime(c.env.DB, owner, key);
      await pushNuvioProgressFor(c.env.DB, fetch, owner, key, positionTicks, runtime, now);
    })(),
  );
}

function seasonEpisodeKeys(
  meta: StremioMeta,
  decoded: NonNullable<ReturnType<typeof decodeItem>>,
): string[] {
  const seasons = decoded.kind === "season" ? [decoded.season ?? 0] : seasonNumbers(meta);
  const keys: string[] = [];
  for (const season of seasons) {
    for (const episode of seasonEpisodes(meta, season)) {
      const number = videoEpisodeNumber(episode);
      if (number !== null && number !== undefined) keys.push(`episode:${decoded.stremioId}:${season}:${number}`);
    }
  }
  return keys;
}

async function applyPlayedToEpisodeKeys(db: D1Database, owner: string, epKeys: string[], played: boolean, now: number): Promise<void> {
  for (const epKey of epKeys) {
    await setPlayed(db, owner, epKey, played, now);
    await clearWatchPosition(db, owner, epKey, now);
  }
}

function pushPlayedToEpisodeKeys(
  c: Context<{ Bindings: Env }>,
  owner: string,
  epKeys: string[],
  played: boolean,
  now: number,
): void {
  background(
    c,
    (async () => {
      for (const epKey of epKeys) {
        if (played) {
          await clearTombstone(c.env.DB, owner, "watched", epKey);
          await pushNuvioWatchedFor(c.env.DB, fetch, owner, epKey, now);
          await deleteNuvioProgressFor(c.env.DB, fetch, owner, epKey);
          await recordTombstone(c.env.DB, owner, "progress", epKey, now);
        } else {
          await recordTombstone(c.env.DB, owner, "watched", epKey, now);
          await recordTombstone(c.env.DB, owner, "progress", epKey, now);
          await deleteNuvioWatchedFor(c.env.DB, fetch, owner, epKey);
          await deleteNuvioProgressFor(c.env.DB, fetch, owner, epKey);
        }
      }
    })(),
  );
}

export function clearProgressDebounce(profileId?: string, key?: string): void {
  if (profileId && key) {
    const memKey = `${profileId}:${key}`;
    lastWrittenTicks.delete(memKey);
    lastWrittenTime.delete(memKey);
  } else if (profileId) {
    for (const k of lastWrittenTicks.keys()) {
      if (k.startsWith(`${profileId}:`)) {
        lastWrittenTicks.delete(k);
        lastWrittenTime.delete(k);
      }
    }
  } else {
    lastWrittenTicks.clear();
    lastWrittenTime.clear();
  }
  resetWatchStateCache(profileId, key);
}

async function sessionBody(c: Context<{ Bindings: Env }>): Promise<{
  itemId: string;
  positionTicks?: number | undefined;
  isPaused: boolean;
  mediaSourceId?: string | undefined;
  subtitleStreamIndex?: number | undefined;
}> {
  let itemId = c.req.query("ItemId") ?? "";
  let positionTicks: number | undefined = undefined;
  if (c.req.query("PositionTicks") !== undefined) {
    const qTicks = Number(c.req.query("PositionTicks"));
    if (Number.isFinite(qTicks) && qTicks >= 0) positionTicks = Math.floor(qTicks);
  }
  let isPaused = boolQuery(c, "IsPaused") === true;
  let mediaSourceId: string | undefined = c.req.query("MediaSourceId") ?? undefined;
  let subtitleStreamIndex: number | undefined = c.req.query("SubtitleStreamIndex") !== undefined ? Number(c.req.query("SubtitleStreamIndex")) : undefined;
  try {
    const body = (await c.req.json()) as {
      ItemId?: unknown;
      PositionTicks?: unknown;
      IsPaused?: unknown;
      isPaused?: unknown;
      EventName?: unknown;
      MediaSourceId?: unknown;
      SubtitleStreamIndex?: unknown;
    };
    if (typeof body.ItemId === "string" && body.ItemId) itemId = body.ItemId;
    if (body.PositionTicks !== undefined && body.PositionTicks !== null) {
      const ticks = Number(body.PositionTicks);
      if (Number.isFinite(ticks) && ticks >= 0) positionTicks = Math.floor(ticks);
    }
    if (body.IsPaused === true || body.isPaused === true || body.EventName === "Pause") isPaused = true;
    if (typeof body.MediaSourceId === "string" && body.MediaSourceId) mediaSourceId = body.MediaSourceId;
    if (typeof body.SubtitleStreamIndex === "number") subtitleStreamIndex = body.SubtitleStreamIndex;
  } catch {
    void 0;
  }
  return { itemId, positionTicks, isPaused, mediaSourceId, subtitleStreamIndex };
}

async function warmNextEpisode(db: D1Database, profileId: string, key: string): Promise<void> {
  try {
    const parsed = parseItemKey(key);
    if (!parsed || parsed.kind !== "episode") return;
    const urls = await catalogBases(db, profileId);
    if (!urls || urls.length === 0) return;
    const resolved = await fetchMeta(caches.default, fetch, urls, urls[0] as string, "series", parsed.stremioId);
    if (!resolved) return;
    const videos = indexedEpisodes(resolved.meta);
    const index = videos.findIndex((entry) => entry.season === parsed.season && entry.episode === parsed.episode);
    const next = index >= 0 ? videos[index + 1] : undefined;
    if (!next) return;
    await warmPlaybackFor(db, profileId, caches.default, fetch, "series", parsed.stremioId, next.season, next.episode);
  } catch {
    void 0;
  }
}

export function registerSessions(app: Hono<{ Bindings: Env }>) {
  async function sessionOwner(c: Context<{ Bindings: Env }>): Promise<string | null> {
    return verifiedOwner(c.env.DB, c.req.raw, Math.floor(Date.now() / 1000));
  }

  app.post("/Sessions/Playing", async (c) => {
    const owner = await sessionOwner(c);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    const { itemId, positionTicks = 0, mediaSourceId, subtitleStreamIndex } = await sessionBody(c);
    const key = itemId ? itemKey(itemId) : null;
    if (!key) return c.json({ error: "not found" }, 404);
    const now = Math.floor(Date.now() / 1000);
    await recordPlayStart(c.env.DB, owner, key, now);
    await unhideItem(c.env.DB, owner, key).catch(() => undefined);
    if (mediaSourceId || subtitleStreamIndex !== undefined) {
      await writeWatchPosition(c.env.DB, owner, key, positionTicks, now, mediaSourceId, subtitleStreamIndex);
    }
    pushProgressToNuvioRpc(c, owner, key, positionTicks, now, true);
    background(c, warmNextEpisode(c.env.DB, owner, key));
    return c.json({});
  });

  app.post("/Sessions/Playing/Progress", async (c) => {
    const owner = await sessionOwner(c);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    const { itemId, positionTicks = 0, isPaused, mediaSourceId, subtitleStreamIndex } = await sessionBody(c);
    const key = itemId ? itemKey(itemId) : null;
    if (!key) return c.json({ error: "not found" }, 404);

    const memKey = `${owner}:${key}`;
    const prevTicks = lastWrittenTicks.get(memKey);
    const prevTime = lastWrittenTime.get(memKey);
    const now = Math.floor(Date.now() / 1000);

    if (
      !isPaused &&
      prevTicks !== undefined &&
      Math.abs(positionTicks - prevTicks) < PROGRESS_DEBOUNCE_TICKS &&
      prevTime !== undefined &&
      now - prevTime < 10
    ) {
      return c.json({});
    }

    lastWrittenTicks.set(memKey, positionTicks);
    lastWrittenTime.set(memKey, now);
    await writeWatchPosition(c.env.DB, owner, key, positionTicks, now, mediaSourceId, subtitleStreamIndex);
    pushProgressToNuvioRpc(c, owner, key, positionTicks, now, false);

    return c.json({});
  });

  app.post("/Sessions/Playing/Stopped", async (c) => {
    const owner = await sessionOwner(c);
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    const { itemId, positionTicks: rawTicks } = await sessionBody(c);
    const key = itemId ? itemKey(itemId) : null;
    if (!key) return c.json({ error: "not found" }, 404);
    const memKey = `${owner}:${key}`;
    const inMemoryTicks = lastWrittenTicks.get(memKey);
    lastWrittenTicks.delete(memKey);
    lastWrittenTime.delete(memKey);
    const now = Math.floor(Date.now() / 1000);
    const positionTicks = rawTicks ?? inMemoryTicks ?? (await readWatchPosition(c.env.DB, owner, key)) ?? 0;
    await applyStopPosition(c.env.DB, owner, key, positionTicks, now);

    background(c, maybeMaintenance(c.env.DB, fetch, now));
    background(
      c,
      (async () => {
        const entry = await readWatchEntry(c.env.DB, owner, key);
        if (entry && entry.played === 1) {
          await pushNuvioWatchedFor(c.env.DB, fetch, owner, key, now);
          await deleteNuvioProgressFor(c.env.DB, fetch, owner, key);
          await recordTombstone(c.env.DB, owner, "progress", key, now);
          return;
        }
        if (!entry || entry.positionTicks <= 0) {
          await deleteNuvioProgressFor(c.env.DB, fetch, owner, key);
          await recordTombstone(c.env.DB, owner, "progress", key, now);
          return;
        }
        const runtime = await nuvioRuntime(c.env.DB, owner, key);
        await pushNuvioProgressFor(c.env.DB, fetch, owner, key, entry.positionTicks, runtime, now);
      })(),
    );
    return c.json({});
  });

  type ScopedSession =
    | { ok: false; response: Response }
    | { ok: true; owner: string; key: string | null; itemId: string; now: number; decoded: ReturnType<typeof decodeItem> };

  async function scopedSession(c: Context<{ Bindings: Env }>, scopedUserId?: string): Promise<ScopedSession> {
    const requested = scopedUserId ?? c.req.query("userId") ?? c.req.query("UserId");
    const itemId = c.req.param("itemId") ?? c.req.query("ItemId") ?? "";
    const owner = await sessionOwner(c);
    if (!owner || (requested && requested !== owner)) return { ok: false, response: c.json({ error: "unauthorized" }, 401) };
    const decoded = decodeItem(itemId);
    const key = itemId ? itemKey(itemId) : null;
    if (!key && decoded?.kind !== "season") return { ok: false, response: c.json({ error: "not found" }, 404) };
    return { ok: true, owner, key, itemId, now: Math.floor(Date.now() / 1000), decoded };
  }

  async function playState(c: Context<{ Bindings: Env }>, played: boolean, scopedUserId?: string) {
    const scope = await scopedSession(c, scopedUserId);
    if (!scope.ok) return scope.response;
    const { owner, key, itemId, now, decoded } = scope;
    if (decoded && (decoded.kind === "season" || decoded.kind === "series")) {
      const cache = typeof caches !== "undefined" ? caches.default : (null as unknown as Cache);
      const resolved = await profileMeta(c.env.DB, cache, fetch, owner, decoded.addonUrl, "series", decoded.stremioId).catch(() => null);
      if (resolved) {
        const epKeys = seasonEpisodeKeys(resolved.meta, decoded);
        if (key) {
          await setPlayed(c.env.DB, owner, key, played, now);
          await clearWatchPosition(c.env.DB, owner, key, now);
        }
        await applyPlayedToEpisodeKeys(c.env.DB, owner, epKeys, played, now);
        pushPlayedToEpisodeKeys(c, owner, epKeys, played, now);
        background(
          c,
          logApp(c.env.DB, {
            at: now,
            level: "info",
            category: "playstate",
            kind: played ? "played" : "unplayed",
            profileId: owner,
            message: `${key ?? itemId} eps=${epKeys.length}`,
            url: "",
          }),
        );
        return c.json({
          Played: played,
          PlayCount: played ? 1 : 0,
          PlaybackPositionTicks: 0,
          ItemId: itemId,
        });
      }
    }
    if (!key) return c.json({ error: "not found" }, 404);
    const entry = await setPlayed(c.env.DB, owner, key, played, now);
    await clearWatchPosition(c.env.DB, owner, key, now);
    background(c, logApp(c.env.DB, { at: now, level: "info", category: "playstate", kind: played ? "played" : "unplayed", profileId: owner, message: key, url: "" }));
    background(
      c,
      (async () => {
        if (played) {
          await clearTombstone(c.env.DB, owner, "watched", key);
          await pushNuvioWatchedFor(c.env.DB, fetch, owner, key, now);
          await deleteNuvioProgressFor(c.env.DB, fetch, owner, key);
          await recordTombstone(c.env.DB, owner, "progress", key, now);
          return;
        }
        await recordTombstone(c.env.DB, owner, "watched", key, now);
        await recordTombstone(c.env.DB, owner, "progress", key, now);
        await deleteNuvioWatchedFor(c.env.DB, fetch, owner, key);
        await deleteNuvioProgressFor(c.env.DB, fetch, owner, key);
      })(),
    );
    return c.json({
      Played: entry.played === 1,
      PlayCount: entry.playCount,
      PlaybackPositionTicks: 0,
      ItemId: itemId,
    });
  }

  app.post("/Users/:userId/PlayedItems/:itemId", (c) => playState(c, true, c.req.param("userId")));
  app.delete("/Users/:userId/PlayedItems/:itemId", (c) => playState(c, false, c.req.param("userId")));
  app.post("/UserPlayedItems/:itemId", (c) => playState(c, true));
  app.delete("/UserPlayedItems/:itemId", (c) => playState(c, false));
  app.post("/Users/:userId/Items/:itemId/PlayState", async (c) => {
    let played = true;
    try {
      const body = (await c.req.json()) as { Played?: unknown };
      if (typeof body.Played === "boolean") played = body.Played;
    } catch {
      if (boolQuery(c, "Played") === false) played = false;
    }
    return playState(c, played, c.req.param("userId"));
  });

  type ScopedTarget = { owner: string; key: string; itemId: string; now: number };

  async function scopedTarget(c: Context<{ Bindings: Env }>, scopedUserId?: string): Promise<ScopedTarget | Response> {
    const scope = await scopedSession(c, scopedUserId);
    if (!scope.ok) return scope.response;
    if (!scope.key) return c.json({ error: "not found" }, 404);
    return { owner: scope.owner, key: scope.key, itemId: scope.itemId, now: scope.now };
  }

  async function favoriteState(c: Context<{ Bindings: Env }>, isFav: boolean, scopedUserId?: string) {
    const target = await scopedTarget(c, scopedUserId);
    if (target instanceof Response) return target;
    const { owner, key, itemId, now } = target;
    const parsed = parseItemKey(key);
    const contentId = parsed?.stremioId ?? key;
    const contentType = parsed?.kind === "movie" ? "movie" : "series";

    if (isFav) {
      await c.env.DB
        .prepare(
          "INSERT OR REPLACE INTO profile_favorites (profile_id, item_key, content_id, content_type, name, poster, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(owner, key, contentId, contentType, contentId, null, now)
        .run();
    } else {
      await c.env.DB
        .prepare("DELETE FROM profile_favorites WHERE profile_id = ? AND item_key = ?")
        .bind(owner, key)
        .run();
    }

    background(c, logApp(c.env.DB, { at: now, level: "info", category: "playstate", kind: isFav ? "favorite" : "unfavorite", profileId: owner, message: key, url: "" }));
    background(
      c,
      (async () => {
        if (isFav) {
          await clearTombstone(c.env.DB, owner, "favorite", key);
          await pushNuvioFavoriteFor(c.env.DB, fetch, owner, key, { name: contentId, poster: null }, now);
          return;
        }
        await recordTombstone(c.env.DB, owner, "favorite", key, now);
        await deleteNuvioFavoriteFor(c.env.DB, fetch, owner, key);
      })(),
    );

    const entry = await readWatchEntry(c.env.DB, owner, key);
    return c.json({
      Played: (entry?.played ?? 0) === 1,
      PlayCount: entry?.playCount ?? 0,
      PlaybackPositionTicks: entry?.positionTicks ?? 0,
      ItemId: itemId,
      IsFavorite: isFav,
    });
  }

  async function userDataState(c: Context<{ Bindings: Env }>, scopedUserId?: string) {
    const target = await scopedTarget(c, scopedUserId);
    if (target instanceof Response) return target;
    const { owner, key, itemId, now } = target;
    let body: { Played?: unknown; PlaybackPositionTicks?: unknown } = {};
    try {
      body = (await c.req.json()) as { Played?: unknown; PlaybackPositionTicks?: unknown };
    } catch {
      body = {};
    }
    if (typeof body.Played === "boolean") {
      await setPlayed(c.env.DB, owner, key, body.Played, now);
      await clearWatchPosition(c.env.DB, owner, key, now);
      background(
        c,
        (async () => {
          if (body.Played) {
            await clearTombstone(c.env.DB, owner, "watched", key);
            await pushNuvioWatchedFor(c.env.DB, fetch, owner, key, now);
            await deleteNuvioProgressFor(c.env.DB, fetch, owner, key);
            await recordTombstone(c.env.DB, owner, "progress", key, now);
            return;
          }
          await recordTombstone(c.env.DB, owner, "watched", key, now);
          await recordTombstone(c.env.DB, owner, "progress", key, now);
          await deleteNuvioWatchedFor(c.env.DB, fetch, owner, key);
          await deleteNuvioProgressFor(c.env.DB, fetch, owner, key);
        })(),
      );
    }
    if (typeof body.PlaybackPositionTicks === "number" && Number.isFinite(body.PlaybackPositionTicks) && body.PlaybackPositionTicks >= 0) {
      const ticks = Math.floor(body.PlaybackPositionTicks);
      await writeWatchPosition(c.env.DB, owner, key, ticks, now);
      pushProgressToNuvioRpc(c, owner, key, ticks, now, true);
    }
    const entry = await readWatchEntry(c.env.DB, owner, key);
    return c.json({
      Key: itemId,
      ItemId: itemId,
      Played: (entry?.played ?? 0) === 1,
      PlaybackPositionTicks: entry?.positionTicks ?? 0,
      PlayCount: entry?.playCount ?? 0,
      IsFavorite: false,
    });
  }

  app.post("/UserItems/:itemId/UserData", (c) => userDataState(c));
  app.post("/Users/:userId/Items/:itemId/UserData", (c) => userDataState(c, c.req.param("userId")));

  app.post("/Users/:userId/FavoriteItems/:itemId", (c) => favoriteState(c, true, c.req.param("userId")));
  app.delete("/Users/:userId/FavoriteItems/:itemId", (c) => favoriteState(c, false, c.req.param("userId")));
  app.post("/UserFavoriteItems/:itemId", (c) => favoriteState(c, true));
  app.delete("/UserFavoriteItems/:itemId", (c) => favoriteState(c, false));

  async function hiddenState(c: Context<{ Bindings: Env }>, hidden: boolean, scopedUserId?: string) {
    const target = await scopedTarget(c, scopedUserId);
    if (target instanceof Response) return target;
    const { owner, key, now } = target;
    if (!hidden) {
      await unhideItem(c.env.DB, owner, key);
      return c.json({});
    }
    await hideItem(c.env.DB, owner, key, now);
    await setPlayed(c.env.DB, owner, key, false, now);
    await clearWatchPosition(c.env.DB, owner, key, now);
    background(c, logApp(c.env.DB, { at: now, level: "info", category: "playstate", kind: "hide", profileId: owner, message: key, url: "" }));
    background(
      c,
      (async () => {
        await recordTombstone(c.env.DB, owner, "progress", key, now);
        await deleteNuvioProgressFor(c.env.DB, fetch, owner, key);
      })(),
    );
    return c.json({});
  }

  app.post("/Users/:userId/ExcludeContinueWatching/:itemId", (c) => hiddenState(c, true, c.req.param("userId")));
  app.delete("/Users/:userId/ExcludeContinueWatching/:itemId", (c) => hiddenState(c, false, c.req.param("userId")));
  app.post("/Users/:userId/UserHiddenItems/:itemId", (c) => hiddenState(c, true, c.req.param("userId")));
  app.delete("/Users/:userId/UserHiddenItems/:itemId", (c) => hiddenState(c, false, c.req.param("userId")));
  app.post("/UserHiddenItems/:itemId", (c) => hiddenState(c, true));
  app.delete("/UserHiddenItems/:itemId", (c) => hiddenState(c, false));

  function ratingResponse(c: Context, itemId: string, likes: boolean | null) {
    return c.json({ ItemId: itemId, Likes: likes, IsFavorite: false });
  }

  function ratingQuery(c: Context<{ Bindings: Env }>) {
    const itemId = c.req.param("itemId") ?? "";
    return ratingResponse(c, itemId, boolQuery(c, "Likes"));
  }

  app.post("/Users/:userId/Items/:itemId/Rating", ratingQuery);
  app.delete("/Users/:userId/Items/:itemId/Rating", (c) => ratingResponse(c, c.req.param("itemId") ?? "", null));
  app.post("/Users/:userId/Items/:itemId/Rating/Like", (c) => ratingResponse(c, c.req.param("itemId") ?? "", true));
  app.post("/Users/:userId/Items/:itemId/Rating/Dislike", (c) => ratingResponse(c, c.req.param("itemId") ?? "", false));
  app.delete("/Users/:userId/Items/:itemId/Rating/Like", (c) => ratingResponse(c, c.req.param("itemId") ?? "", null));
  app.delete("/Users/:userId/Items/:itemId/Rating/Dislike", (c) => ratingResponse(c, c.req.param("itemId") ?? "", null));
  app.post("/UserItems/:itemId/Rating", ratingQuery);
  app.delete("/UserItems/:itemId/Rating", (c) => ratingResponse(c, c.req.param("itemId") ?? "", null));
  app.post("/UserItems/:itemId/Rating/Like", (c) => ratingResponse(c, c.req.param("itemId") ?? "", true));
  app.post("/UserItems/:itemId/Rating/Dislike", (c) => ratingResponse(c, c.req.param("itemId") ?? "", false));

}
