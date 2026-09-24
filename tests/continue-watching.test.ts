import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem } from "../src/ids";
import { parseItemKey } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";
const TMDB = "https://api.themoviedb.org/3";

function installNet(opts: { tmdbKey?: boolean; addonDown?: boolean; runtime?: boolean } = {}) {
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
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ALPHA}/meta/movie/tt100.json` && !opts.addonDown) {
      return new Response(
        JSON.stringify({ meta: { id: "tt100", type: "movie", name: "Film", ...(opts.runtime ? { runtime: "100 min" } : {}) } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${ALPHA}/meta/series/tt200.json` && !opts.addonDown) {
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt200",
            type: "series",
            name: "Show",
            videos: [
              { season: 1, episode: 1, title: "Pilot" },
              { season: 1, episode: 2, title: "Second" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith(TMDB)) {
      const path = url.slice(TMDB.length).split("?")[0] ?? "";
      const m = /^\/movie\/(\d+)$/.exec(path);
      if (m?.[1]) {
        const id = m[1];
        return new Response(
          JSON.stringify({ id: Number(id), imdb_id: `tt${id}`, title: `TMDB Film ${id}`, runtime: 100, poster_path: `/p${id}.jpg` }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const tv = /^\/tv\/(\d+)$/.exec(path);
      if (tv?.[1]) {
        const id = tv[1];
        return new Response(
          JSON.stringify({ id: Number(id), name: `TMDB Show ${id}`, poster_path: `/p${id}.jpg`, seasons: [{ season_number: 1, poster_path: `/s1.jpg` }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const season = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(path);
      if (season) {
        return new Response(
          JSON.stringify({ poster_path: "/s1.jpg", episodes: [{ episode_number: 1, name: "Pilot" }, { episode_number: 2, name: "Second" }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const find = path.startsWith("/find/tt");
      if (find) {
        return new Response(JSON.stringify({ movie_results: [{ id: 555 }], tv_results: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 404 });
    }
    return new Response("down", { status: 500 });
  };
}

const realCaches = (globalThis as unknown as Record<string, unknown>).caches;
const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).caches;
  delete (globalThis as unknown as Record<string, unknown>).fetch;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).caches = realCaches;
  (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
});

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

describe("parseItemKey with colon ids", () => {
  it("parses tmdb and tvdb stremio ids", () => {
    expect(parseItemKey("movie:tmdb:123")).toMatchObject({ kind: "movie", stremioId: "tmdb:123" });
    expect(parseItemKey("series:tmdb:123")).toMatchObject({ kind: "series", stremioId: "tmdb:123" });
    expect(parseItemKey("episode:tmdb:123:1:2")).toMatchObject({ kind: "episode", stremioId: "tmdb:123", season: 1, episode: 2 });
    expect(parseItemKey("movie:tvdb:456")).toMatchObject({ kind: "movie", stremioId: "tvdb:456" });
    expect(parseItemKey("episode:tvdb:456:2:3")).toMatchObject({ kind: "episode", stremioId: "tvdb:456", season: 2, episode: 3 });
    expect(parseItemKey("movie:tt100")).toMatchObject({ kind: "movie", stremioId: "tt100" });
    expect(parseItemKey("episode:tt200:1:2")).toMatchObject({ kind: "episode", stremioId: "tt200", season: 1, episode: 2 });
  });

  it("rejects malformed keys", () => {
    expect(parseItemKey("movie:")).toBeNull();
    expect(parseItemKey("episode:tt200:1")).toBeNull();
    expect(parseItemKey("episode:tmdb:123:1")).toBeNull();
    expect(parseItemKey("season:x")).toBeNull();
    expect(parseItemKey("nope")).toBeNull();
    expect(parseItemKey("movie:tt100:1:2")).toBeNull();
  });
});

describe("continue watching home vs detail", () => {
  it("movie watched 10min appears in Resume with matching Total", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem("https://cine.example", "movie", "tt100");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movie, PositionTicks: 6000000000 }),
    });
    const detail = await callApp(app, env, `/Users/${adminId}/Items/${movie}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { UserData: { PlaybackPositionTicks: number } };
    expect(detailBody.UserData.PlaybackPositionTicks).toBe(6000000000);
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(resume.status).toBe(200);
    const body = (await resume.json()) as { Items: unknown[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items).toHaveLength(1);
  });

  it("keeps a brief watch in Resume the way Nuvio does", async () => {
    installNet({ runtime: true });
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem("https://cine.example", "movie", "tt100");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movie, PositionTicks: 20_000_000 }),
    });
    expect(raw.watch.get(`${adminId}\nmovie:tt100`)?.positionTicks).toBe(20_000_000);
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(resume.status).toBe(200);
    const body = (await resume.json()) as { Items: { UserData: { PlaybackPositionTicks: number } }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items[0]?.UserData.PlaybackPositionTicks).toBe(20_000_000);
  });

  it("returns fallback DTO instead of empty when meta unresolvable", async () => {
    installNet({ addonDown: true });
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movie, PositionTicks: 500 }),
    });
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(resume.status).toBe(200);
    const body = (await resume.json()) as { Items: { Id: string; UserData: { Key: string } }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items).toHaveLength(1);
    expect(body.Items[0]?.UserData.Key).toBe(body.Items[0]?.Id);
  });

  it("excludes series rows from Resume", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(ALPHA, "series", "tt200");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: series, PositionTicks: 500 }),
    });
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    const body = (await resume.json()) as { TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(0);
  });

  it("honors MediaTypes=Audio with empty and Video with items", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movie, PositionTicks: 500 }),
    });
    const audio = await callApp(app, env, `/Users/${adminId}/Items/Resume?MediaTypes=Audio`, { headers: authHeader(token) });
    expect(((await audio.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(0);
    const video = await callApp(app, env, `/Users/${adminId}/Items/Resume?MediaTypes=Video`, { headers: authHeader(token) });
    expect(((await video.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(1);
  });

  it("NextUp UserData carries Key and ItemId", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const episode = encodeEpisode(ALPHA, "tt200", 1, 1);
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: episode, PositionTicks: 600 }),
    });
    const next = await callApp(app, env, `/Shows/NextUp?userId=${adminId}`, { headers: authHeader(token) });
    const body = (await next.json()) as { Items: { Id: string; UserData: { Key: string; ItemId: string } }[] };
    expect(body.Items.length).toBeGreaterThan(0);
    expect(body.Items[0]?.UserData.Key).toBe(body.Items[0]?.Id);
    expect(body.Items[0]?.UserData.ItemId).toBe(body.Items[0]?.Id);
  });

  it("marking played removes the item from Resume immediately", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movie, PositionTicks: 6000000000 }),
    });
    const before = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(((await before.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(1);

    const played = await callApp(app, env, `/Users/${adminId}/PlayedItems/${movie}`, {
      method: "POST",
      headers: authHeader(token),
    });
    expect(played.status).toBe(200);

    const after = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(((await after.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(0);
  });

  it("generic Items Filters=IsResumable mirrors Resume", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movie, PositionTicks: 500 }),
    });
    const res = await callApp(app, env, `/Users/${adminId}/Items?Filters=IsResumable&Recursive=true`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
  });
  it("Odin Ids query resolves actual series title instead of raw stremioId", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(ALPHA, "series", "tt200");

    const res = await callApp(app, env, `/Users/${adminId}/Items?Ids=${series}`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Id: string; Name: string; Type: string; IsFolder: boolean }[] };
    expect(body.Items).toHaveLength(1);
    expect(body.Items[0]?.Id).toBe(series);
    expect(body.Items[0]?.Name).toBe("Show");
    expect(body.Items[0]?.Type).toBe("Series");
    expect(body.Items[0]?.IsFolder).toBe(true);
  });

  it("Unified Continue Watching: series with finished episode and no active progress shows next up episode in Resume", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const episode1 = encodeEpisode(ALPHA, "tt200", 1, 1);

    await callApp(app, env, `/Users/${adminId}/PlayedItems/${episode1}`, {
      method: "POST",
      headers: authHeader(token),
    });

    const res = await callApp(app, env, `/Users/${adminId}/Items/Resume`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string; IndexNumber: number; UserData: { Played: boolean; PlaybackPositionTicks: number; LastPlayedDate?: string } }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items[0]?.Name).toBe("Second");
    expect(body.Items[0]?.IndexNumber).toBe(2);
    expect(body.Items[0]?.UserData.Played).toBe(false);
    expect(body.Items[0]?.UserData.PlaybackPositionTicks).toBe(0);
    expect(body.Items[0]?.UserData.LastPlayedDate).toBeDefined();
  });

  it("Moonfin Next Up sorting: unplayed Next Up episode has LastPlayedDate set to series lastActivity", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const episode1 = encodeEpisode(ALPHA, "tt200", 1, 1);

    await callApp(app, env, `/Users/${adminId}/PlayedItems/${episode1}`, {
      method: "POST",
      headers: authHeader(token),
    });

    const res = await callApp(app, env, `/Shows/NextUp?userId=${adminId}`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string; UserData: { LastPlayedDate?: string } }[] };
    expect(body.Items.length).toBeGreaterThan(0);
    expect(body.Items[0]?.Name).toBe("Second");
    expect(body.Items[0]?.UserData.LastPlayedDate).toBeDefined();
    expect(new Date(body.Items[0]!.UserData.LastPlayedDate!).getTime()).toBeGreaterThan(0);
  });
});
