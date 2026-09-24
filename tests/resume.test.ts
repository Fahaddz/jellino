import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem, encodeSeason } from "../src/ids";
import { parseItemKey } from "../src/resume";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";

function installNet() {
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
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ALPHA}/meta/movie/tt100.json`) {
      return new Response(JSON.stringify({ meta: { id: "tt100", type: "movie", name: "Film" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `${ALPHA}/meta/series/tt200.json`) {
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt200",
            type: "series",
            name: "Show",
            videos: [
              { season: 1, episode: 1, title: "Pilot" },
              { season: 1, episode: 2, title: "Second" },
              { season: 1, episode: 3, title: "Third" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
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

function stopped(token: string, itemId: string, ticks: number) {
  return {
    path: "/Sessions/Playing/Stopped",
    init: {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: itemId, PositionTicks: ticks }),
    },
  };
}

describe("item key parsing", () => {
  it("parses movie, series, and episode keys and rejects the rest", () => {
    expect(parseItemKey("movie:tt100")).toMatchObject({ kind: "movie", stremioId: "tt100" });
    expect(parseItemKey("series:tt200")).toMatchObject({ kind: "series", stremioId: "tt200" });
    expect(parseItemKey("episode:tt200:1:2")).toMatchObject({ kind: "episode", season: 1, episode: 2 });
    expect(parseItemKey("episode:tt200:1")).toBeNull();
    expect(parseItemKey("season:x")).toBeNull();
    expect(parseItemKey("nope")).toBeNull();
  });
});

describe("resume and next up", () => {
  it("returns in-progress items as DTOs and skips finished ones", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    const episode = encodeEpisode(ALPHA, "tt200", 1, 1);

    const first = stopped(token, movie, 500);
    await callApp(app, env, first.path, first.init);
    const second = stopped(token, episode, 600);
    await callApp(app, env, second.path, second.init);
    await callApp(app, env, `/Users/${adminId}/PlayedItems/${movie}`, { method: "POST", headers: authHeader(token) });

    const res = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items[0]?.Name).toBe("Pilot");

    const legacy = await callApp(app, env, `/UserItems/Resume?userId=${adminId}`, { headers: authHeader(token) });
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(1);

    const next = await callApp(app, env, `/Shows/NextUp?userId=${adminId}`, { headers: authHeader(token) });
    expect(next.status).toBe(200);
    const nextBody = (await next.json()) as { Items: { Name: string; IndexNumber: number }[] };
    // Remux default (EnableResumable): the in-progress episode itself.
    expect(nextBody.Items).toHaveLength(1);
    expect(nextBody.Items[0]?.IndexNumber).toBe(1);

    const strict = await callApp(app, env, `/Shows/NextUp?userId=${adminId}&EnableResumable=false`, {
      headers: authHeader(token),
    });
    expect(strict.status).toBe(200);
    // Nothing fully watched and the only candidate is in progress — remux
    // hides it here (it lives in Continue Watching instead).
    expect(((await strict.json()) as { Items: unknown[] }).Items).toHaveLength(0);

    const anon = await callApp(app, env, `/Users/${adminId}/Items/Resume`);
    expect(anon.status).toBe(401);
  });

  it("carries the item key strict clients require inside UserData", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    const stop = stopped(token, movie, 500);
    await callApp(app, env, stop.path, stop.init);

    const res = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      Items: { Id: string; UserData: { Key: string; ItemId: string; Played: boolean; PlaybackPositionTicks: number } }[];
    };
    expect(body.Items).toHaveLength(1);
    expect(body.Items[0]?.UserData).toMatchObject({ Key: movie, ItemId: movie, Played: false, PlaybackPositionTicks: 500 });
  });

  it("serves continue watching to generic Items queries with Filters=IsResumable", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    const stop = stopped(token, movie, 500);
    await callApp(app, env, stop.path, stop.init);

    const res = await callApp(app, env, `/Users/${adminId}/Items?Filters=IsResumable&Recursive=true&IncludeItemTypes=Movie`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Id: string }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items[0]?.Id).toBe(movie);
  });


  it("returns empty rows for fresh profiles", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const res = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(0);
  });

  it("filters resume rows by requested item types", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    const episode = encodeEpisode(ALPHA, "tt200", 1, 1);

    const first = stopped(token, movie, 500);
    await callApp(app, env, first.path, first.init);
    const second = stopped(token, episode, 600);
    await callApp(app, env, second.path, second.init);

    const movies = (await (
      await callApp(app, env, `/UserItems/Resume?userId=${adminId}&IncludeItemTypes=Movie`, { headers: authHeader(token) })
    ).json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(movies.TotalRecordCount).toBe(1);
    expect(movies.Items[0]?.Name).toBe("Film");

    const episodes = (await (
      await callApp(app, env, `/Users/${adminId}/Items/Resume?IncludeItemTypes=Episode`, { headers: authHeader(token) })
    ).json()) as { TotalRecordCount: number };
    expect(episodes.TotalRecordCount).toBe(1);

    const series = (await (
      await callApp(app, env, `/Users/${adminId}/Items/Resume?IncludeItemTypes=Series`, { headers: authHeader(token) })
    ).json()) as { TotalRecordCount: number };
    expect(series.TotalRecordCount).toBe(0);
  });

  it("keeps continue watching fully separate between two profiles on the same title", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    raw.profiles.push(
      { id: "kid", name: "kid", password_hash: "x", salt: "y", is_admin: 0, addon_mode: "inherit", disabled: 0, created_at: 2000 },
    );
    const dadToken = await liveToken(db, adminId);
    const kidToken = await liveToken(db, "kid");
    const app = createApp();
    const env = testEnv(raw);
    const episode = encodeEpisode(ALPHA, "tt200", 1, 1);

    const dadStop = stopped(dadToken, episode, 600);
    await callApp(app, env, dadStop.path, dadStop.init);
    const kidStop = stopped(kidToken, episode, 1200);
    await callApp(app, env, kidStop.path, kidStop.init);

    const dadResume = (await (
      await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(dadToken) })
    ).json()) as { Items: { UserData: { PlaybackPositionTicks: number } }[]; TotalRecordCount: number };
    const kidResume = (await (
      await callApp(app, env, "/Users/kid/Items/Resume", { headers: authHeader(kidToken) })
    ).json()) as { Items: { UserData: { PlaybackPositionTicks: number } }[]; TotalRecordCount: number };
    expect(dadResume.TotalRecordCount).toBe(1);
    expect(kidResume.TotalRecordCount).toBe(1);
    expect(dadResume.Items[0]?.UserData.PlaybackPositionTicks).toBe(600);
    expect(kidResume.Items[0]?.UserData.PlaybackPositionTicks).toBe(1200);

    const dadNext = (await (
      await callApp(app, env, `/Shows/NextUp?userId=${adminId}`, { headers: authHeader(dadToken) })
    ).json()) as { Items: unknown[] };
    const kidNext = (await (
      await callApp(app, env, "/Shows/NextUp?userId=kid", { headers: authHeader(kidToken) })
    ).json()) as { Items: unknown[] };
    expect(dadNext.Items).toHaveLength(1);
    expect(kidNext.Items).toHaveLength(1);

    await callApp(app, env, `/Users/${adminId}/PlayedItems/${episode}`, { method: "POST", headers: authHeader(dadToken) });
    const dadAfter = (await (
      await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(dadToken) })
    ).json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    const kidAfter = (await (
      await callApp(app, env, "/Users/kid/Items/Resume", { headers: authHeader(kidToken) })
    ).json()) as { Items: { Name: string; UserData: { PlaybackPositionTicks: number } }[]; TotalRecordCount: number };
    expect(dadAfter.TotalRecordCount).toBe(1);
    expect(dadAfter.Items[0]?.Name).toBe("Second");
    expect(kidAfter.TotalRecordCount).toBe(1);
    expect(kidAfter.Items[0]?.Name).toBe("Pilot");
    expect(kidAfter.Items[0]?.UserData.PlaybackPositionTicks).toBe(1200);
  });
});

describe("resume naming fallbacks", () => {
  function installSeriesNet(name: string, videos: unknown[] | undefined) {
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
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      const meta = url.match(new RegExp(`^${ALPHA}/meta/series/(tt\\d+)\\.json$`));
      if (meta) {
        return Response.json({ meta: { id: meta[1], type: "series", name, ...(videos ? { videos } : {}) } });
      }
      return new Response("down", { status: 500 });
    };
  }

  it("names episodes whose addon meta reports number instead of episode", async () => {
    installSeriesNet("Number Show", [{ season: 1, number: 1, title: "Numbered Pilot" }]);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const stop = stopped(token, encodeEpisode(ALPHA, "tt400", 1, 1), 600);
    await callApp(app, env, stop.path, stop.init);

    const res = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      Items: { Name: string; SeriesName: string; UserData: { LastPlayedDate?: string } }[];
    };
    expect(body.Items[0]?.Name).toBe("Numbered Pilot");
    expect(body.Items[0]?.SeriesName).toBe("Number Show");
    expect(typeof body.Items[0]?.UserData.LastPlayedDate).toBe("string");
  });

  it("uses the resolved series name when the episode is missing from meta", async () => {
    installSeriesNet("Only Show", undefined);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const stop = stopped(token, encodeEpisode(ALPHA, "tt500", 3, 7), 600);
    await callApp(app, env, stop.path, stop.init);

    const res = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string; SeriesName: string }[] };
    expect(body.Items[0]?.Name).toBe("Episode 7");
    expect(body.Items[0]?.SeriesName).toBe("Only Show");
  });
});
