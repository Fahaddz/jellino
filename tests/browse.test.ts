import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { writeSetting } from "../src/db";
import { encodeEpisode, encodeItem, encodePerson, encodeSeason, encodeView } from "../src/ids";
import { viewArtwork } from "../src/browse";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";
const POSTER = "https://img.example/p.jpg";
const SERIES_POSTER = "https://img.example/series.jpg";
const SEASON1_POSTER = "https://img.example/season1.jpg";
const SEASON2_POSTER = "https://img.example/season2.jpg";
const EP1_STILL = "https://img.example/ep1.jpg";

function installNet(calls: string[]) {
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
          { type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] },
          { type: "series", id: "top", name: "Top", extra: [] },
        ],
      });
    }
    if (url.startsWith(`${CINE}/catalog/movie/top/search=`)) {
      return Response.json({
        metas: [
          { id: "tt123", type: "movie", name: "Example Film", poster: POSTER },
          { id: "tt123", type: "movie", name: "Example Film Duplicate" },
        ],
      });
    }
    if (url === `${CINE}/catalog/movie/top.json`) {
      return Response.json({ metas: [{ id: "tt123", type: "movie", name: "Example Film", poster: POSTER }] });
    }
    if (url === `${CINE}/meta/movie/tt123.json`) {
      return Response.json({ meta: { id: "tt123", type: "movie", name: "Example Film", poster: POSTER } });
    }
    if (url === `${CINE}/meta/series/tt456.json`) {
      return Response.json({
        meta: {
          id: "tt456",
          type: "series",
          name: "Example Show",
          poster: SERIES_POSTER,
          videos: [
            { season: 1, episode: 1, title: "Pilot", thumbnail: EP1_STILL },
            { season: 1, episode: 2, title: "Second" },
            { season: 2, episode: 1, title: "Return" },
          ],
          app_extras: { seasonPosters: [null, SEASON1_POSTER, SEASON2_POSTER] },
        },
      });
    }
    if (url === POSTER) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });
    }
    if (url.startsWith("https://api.themoviedb.org/3/search/person")) {
      if (url.includes("Jane%20Star")) {
        return Response.json({ results: [{ name: "Jane Star", profile_path: "/jane.jpg" }] });
      }
      return Response.json({ results: [] });
    }
    return new Response("missing", { status: 404 });
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

async function setup() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
  const token = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
  return { raw, adminId: admin.id, token };
}

function auth(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("browse routes", () => {
  it("searches searchable catalogs with per-type dedupe", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, adminId, token } = await setup();
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items?searchTerm=film`, {
      headers: auth(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string; Type: string }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(1);
    expect(body.Items[0]).toMatchObject({ Name: "Example Film", Type: "Movie" });
    expect(calls.some((u) => u.includes("/catalog/series/"))).toBe(false);
  });

  it("excludes locally hidden catalogs from search", async () => {
    installNet([]);
    const { raw, adminId, token } = await setup();
    await writeSetting(raw as unknown as Db, `nuvio_home:${adminId}`, JSON.stringify({
      hide_unreleased_content: false,
      show_catalog_type: true,
      items: [
        { addon_id: "cine", base: CINE, type: "movie", catalog_id: "top", enabled: false, order: 0, custom_title: "", is_collection: false, collection_id: "" },
        { addon_id: "cine", base: CINE, type: "series", catalog_id: "top", enabled: true, order: 1, custom_title: "", is_collection: false, collection_id: "" },
      ],
      collections: [],
    }));
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items?searchTerm=film`, {
      headers: auth(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: unknown[]; TotalRecordCount: number };
    expect(body.Items).toHaveLength(0);
    expect(body.TotalRecordCount).toBe(0);
  });

  it("lists catalog items under a view id with parent linkage", async () => {
    installNet([]);
    const { raw, adminId, token } = await setup();
    const viewId = encodeView(CINE, "movie", "top");
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items?parentId=${viewId}`, {
      headers: auth(token),
    });
    const body = (await res.json()) as { Items: { ParentId: string }[] };
    expect(body.Items).toHaveLength(1);
    expect(body.Items[0]?.ParentId).toBe(viewId);
  });

  it("serves latest rows as a bare array", async () => {
    installNet([]);
    const { raw, adminId, token } = await setup();
    const viewId = encodeView(CINE, "movie", "top");
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/Latest?parentId=${viewId}`, {
      headers: auth(token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("redirects artwork to the upstream url without downloading bytes", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(CINE, "movie", "tt123");
    const first = await callApp(app, env, `/Items/${id}/Images/Primary`, { headers: auth(token) });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(POSTER);
    expect(calls.filter((u) => u === POSTER)).toHaveLength(0);
    const second = await callApp(app, env, `/Items/${id}/Images/Primary/0`, { headers: auth(token) });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe(POSTER);
  });

  it("serves per-season posters instead of the series poster", async () => {
    installNet([]);
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const seriesId = encodeItem(CINE, "series", "tt456");
    const seasons = (await (
      await callApp(app, env, `/Shows/${seriesId}/Seasons?userId=${adminId}`, { headers: auth(token) })
    ).json()) as { Items: { ImageTags: unknown }[]; TotalRecordCount: number };
    expect(seasons.TotalRecordCount).toBe(2);
    expect(seasons.Items[0]?.ImageTags).not.toEqual(seasons.Items[1]?.ImageTags);
    const first = await callApp(app, env, `/Items/${encodeSeason(CINE, "tt456", 1)}/Images/Primary`, {
      headers: auth(token),
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(SEASON1_POSTER);
    const second = await callApp(app, env, `/Items/${encodeSeason(CINE, "tt456", 2)}/Images/Primary`, {
      headers: auth(token),
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe(SEASON2_POSTER);
    const missing = await callApp(app, env, `/Items/${encodeSeason(CINE, "tt456", 9)}/Images/Primary`, { headers: auth(token) });
    expect(missing.status).toBe(302);
    expect(missing.headers.get("location")).toBe(SERIES_POSTER);
  });

  it("carries placeholder versions on season children so clients show the picker", async () => {
    installNet([]);
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const season = encodeSeason(CINE, "tt456", 1);
    const res = await callApp(app, env, `/Users/${adminId}/Items?parentId=${season}`, { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      Items: { Type: string; EnableMediaSourceDisplay?: boolean; MediaSources?: { Name: string }[] }[];
    };
    expect(body.Items).toHaveLength(2);
    for (const item of body.Items) {
      expect(item.Type).toBe("Episode");
      expect(item.EnableMediaSourceDisplay).toBe(true);
      expect(item.MediaSources?.map((source) => source.Name)).toEqual([
        "Streams load when played",
        "Load the stream list",
      ]);
    }
  });

  it("falls back to the series poster for an episode without a still", async () => {
    installNet([]);
    const { raw, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const still = await callApp(app, env, `/Items/${encodeEpisode(CINE, "tt456", 1, 1)}/Images/Primary`, {
      headers: auth(token),
    });
    expect(still.status).toBe(302);
    expect(still.headers.get("location")).toBe(EP1_STILL);
    const bare = await callApp(app, env, `/Items/${encodeEpisode(CINE, "tt456", 1, 2)}/Images/Primary`, {
      headers: auth(token),
    });
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe(SERIES_POSTER);
  });
  it("returns 404 artwork for unknown kinds and missing posters", async () => {
    installNet([]);
    const { raw, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(CINE, "movie", "tt123");
    expect((await callApp(app, env, `/Items/${id}/Images/Banner`, { headers: auth(token) })).status).toBe(404);
  });

  it("gates browse routes on the token owner", async () => {
    installNet([]);
    const { raw, adminId } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    expect((await callApp(app, env, `/Users/${adminId}/Items?searchTerm=x`)).status).toBe(401);
    expect((await callApp(app, env, `/Users/${adminId}/Items/Latest`)).status).toBe(401);
  });

  it("filters listings by watched state when asked", async () => {
    installNet([]);
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const viewId = encodeView(CINE, "movie", "top");
    const id = encodeItem(CINE, "movie", "tt123");
    await callApp(app, env, `/Users/${adminId}/PlayedItems/${id}`, { method: "POST", headers: auth(token) });

    const unplayed = (await (
      await callApp(app, env, `/Users/${adminId}/Items?parentId=${viewId}&Filters=IsUnplayed`, { headers: auth(token) })
    ).json()) as { TotalRecordCount: number };
    expect(unplayed.TotalRecordCount).toBe(0);

    const played = (await (
      await callApp(app, env, `/Users/${adminId}/Items?parentId=${viewId}&Filters=IsPlayed`, { headers: auth(token) })
    ).json()) as { TotalRecordCount: number };
    expect(played.TotalRecordCount).toBe(1);

    const all = (await (
      await callApp(app, env, `/Users/${adminId}/Items?parentId=${viewId}`, { headers: auth(token) })
    ).json()) as { TotalRecordCount: number };
    expect(all.TotalRecordCount).toBe(1);

    const playedFlag = (await (
      await callApp(app, env, `/Users/${adminId}/Items?parentId=${viewId}&IsPlayed=true`, { headers: auth(token) })
    ).json()) as { TotalRecordCount: number };
    expect(playedFlag.TotalRecordCount).toBe(1);

    const unplayedFlag = (await (
      await callApp(app, env, `/Users/${adminId}/Items?parentId=${viewId}&IsPlayed=FALSE`, { headers: auth(token) })
    ).json()) as { TotalRecordCount: number };
    expect(unplayedFlag.TotalRecordCount).toBe(0);
  });
});

describe("viewArtwork", () => {
  const cacheStub = {
    match: async () => undefined,
    put: async () => {},
    delete: async () => false,
  } as unknown as Cache;

  function catalogFetch(metas: unknown) {
    return (async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${CINE}/catalog/movie/top.json`) {
        return new Response(JSON.stringify({ metas }), { headers: { "content-type": "application/json" } });
      }
      return new Response("down", { status: 500 });
    }) as typeof fetch;
  }

  const view = { addonUrl: CINE, catalogType: "movie", catalogId: "top" };

  it("prefers a landscape backdrop from addon shelves", async () => {
    const art = await viewArtwork({} as Db, cacheStub, catalogFetch([
      { id: "tt1", type: "movie", name: "Poster only", poster: POSTER },
      { id: "tt2", type: "movie", name: "With backdrop", poster: POSTER, background: "https://img.example/bg.jpg" },
    ]), view);
    expect(art).toBe("https://img.example/bg.jpg");
  });

  it("falls back to the first poster, then null when empty", async () => {
    const posterOnly = await viewArtwork({} as Db, cacheStub, catalogFetch([
      { id: "tt1", type: "movie", name: "Poster only", poster: POSTER },
    ]), view);
    expect(posterOnly).toBe(POSTER);
    const empty = await viewArtwork({} as Db, cacheStub, catalogFetch([]), view);
    expect(empty).toBeNull();
  });
});
