import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem } from "../src/ids";
import { fetchMediaSegments, fromAniSkip, fromIntroDb, segmentId } from "../src/segments";
import { callApp, createFakeDb, testEnv } from "./fake-db";

const ALPHA = "https://alpha.example";

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("media segments (skip intro & outro)", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).caches = {
      default: {
        match: async (key: Request) => {
          const body = store.get(key.url);
          return body ? new Response(body, { status: 200, headers: { "content-type": "application/json" } }) : undefined;
        },
        put: async (key: Request, res: Response) => {
          store.set(key.url, await res.clone().text());
        },
      },
    };
  });

  it("parses IntroDB segments correctly", async () => {
    const fetchMock: typeof fetch = async (url) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      expect(u).toContain("imdb_id=tt0903747");
      expect(u).toContain("season=1");
      expect(u).toContain("episode=1");
      return new Response(
        JSON.stringify({
          intro: { start_ms: 120000, end_ms: 210000 },
          recap: { start_ms: 0, end_ms: 120000 },
          outro: { start_ms: 2800000, end_ms: 2900000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const segments = await fromIntroDb(fetchMock, { imdbId: "tt0903747", season: 1, episode: 1 });
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "Intro", startMs: 120000, endMs: 210000 });
    expect(segments[1]).toEqual({ type: "Recap", startMs: 0, endMs: 120000 });
    expect(segments[2]).toEqual({ type: "Outro", startMs: 2800000, endMs: 2900000 });
  });

  it("parses AniSkip segments correctly and maps op/ed types", async () => {
    const fetchMock: typeof fetch = async (url) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      expect(u).toContain("/skip-times/21/1");
      return new Response(
        JSON.stringify({
          found: true,
          results: [
            { skipType: "op", interval: { startTime: 90.5, endTime: 180.5 } },
            { skipType: "ed", interval: { startTime: 1350.0, endTime: 1440.0 } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const segments = await fromAniSkip(fetchMock, { malId: 21, episode: 1 });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: "Intro", startMs: 90500, endMs: 180500 });
    expect(segments[1]).toEqual({ type: "Outro", startMs: 1350000, endMs: 1440000 });
  });

  it("handles upstream failures gracefully", async () => {
    const fetchFail: typeof fetch = async () => new Response("down", { status: 500 });
    const introSegs = await fromIntroDb(fetchFail, { imdbId: "tt9999999", season: 1, episode: 1 });
    expect(introSegs).toEqual([]);

    const aniSegs = await fromAniSkip(fetchFail, { malId: 999999, episode: 1 });
    expect(aniSegs).toEqual([]);
  });

  it("fetches segments with edge caching and converts to Jellyfin ticks", async () => {
    let callCount = 0;
    const fetchMock: typeof fetch = async (url) => {
      callCount++;
      return new Response(
        JSON.stringify({
          intro: { start_ms: 100000, end_ms: 190000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const itemId = "e.test.tt100.1.1";
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
    const segments1 = await fetchMediaSegments(cache, fetchMock, {
      itemId,
      imdbId: "tt100",
      season: 1,
      episode: 1,
    });

    expect(segments1).toHaveLength(1);
    expect(segments1[0]?.Type).toBe("Intro");
    expect(segments1[0]?.StartTicks).toBe(100000 * 10000);
    expect(segments1[0]?.EndTicks).toBe(190000 * 10000);
    expect(segments1[0]?.Id).toBe(segmentId(itemId, "Intro"));
    expect(callCount).toBe(1);

    // Second call should hit the cache
    const segments2 = await fetchMediaSegments(cache, fetchMock, {
      itemId,
      imdbId: "tt100",
      season: 1,
      episode: 1,
    });
    expect(segments2).toEqual(segments1);
    expect(callCount).toBe(1); // No new network call
  });

  it("serves /Items/:id/MediaSegments and filters by IncludeSegmentTypes", async () => {
    const raw = createFakeDb();
    const db = raw as unknown as import("@cloudflare/workers-types").D1Database;
    const reg = (await registerFirstUser(db, "admin", "secretpass123", 1000)).body as { id: string };
    const token = await issueToken(db, reg.id, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);

    const episodeId = encodeEpisode(ALPHA, "tt0903747", 1, 2);

    // Mock fetch for IntroDB
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("introdb.app")) {
        return new Response(
          JSON.stringify({
            intro: { start_ms: 60000, end_ms: 120000 },
            outro: { start_ms: 2500000, end_ms: 2600000 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    // Test GET /Items/:id/MediaSegments
    const res = await callApp(app, env, `/Items/${episodeId}/MediaSegments`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      Items: { Id: string; ItemId: string; Type: string; StartTicks: number; EndTicks: number }[];
      TotalRecordCount: number;
    };
    expect(body.TotalRecordCount).toBe(2);
    expect(body.Items).toHaveLength(2);
    expect(body.Items[0]?.Type).toBe("Intro");
    expect(body.Items[0]?.StartTicks).toBe(600000000);
    expect(body.Items[1]?.Type).toBe("Outro");

    // Test GET /MediaSegments/:id alias
    const aliasRes = await callApp(app, env, `/MediaSegments/${episodeId}`, {
      headers: authHeader(token),
    });
    expect(aliasRes.status).toBe(200);
    const aliasBody = (await aliasRes.json()) as typeof body;
    expect(aliasBody.TotalRecordCount).toBe(2);

    // Test filtering by includeSegmentTypes
    const filterRes = await callApp(app, env, `/Items/${episodeId}/MediaSegments?IncludeSegmentTypes=Intro`, {
      headers: authHeader(token),
    });
    expect(filterRes.status).toBe(200);
    const filterBody = (await filterRes.json()) as typeof body;
    expect(filterBody.TotalRecordCount).toBe(1);
    expect(filterBody.Items[0]?.Type).toBe("Intro");

    // Unauthorized returns 401
    const anonRes = await callApp(app, env, `/Items/${episodeId}/MediaSegments`);
    expect(anonRes.status).toBe(401);
  });

  it("caches found segments for the full TTL and empty results only briefly", async () => {
    const inspect = (store: Map<string, { body: string; maxAge: number }>) => store;
    let backing: Map<string, { body: string; maxAge: number }>;
    const cache: Cache = {
      match: async (key: Request) => {
        const entry = backing.get(key.url);
        return entry ? new Response(entry.body) : undefined;
      },
      put: async (key: Request, res: Response) => {
        const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 0);
        backing.set(key.url, { body: await res.clone().text(), maxAge });
      },
    } as unknown as Cache;

    let calls = 0;
    const fetchHit: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ intro: { start_ms: 10000, end_ms: 20000 } }), { status: 200 });
    };

    backing = new Map();
    void inspect;
    await fetchMediaSegments(cache, fetchHit, { itemId: "e.test.tt200.1.1", imdbId: "tt200", season: 1, episode: 1 });
    expect(calls).toBe(1);
    expect(backing.size).toBe(1);
    expect([...backing.values()][0]?.maxAge).toBe(7 * 24 * 60 * 60);
    await fetchMediaSegments(cache, fetchHit, { itemId: "e.test.tt200.1.1", imdbId: "tt200", season: 1, episode: 1 });
    expect(calls).toBe(1);

    const emptyCalls = { n: 0 };
    void emptyCalls;
    const fetchEmpty: typeof fetch = async () => new Response("{}", { status: 200 });
    backing = new Map();
    await fetchMediaSegments(cache, fetchEmpty, { itemId: "e.test.tt300.1.1", imdbId: "tt300", season: 1, episode: 1 });
    expect([...backing.values()][0]?.maxAge).toBe(300);
  });
  it("prefers PublicMetaDB streaming segments and fills leftovers from AniSkip and IntroDB", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (url, init) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      calls.push(u);
      if (u.includes("publicmetadb.com/api/external/skips")) {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer key123");
        expect(u).toContain("tmdb_id=1399");
        expect(u).toContain("media_type=tv");
        expect(u).toContain("season=1");
        expect(u).toContain("episode=1");
        return Response.json({
          items: [
            { source: "dvd", intro_start_ms: 5000, intro_end_ms: 6000, credits_start_ms: 9000, credits_end_ms: 9500 },
            { source: "streaming", intro_start_ms: 1000, intro_end_ms: 2000, credits_start_ms: 8000, credits_end_ms: 8800 },
          ],
        });
      }
      if (u.includes("aniskip.com")) {
        return Response.json({ results: [{ skipType: "recap", interval: { startTime: 1, endTime: 2 } }] });
      }
      if (u.includes("introdb.app")) {
        return Response.json({ intro: { start_ms: 3000, end_ms: 4000 } });
      }
      return new Response("down", { status: 500 });
    };

    const segments = await fetchMediaSegments(
      caches.default,
      fetchMock,
      { itemId: "e.alpha.1", imdbId: "tt0903747", tmdbId: "1399", season: 1, episode: 1, malId: 21 },
      "key123",
    );
    expect(segments.map((s) => s.Type)).toEqual(["Intro", "Outro", "Recap"]);
    expect(segments.find((s) => s.Type === "Intro")?.StartTicks).toBe(1000 * 10000);
    expect(segments.find((s) => s.Type === "Outro")?.EndTicks).toBe(8800 * 10000);
    expect(segments.find((s) => s.Type === "Recap")?.StartTicks).toBe(1 * 1000 * 10000);
    expect(calls.some((u) => u.includes("publicmetadb.com"))).toBe(true);
  });

  it("isolates kitsu IDs and does not pass them as raw MAL IDs to AniSkip", async () => {
    const raw = createFakeDb();
    const db = raw as unknown as import("@cloudflare/workers-types").D1Database;
    const reg = (await registerFirstUser(db, "admin", "secretpass123", 1000)).body as { id: string };
    const token = await issueToken(db, reg.id, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);

    const kitsuEpisodeId = encodeEpisode(ALPHA, "kitsu:12", 1, 1);
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      if (u.includes("/manifest.json")) {
        return Response.json({ id: "alpha", resources: ["catalog", "meta", "stream"], catalogs: [] });
      }
      if (u.includes("/meta/series/kitsu:12.json")) {
        return Response.json({
          meta: {
            id: "kitsu:12",
            type: "series",
            name: "Anime Show",
            runtime: "24 min",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const res = await callApp(app, env, `/Items/${kitsuEpisodeId}/MediaSegments`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    expect(calls.some((u) => u.includes("aniskip.com/v2/skip-times/12"))).toBe(false);
  });

  it("extracts mal_id from meta when available for anime", async () => {
    const raw = createFakeDb();
    const db = raw as unknown as import("@cloudflare/workers-types").D1Database;
    const reg = (await registerFirstUser(db, "admin", "secretpass123", 1000)).body as { id: string };
    const token = await issueToken(db, reg.id, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);

    const kitsuEpisodeId = encodeEpisode(ALPHA, "kitsu:50", 1, 1);
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      if (u.includes("/manifest.json")) {
        return Response.json({ id: "alpha", resources: ["catalog", "meta", "stream"], catalogs: [] });
      }
      if (u.includes("/meta/series/kitsu:50.json")) {
        return Response.json({
          meta: {
            id: "kitsu:50",
            type: "series",
            name: "Anime Show",
            mal_id: 21,
            runtime: "24 min",
          },
        });
      }
      if (u.includes("aniskip.com/v2/skip-times/21/1")) {
        return Response.json({
          found: true,
          results: [{ skipType: "op", interval: { startTime: 10, endTime: 100 } }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const res = await callApp(app, env, `/Items/${kitsuEpisodeId}/MediaSegments`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Type: string }[] };
    expect(body.Items).toHaveLength(1);
    expect(body.Items[0]?.Type).toBe("Intro");
    expect(calls.some((u) => u.includes("aniskip.com/v2/skip-times/21/1"))).toBe(true);
  });

  it("skips PublicMetaDB when no api key is configured", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (url) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      calls.push(u);
      if (u.includes("introdb.app")) return Response.json({ intro: { start_ms: 1000, end_ms: 2000 } });
      return new Response("down", { status: 500 });
    };
    const segments = await fetchMediaSegments(caches.default, fetchMock, {
      itemId: "m.alpha.2",
      imdbId: "tt0903747",
      tmdbId: "1399",
    });
    expect(segments.map((s) => s.Type)).toEqual(["Intro"]);
    expect(calls.some((u) => u.includes("publicmetadb.com"))).toBe(false);
  });
});
