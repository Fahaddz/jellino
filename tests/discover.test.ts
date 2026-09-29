import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeItem, encodeView } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";

const calls: string[] = [];

function installNet() {
  const store = new Map<string, Response>();
  (globalThis as unknown as Record<string, unknown>).caches = {
    default: {
      match: async (key: Request) => {
        const found = store.get(key.url);
        return found ? found.clone() : undefined;
      },
      put: async (key: Request, value: Response) => {
        store.set(key.url, value.clone());
      },
      delete: async (key: Request) => store.delete(key.url),
    },
  };
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === `${CINE}/manifest.json`) {
      return Response.json({
        catalogs: [
          { type: "movie", id: "top", name: "Top", extra: [{ name: "genre", options: ["Action", "Comedy"] }] },
          { type: "series", id: "top", name: "Top", extra: [{ name: "genre", options: ["Drama"] }] },
        ],
      });
    }
    if (url.startsWith(`${CINE}/catalog/movie/top`)) {
      const genreMatch = /genre=([^&./]+)/.exec(url);
      const wanted = genreMatch?.[1] ? decodeURIComponent(genreMatch[1]) : null;
      const all = [
        { id: "tt1", type: "movie", name: "Alpha", genres: ["Action"], releaseInfo: "2020", imdbRating: "7.5", runtime: "100" },
        { id: "tt2", type: "movie", name: "Bravo", genres: ["Comedy"], releaseInfo: "2024", imdbRating: "6.1", runtime: "90" },
        { id: "tt3", type: "movie", name: "Charlie", genres: ["Action", "Comedy"], releaseInfo: "2024", imdbRating: "8.2", runtime: "120" },
      ];
      return Response.json({ metas: wanted ? all.filter((meta) => meta.genres.includes(wanted)) : all });
    }
    if (url === `${CINE}/catalog/series/top.json`) {
      return Response.json({
        metas: [{ id: "tt9", type: "series", name: "Delta", genres: ["Drama"], releaseInfo: "2023" }],
      });
    }
    return new Response("down", { status: 500 });
  };
}

const realCaches = (globalThis as unknown as Record<string, unknown>).caches;
const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;

beforeEach(() => {
  calls.length = 0;
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
  raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
  return { raw, db, adminId: admin.id };
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

describe("discover endpoints", () => {
  it("answers Items by Ids with per-profile user data", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const played = encodeItem(CINE, "movie", "tt1");
    const other = encodeItem(CINE, "movie", "tt2");
    await callApp(app, env, `/UserPlayedItems/${played}`, { method: "POST", headers: authHeader(token) });

    const res = await callApp(app, env, `/Items?Ids=${played},${other}&Fields=UserData`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Id: string; Type: string; UserData: { Played: boolean } }[] };
    expect(body.Items.map((item) => item.Id)).toEqual([played, other]);
    expect(body.Items[0]?.Type).toBe("Movie");
    expect(body.Items[0]?.UserData.Played).toBe(true);
    expect(body.Items[1]?.UserData.Played).toBe(false);
  });

  it("filters library items by genre and year", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "movie", "top");

    const action = await callApp(app, env, `/Items?ParentId=${view}&GenreIds=Action&Recursive=true`, { headers: authHeader(token) });
    const actionBody = (await action.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(actionBody.TotalRecordCount).toBe(2);
    expect(actionBody.Items.map((item) => item.Name)).toEqual(["Alpha", "Charlie"]);
    expect(calls.some((url) => url.includes("/catalog/movie/top/genre=Action"))).toBe(true);

    const recent = await callApp(app, env, `/Items?ParentId=${view}&Years=2024&Recursive=true`, { headers: authHeader(token) });
    const recentBody = (await recent.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(recentBody.TotalRecordCount).toBe(2);
    expect(recentBody.Items.map((item) => item.Name)).toEqual(["Bravo", "Charlie"]);

    const filtered = await callApp(app, env, `/Items?ParentId=${view}&Genres=Action|Comedy&Years=2020&Recursive=true`, {
      headers: authHeader(token),
    });
    const filteredBody = (await filtered.json()) as { TotalRecordCount: number };
    expect(filteredBody.TotalRecordCount).toBe(1);
  });

  it("sorts library items the client asks for", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "movie", "top");

    const res = await callApp(app, env, `/Items?ParentId=${view}&SortBy=SortName&SortOrder=Descending`, { headers: authHeader(token) });
    const body = (await res.json()) as { Items: { Name: string }[] };
    expect(body.Items.map((item) => item.Name)).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("serves genres, studios, filters, counts, and root", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const genres = await callApp(app, env, `/Genres?UserId=${adminId}&Fields=ItemCounts`, { headers: authHeader(token) });
    expect(genres.status).toBe(200);
    const genresBody = (await genres.json()) as { Items: { Name: string; MovieCount: number; SeriesCount: number; ChildCount: number }[]; TotalRecordCount: number };
    const byName = new Map(genresBody.Items.map((item) => [item.Name, item]));
    expect(byName.get("Action")).toMatchObject({ MovieCount: 2, SeriesCount: 0, ChildCount: 2 });
    expect(byName.get("Drama")).toMatchObject({ MovieCount: 0, SeriesCount: 1, ChildCount: 1 });
    expect(genresBody.TotalRecordCount).toBe(3);

    const unrequested = await callApp(app, env, `/Genres?UserId=${adminId}`, { headers: authHeader(token) });
    const unrequestedBody = (await unrequested.json()) as { Items: Record<string, unknown>[] };
    for (const item of unrequestedBody.Items) {
      expect("ChildCount" in item).toBe(false);
      expect("MovieCount" in item).toBe(false);
      expect("SeriesCount" in item).toBe(false);
    }

    const filters = await callApp(app, env, `/Items/Filters?UserId=${adminId}`, { headers: authHeader(token) });
    const filtersBody = (await filters.json()) as { Genres: string[]; Years: number[] };
    expect(filtersBody.Genres).toContain("Action");
    expect(filtersBody.Years).toContain(2024);

    const filters2 = await callApp(app, env, `/Items/Filters2?UserId=${adminId}`, { headers: authHeader(token) });
    const filters2Body = (await filters2.json()) as { Genres: { Name: string }[] };
    expect(filters2Body.Genres.map((genre) => genre.Name)).toContain("Drama");

    const counts = await callApp(app, env, `/Items/Counts?UserId=${adminId}`, { headers: authHeader(token) });
    const countsBody = (await counts.json()) as { MovieCount: number; SeriesCount: number };
    expect(countsBody.MovieCount).toBeGreaterThan(0);
    expect(countsBody.SeriesCount).toBeGreaterThan(0);

    const root = await callApp(app, env, `/Items/Root?UserId=${adminId}`, { headers: authHeader(token) });
    expect(root.status).toBe(200);
    expect(((await root.json()) as { Type: string }).Type).toBe("Folder");

    const noAuth = await callApp(app, env, "/Genres");
    expect(noAuth.status).toBe(401);
  });

  it("scopes genre facets to the requested library", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const movies = encodeView(CINE, "movie", "top");

    const res = await callApp(app, env, `/Genres?UserId=${adminId}&ParentId=${movies}`, { headers: authHeader(token) });
    const body = (await res.json()) as { Items: { Name: string }[] };
    expect(body.Items.map((item) => item.Name)).toEqual(["Action", "Comedy"]);
  });
});
