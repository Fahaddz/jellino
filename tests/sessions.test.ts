import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem, encodeSeason } from "../src/ids";
import { saveNuvioAccount } from "../src/nuvio";
import { MAX_RESUME_PCT, itemKey, readWatchPosition } from "../src/watch-state";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 });
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

function post(path: string, token: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["X-Emby-Authorization"] = `MediaBrowser Client="test", Token="${token}"`;
  return { path, init: { method: "POST", headers, body: JSON.stringify(body) } };
}

describe("item keys", () => {
  it("keys movies, series, and episodes by stremio identity", () => {
    expect(itemKey(encodeItem(ALPHA, "movie", "tt100"))).toBe("movie:tt100");
    expect(itemKey(encodeItem(ALPHA, "series", "tt200"))).toBe("series:tt200");
    expect(itemKey(encodeEpisode(ALPHA, "tt200", 1, 2))).toBe("episode:tt200:1:2");
    expect(itemKey(encodeSeason(ALPHA, "tt200", 1))).toBeNull();
    expect(itemKey("nope")).toBeNull();
    expect(MAX_RESUME_PCT).toBe(90);
  });
});

describe("session reporting", () => {
  it("records start and persists every progress report and stop", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const started = post("/Sessions/Playing", token, { ItemId: id });
    expect((await callApp(app, env, started.path, started.init)).status).toBe(200);
    const key = "movie:tt100";
    expect(raw.watch.get(`${adminId}\n${key}`)?.playCount).toBe(1);

    // No throttle: even a 1s report survives (old code dropped sub-minute deltas).
    const tiny = post("/Sessions/Playing/Progress", token, { ItemId: id, PositionTicks: 1000 });
    expect((await callApp(app, env, tiny.path, tiny.init)).status).toBe(200);
    expect(await readWatchPosition(db, adminId, key)).toBe(1000);

    const moved = post("/Sessions/Playing/Progress", token, { ItemId: id, PositionTicks: 600000005 });
    expect((await callApp(app, env, moved.path, moved.init)).status).toBe(200);
    expect(await readWatchPosition(db, adminId, key)).toBe(600000005);

    const stopped = post("/Sessions/Playing/Stopped", token, { ItemId: id, PositionTicks: 999 });
    expect((await callApp(app, env, stopped.path, stopped.init)).status).toBe(200);
    expect(await readWatchPosition(db, adminId, key)).toBe(999);
  });

  it("preserves saved progress when a stop report carries no PositionTicks", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const key = "movie:tt100";

    const started = post("/Sessions/Playing", token, { ItemId: id, PositionTicks: 0 });
    expect((await callApp(app, env, started.path, started.init)).status).toBe(200);

    const progress = post("/Sessions/Playing/Progress", token, { ItemId: id, PositionTicks: 500000000 });
    expect((await callApp(app, env, progress.path, progress.init)).status).toBe(200);
    expect(await readWatchPosition(db, adminId, key)).toBe(500000000);

    const positionlessStop = post("/Sessions/Playing/Stopped", token, { ItemId: id });
    expect((await callApp(app, env, positionlessStop.path, positionlessStop.init)).status).toBe(200);
    expect(await readWatchPosition(db, adminId, key)).toBe(500000000);
  });

  it("rejects anonymous callers and unknown items", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const anon = post("/Sessions/Playing", null, { ItemId: id });
    expect((await callApp(app, env, anon.path, anon.init)).status).toBe(401);

    const bad = post("/Sessions/Playing/Progress", token, { ItemId: "nope" });
    expect((await callApp(app, env, bad.path, bad.init)).status).toBe(404);

    const missing = post("/Sessions/Playing/Stopped", token, {});
    expect((await callApp(app, env, missing.path, missing.init)).status).toBe(404);
    expect(authHeader(token)["X-Emby-Authorization"]).toContain(token);
  });

  it("keeps watch state per profile", async () => {
    const { raw, db, adminId } = await household();
    raw.profiles.push(
      { id: "kid", name: "kid", password_hash: "x", salt: "y", is_admin: 0, addon_mode: "inherit", disabled: 0, created_at: 2000 },
    );
    const app = createApp();
    const env = testEnv(raw);
    const kidToken = await liveToken(db, "kid");
    const dadToken = await liveToken(db, adminId);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const kidStop = post("/Sessions/Playing/Stopped", kidToken, { ItemId: id, PositionTicks: 111 });
    expect((await callApp(app, env, kidStop.path, kidStop.init)).status).toBe(200);
    expect(await readWatchPosition(db, "kid", "movie:tt100")).toBe(111);
    expect(await readWatchPosition(db, adminId, "movie:tt100")).toBeNull();

    const dadStop = post("/Sessions/Playing/Stopped", dadToken, { ItemId: id, PositionTicks: 222 });
    expect((await callApp(app, env, dadStop.path, dadStop.init)).status).toBe(200);
    expect(await readWatchPosition(db, adminId, "movie:tt100")).toBe(222);
    expect(await readWatchPosition(db, "kid", "movie:tt100")).toBe(111);
  });
});

describe("play state", () => {
  it("marks played and unplayed while resetting the resume position", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const headers = authHeader(token);

    const stop = post("/Sessions/Playing/Stopped", token, { ItemId: id, PositionTicks: 500 });
    expect((await callApp(app, env, stop.path, stop.init)).status).toBe(200);

    const played = await callApp(app, env, `/Users/${adminId}/PlayedItems/${id}`, { method: "POST", headers });
    expect(played.status).toBe(200);
    const playedBody = (await played.json()) as { Played: boolean; PlayCount: number; PlaybackPositionTicks: number };
    expect(playedBody.Played).toBe(true);
    expect(playedBody.PlaybackPositionTicks).toBe(0);
    expect(await readWatchPosition(db, adminId, "movie:tt100")).toBe(0);

    const unplayed = await callApp(app, env, `/Users/${adminId}/PlayedItems/${id}`, { method: "DELETE", headers });
    expect(unplayed.status).toBe(200);
    expect(((await unplayed.json()) as { Played: boolean }).Played).toBe(false);
    expect(await readWatchPosition(db, adminId, "movie:tt100")).toBe(0);
  });

  it("rejects foreign users and unknown items", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const foreign = await callApp(app, env, `/Users/someone-else/PlayedItems/${id}`, {
      method: "POST",
      headers: authHeader(token),
    });
    expect(foreign.status).toBe(401);

    const bad = await callApp(app, env, `/Users/${adminId}/PlayedItems/nope`, {
      method: "POST",
      headers: authHeader(token),
    });
    expect(bad.status).toBe(404);
  });

  it("supports the legacy UserPlayedItems and UserFavoriteItems routes Moonfin calls", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const headers = authHeader(token);

    const played = await callApp(app, env, `/UserPlayedItems/${id}`, { method: "POST", headers });
    expect(played.status).toBe(200);
    expect(((await played.json()) as { Played: boolean }).Played).toBe(true);
    expect(raw.watch.get(`${adminId}\nmovie:tt100`)?.played).toBe(1);

    const unplayed = await callApp(app, env, `/UserPlayedItems/${id}`, { method: "DELETE", headers });
    expect(unplayed.status).toBe(200);
    expect(((await unplayed.json()) as { Played: boolean }).Played).toBe(false);

    const favorite = await callApp(app, env, `/UserFavoriteItems/${id}`, { method: "POST", headers });
    expect(favorite.status).toBe(200);
    expect(((await favorite.json()) as { IsFavorite: boolean }).IsFavorite).toBe(true);
    const unfavorite = await callApp(app, env, `/UserFavoriteItems/${id}`, { method: "DELETE", headers });
    expect(unfavorite.status).toBe(200);
    expect(((await unfavorite.json()) as { IsFavorite: boolean }).IsFavorite).toBe(false);
  });

  it("checks a userId query against the token on legacy routes", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const headers = authHeader(token);

    const own = await callApp(app, env, `/UserPlayedItems/${id}?userId=${adminId}`, { method: "POST", headers });
    expect(own.status).toBe(200);
    const foreign = await callApp(app, env, `/UserPlayedItems/${id}?userId=someone-else`, { method: "POST", headers });
    expect(foreign.status).toBe(401);
  });

  it("pushes a watched entry to nuvio when marked watched", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const calls: { url: string; body: string }[] = [];
    const realCaches = (globalThis as unknown as Record<string, unknown>).caches;
    (globalThis as unknown as Record<string, unknown>).caches = {
      default: {
        match: async () => undefined,
        put: async () => {},
        delete: async () => {},
      },
    };
    const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, body: String(init?.body ?? "") });
      if (url.includes("/rpc/sync_push_watched_items")) return new Response("{}", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    await saveNuvioAccount(db, {
      email: "a@b.c",
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });
    await db.prepare("UPDATE profiles SET nuvio_profile_id = ?, nuvio_profile_index = ? WHERE id = ?").bind("np-1", 2, adminId).run();

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (task: Promise<unknown>) => {
        pending.push(task);
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request(`http://localhost/UserPlayedItems/${id}`, { method: "POST", headers: authHeader(token) }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);
    (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
    (globalThis as unknown as Record<string, unknown>).caches = realCaches;
    (globalThis as unknown as Record<string, unknown>).caches = realCaches;

    const push = calls.find((call) => call.url.includes("/rpc/sync_push_watched_items"));
    expect(push).toBeDefined();
    const body = JSON.parse(push?.body ?? "{}") as { p_profile_id: number; p_items: Record<string, unknown>[] };
    expect(body.p_profile_id).toBe(2);
    expect(body.p_items[0]).toMatchObject({ content_id: "tt100", content_type: "movie" });
  });
  it("marks all episodes played or unplayed when given a season item id", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const seasonId = encodeSeason(ALPHA, "tt200", 1);
    const headers = authHeader(token);

    const realCaches = (globalThis as unknown as Record<string, unknown>).caches;
    const store = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).caches = {
      default: {
        match: async (key: Request) => {
          const body = store.get(key.url);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (key: Request, value: Response) => {
          store.set(key.url, await value.clone().text());
        },
        delete: async (key: Request) => store.delete(key.url),
      },
    };
    const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/manifest.json")) {
        return new Response(JSON.stringify({ id: "alpha", version: "1.0.0", name: "Alpha", resources: ["meta"], types: ["movie", "series"], catalogs: [] }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/meta/series/tt200.json")) {
        return new Response(JSON.stringify({
          meta: {
            id: "tt200",
            type: "series",
            name: "Test Show",
            videos: [
              { season: 1, episode: 1, title: "S1E1" },
              { season: 1, episode: 2, title: "S1E2" },
            ]
          }
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const res = await callApp(app, env, `/Users/${adminId}/PlayedItems/${seasonId}`, { method: "POST", headers });
    expect(res.status).toBe(200);
    const ep1 = raw.watch.get(`${adminId}\nepisode:tt200:1:1`);
    const ep2 = raw.watch.get(`${adminId}\nepisode:tt200:1:2`);
    expect(ep1?.played).toBe(1);
    expect(ep2?.played).toBe(1);

    const unplay = await callApp(app, env, `/Users/${adminId}/PlayedItems/${seasonId}`, { method: "DELETE", headers });
    expect(unplay.status).toBe(200);
    expect(raw.watch.get(`${adminId}\nepisode:tt200:1:1`)?.played).toBe(0);
    expect(raw.watch.get(`${adminId}\nepisode:tt200:1:2`)?.played).toBe(0);

    (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
  });

  it("handles rating and refresh endpoints cleanly", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const headers = authHeader(token);

    const like = await callApp(app, env, `/Users/${adminId}/Items/${id}/Rating/Like`, { method: "POST", headers });
    expect(like.status).toBe(200);
    expect(((await like.json()) as { Likes: boolean }).Likes).toBe(true);

    const dislike = await callApp(app, env, `/Users/${adminId}/Items/${id}/Rating/Dislike`, { method: "POST", headers });
    expect(dislike.status).toBe(200);
    expect(((await dislike.json()) as { Likes: boolean }).Likes).toBe(false);

    const clearRating = await callApp(app, env, `/Users/${adminId}/Items/${id}/Rating`, { method: "DELETE", headers });
    expect(clearRating.status).toBe(200);
    expect(((await clearRating.json()) as { Likes: null }).Likes).toBeNull();

    const refresh = await callApp(app, env, `/Items/${id}/Refresh`, { method: "POST", headers });
    expect(refresh.status).toBe(204);
  });
});
