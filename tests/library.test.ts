import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { decodeItem, decodeView, encodeView } from "../src/ids";
import { catalogBases, catalogMediaKind, catalogSupported } from "../src/library";
import { writeSetting } from "../src/db";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;
type Raw = ReturnType<typeof createFakeDb>;

const CINE = "https://cine.example";
const TOONS = "https://toons.example";
const DEAD = "https://dead.example";

function installNet(calls: string[]) {
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
    calls.push(url);
    if (url === `${CINE}/manifest.json`) {
      return new Response(
        JSON.stringify({
          catalogs: [
            { type: "movie", id: "top", name: "Top" },
            { type: "series", id: "top", name: "Top" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${TOONS}/manifest.json`) {
      return new Response(JSON.stringify({ catalogs: [{ type: "series", id: "kids", name: "Kids" }] }), {
        headers: { "content-type": "application/json" },
      });
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
  raw.profiles.push(
    { id: "kid", name: "kid", password_hash: "x", salt: "y", is_admin: 0, addon_mode: "inherit", created_at: 2000 },
    { id: "teen", name: "teen", password_hash: "x", salt: "y", is_admin: 0, addon_mode: "custom", created_at: 3000 },
  );
  raw.addons.push(
    { profile_id: admin.id, url: CINE, position: 0, enabled: 1 },
    { profile_id: admin.id, url: DEAD, position: 1, enabled: 1 },
    { profile_id: "teen", url: TOONS, position: 0, enabled: 1 },
    { profile_id: "teen", url: CINE, position: 1, enabled: 0 },
  );
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("view ids", () => {
  it("round-trips addon, type, and catalog", () => {
    expect(decodeView(encodeView(CINE, "movie", "top"))).toEqual({
      addonUrl: CINE,
      catalogType: "movie",
      catalogId: "top",
    });
  });

  it("rejects foreign ids", () => {
    expect(decodeView("nope")).toBeNull();
    expect(decodeView("v.only.two")).toBeNull();
  });
});

describe("profile libraries", () => {
  it("inherits admin addons, skips dead ones, disambiguates duplicate names", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db } = await household();
    const res = await callApp(createApp(), testEnv(raw), "/Users/kid/Views", {
      headers: authHeader(await liveToken(db, "kid")),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string; Type: string }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(2);
    expect(body.Items.map((i) => i.Name).sort()).toEqual(
      ["Top Movies", "Top Shows"].sort(),
    );
    expect(body.Items.every((i) => i.Type === "CollectionFolder")).toBe(true);
    expect(calls.filter((u) => u === `${CINE}/manifest.json`)).toHaveLength(1);
    expect(calls).toContain(`${DEAD}/manifest.json`);
  });

  it("accepts addon urls pasted with a manifest.json suffix", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    raw.addons.push({ profile_id: adminId, url: `${TOONS}/manifest.json`, position: 2, enabled: 1 });
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Views`, {
      headers: authHeader(await liveToken(db, adminId)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(3);
    expect(body.Items.map((i) => i.Name).sort()).toEqual(["Kids", "Top Movies", "Top Shows"].sort());
    expect(calls.filter((u) => u === `${TOONS}/manifest.json`)).toHaveLength(1);
  });

  it("serves custom profiles their own addons only", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db } = await household();
    const res = await callApp(createApp(), testEnv(raw), "/Users/teen/Views", {
      headers: authHeader(await liveToken(db, "teen")),
    });
    const body = (await res.json()) as { Items: { Name: string }[] };
    expect(body.Items.map((i) => i.Name)).toEqual(["Kids"]);
    expect(calls.some((u) => u.startsWith(CINE))).toBe(false);
  });

  it("caches manifests across requests", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const headers = authHeader(await liveToken(db, adminId));
    const first = await callApp(app, env, `/Users/${adminId}/Views`, { headers });
    const second = await callApp(app, env, `/Users/${adminId}/Views`, { headers });
    expect(((await first.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(2);
    expect(((await second.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(2);
    expect(calls.filter((u) => u === `${CINE}/manifest.json`)).toHaveLength(1);
  });

  it("rejects missing and foreign tokens, accepts the UserViews spelling", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db } = await household();
    const app = createApp();
    const env = testEnv(raw);
    expect((await callApp(app, env, "/Users/kid/Views")).status).toBe(401);
    const adminToken = await liveToken(db, raw.profiles.find((p) => p.name === "dad")?.id ?? "");
    expect((await callApp(app, env, "/Users/kid/Views", { headers: authHeader(adminToken) })).status).toBe(401);
    const legacy = await callApp(app, env, "/UserViews?userId=kid", {
      headers: authHeader(await liveToken(db, "kid")),
    });
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(2);
  });

});

describe("built-in catalog", () => {
  function installCatalogNet() {
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
      if (url === `${CINE}/manifest.json`) {
        return new Response(
          JSON.stringify({
            catalogs: [
              { type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] },
              { type: "series", id: "top", name: "Top", extra: [{ name: "search" }] },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${CINE}/catalog/movie/top.json` || url.startsWith(`${CINE}/catalog/movie/top/search=`)) {
        return new Response(JSON.stringify({ metas: [{ id: "tt1", type: "movie", name: "Found" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${CINE}/catalog/series/top.json` || url.startsWith(`${CINE}/catalog/series/top/search=`)) {
        return new Response(JSON.stringify({ metas: [{ id: "tt2", type: "series", name: "Show Found" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 404 });
    };
  }

  it("returns user addon urls with no prepend", async () => {
    const { db, adminId } = await household();
    expect(await catalogBases(db, adminId)).toEqual([CINE, DEAD]);
    expect(await catalogBases(db, "teen")).toEqual([TOONS]);
    expect(await catalogBases(db, "nobody")).toBeNull();
  });

});

describe("client compatibility routes", () => {
  function installClientNet() {
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
      if (url === `${CINE}/manifest.json`) {
        return new Response(
          JSON.stringify({
            catalogs: [
              { type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] },
              { type: "series", id: "top", name: "Top", extra: [{ name: "search" }] },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${CINE}/catalog/movie/top.json` || url.startsWith(`${CINE}/catalog/movie/top/search=`)) {
        return new Response(JSON.stringify({ metas: [{ id: "tt1", type: "movie", name: "Found" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${CINE}/catalog/series/top.json` || url.startsWith(`${CINE}/catalog/series/top/search=`)) {
        return new Response(JSON.stringify({ metas: [{ id: "tt2", type: "series", name: "Show Found" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 404 });
    };
  }

  it("serves UserViews, VirtualFolders, and DisplayPreferences with token-only auth", async () => {
    installClientNet();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const solo = (await registerFirstUser(db, "solo", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: solo.id, url: CINE, position: 0, enabled: 1 });
    const headers = authHeader(await liveToken(db, solo.id));
    const app = createApp();
    const env = testEnv(raw);

    const views = await callApp(app, env, "/UserViews", { headers });
    expect(views.status).toBe(200);
    const viewsData = (await views.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(viewsData.TotalRecordCount).toBe(2);

    const folders = await callApp(app, env, "/Library/VirtualFolders", { headers });
    expect(folders.status).toBe(200);
    const foldersData = (await folders.json()) as { Name: string }[];
    expect(foldersData.length).toBe(2);

    const prefs = await callApp(app, env, "/DisplayPreferences/emby", { headers });
    expect(prefs.status).toBe(200);
    const prefsData = (await prefs.json()) as { Id: string; Client: string };
    expect(prefsData.Id).toBe("emby");
  });

  it("supports SearchHints and PascalCase query parameters", async () => {
    installClientNet();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const solo = (await registerFirstUser(db, "solo", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: solo.id, url: CINE, position: 0, enabled: 1 });
    const headers = authHeader(await liveToken(db, solo.id));
    const app = createApp();
    const env = testEnv(raw);

    const hints = await callApp(app, env, "/Search/Hints?searchTerm=found", { headers });
    expect(hints.status).toBe(200);
    const hintsData = (await hints.json()) as { SearchHints: { Name: string; ItemId: string }[]; TotalRecordCount: number };
    expect(hintsData.TotalRecordCount).toBeGreaterThan(0);
    expect(hintsData.SearchHints[0]?.ItemId).toBeDefined();

    const hintsWithUserId = await callApp(app, env, `/Users/${solo.id}/Search/Hints?SearchTerm=found`, { headers });
    expect(hintsWithUserId.status).toBe(200);

    const pascalSearch = await callApp(app, env, "/Items?SearchTerm=found&Limit=5&StartIndex=0", { headers });
    expect(pascalSearch.status).toBe(200);
    const searchData = (await pascalSearch.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(searchData.TotalRecordCount).toBeGreaterThan(0);

    const viewsRes = await callApp(app, env, "/UserViews", { headers });
    const views = ((await viewsRes.json()) as { Items: { Id: string }[] }).Items;
    const pascalParent = await callApp(app, env, `/Items?ParentId=${views[0]?.Id}&Limit=5`, { headers });
    expect(pascalParent.status).toBe(200);
    const parentData = (await pascalParent.json()) as { Items: unknown[] };
    expect(parentData.Items.length).toBeGreaterThan(0);

    const latestMovie = await callApp(app, env, `/Users/${solo.id}/Items/Latest?IncludeItemTypes=Movie`, { headers });
    expect(latestMovie.status).toBe(200);
    const movieItems = (await latestMovie.json()) as { Name: string }[];
    expect(movieItems.length).toBeGreaterThan(0);

    const latestTv = await callApp(app, env, `/Users/${solo.id}/Items/Latest?IncludeItemTypes=Series`, { headers });
    expect(latestTv.status).toBe(200);
    const tvItems = (await latestTv.json()) as { Name: string }[];
    expect(tvItems.length).toBeGreaterThan(0);
  });
});

describe("custom catalog types", () => {
  const XT = "https://xt.example";

  function installCustomTypeNet() {
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
      if (url === `${XT}/manifest.json`) {
        return new Response(
          JSON.stringify({
            id: "org.xtremio.addon",
            catalogs: [
              { type: "أفلام", id: "xtremio_pick_m_1206", name: "|AR| أفلام تركية" },
              { type: "مسلسلات", id: "xtremio_pick_s_1201", name: "|AR| يعرض الأن تركي" },
              { type: "مباشر", id: "xtremio_pick_l_1020", name: "AR| SHAHID SERIES" },
              { type: "music", id: "tunes", name: "Tunes" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("xtremio_pick_m_1206")) {
        return new Response(JSON.stringify({ metas: [{ id: "xtremio_movie_1", type: "أفلام", name: "Film" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("xtremio_pick_s_1201")) {
        return new Response(JSON.stringify({ metas: [{ id: "xtremio_series_1", type: "series", name: "Show" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 404 });
    };
  }

  async function soloHousehold() {
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const solo = (await registerFirstUser(db, "solo", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: solo.id, url: XT, position: 0, enabled: 1 });
    return { raw, db, soloId: solo.id };
  }

  it("types only protocol catalog names and leaves everything else mixed", () => {
    expect(catalogMediaKind("movie")).toBe("movies");
    expect(catalogMediaKind("movies")).toBe("movies");
    expect(catalogMediaKind("series")).toBe("tvshows");
    expect(catalogMediaKind("tvshows")).toBe("tvshows");
    expect(catalogMediaKind("shows")).toBe("tvshows");
    expect(catalogMediaKind("XT-Movies")).toBe("mixed");
    expect(catalogMediaKind("XT-Series")).toBe("mixed");
    expect(catalogMediaKind("Live TV")).toBe("mixed");
    expect(catalogMediaKind("أفلام")).toBe("mixed");
    expect(catalogMediaKind("مسلسلات")).toBe("mixed");
    expect(catalogMediaKind("مباشر")).toBe("mixed");
    expect(catalogMediaKind("مجهول")).toBe("mixed");
    expect(catalogMediaKind("حلقات")).toBe("mixed");
    expect(catalogMediaKind("قنوات")).toBe("mixed");
    expect(catalogSupported("أفلام")).toBe(true);
    expect(catalogSupported("music")).toBe(false);
  });

  it("serves custom-type catalogs as untyped libraries with typed items", async () => {
    installCustomTypeNet();
    const { raw, db, soloId } = await soloHousehold();
    const headers = authHeader(await liveToken(db, soloId));
    const res = await callApp(createApp(), testEnv(raw), `/Users/${soloId}/Views`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Id: string; Name: string; CollectionType?: string }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(3);
    expect(body.Items.map((i) => [i.Name, i.CollectionType])).toEqual([
      ["|AR| أفلام تركية", undefined],
      ["|AR| يعرض الأن تركي", undefined],
      ["AR| SHAHID SERIES", undefined],
    ]);
    const app = createApp();
    const env = testEnv(raw);
    const movieView = body.Items.find((i) => i.Name === "|AR| أفلام تركية");
    const seriesView = body.Items.find((i) => i.Name === "|AR| يعرض الأن تركي");
    const moviePage = await callApp(app, env, `/Users/${soloId}/Items?parentId=${movieView?.Id}`, { headers });
    const movieItems = ((await moviePage.json()) as { Items: { Type: string; Name: string }[] }).Items;
    expect(movieItems[0]).toMatchObject({ Name: "Film", Type: "Movie" });
    const seriesPage = await callApp(app, env, `/Users/${soloId}/Items?parentId=${seriesView?.Id}`, { headers });
    const seriesItems = ((await seriesPage.json()) as { Items: { Type: string; Name: string }[] }).Items;
    expect(seriesItems[0]).toMatchObject({ Name: "Show", Type: "Series" });
  });

});

describe("nuvio home snapshot", () => {
  const SNAP = "https://snap.example";

  function installSnapshotNet() {
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
      if (url === `${SNAP}/manifest.json`) {
        return new Response(
          JSON.stringify({
            catalogs: [
              { type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] },
              { type: "series", id: "top", name: "Top", extra: [{ name: "search" }] },
              { type: "customtv", id: "mix", name: "Mix" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${SNAP}/catalog/movie/top.json`) {
        return Response.json({
          metas: Array.from({ length: 30 }, (_, i) => ({
            id: `tt${100 + i}`,
            type: "movie",
            name: `Movie ${i + 1}`,
            ...(i === 0 ? { released: "2999-01-01T00:00:00.000Z" } : {}),
          })),
        });
      }
      if (url === `${SNAP}/catalog/series/top.json` || url.startsWith(`${SNAP}/catalog/series/top/search=`)) {
        return Response.json({ metas: [{ id: "tt200", type: "series", name: "Shared Show" }] });
      }
      if (url === `${SNAP}/catalog/customtv/mix.json`) {
        return Response.json({ metas: [{ id: "mix1", type: "customtv", name: "Mixed One" }] });
      }
      return new Response("down", { status: 404 });
    };
  }

  async function snapshotHousehold() {
    installSnapshotNet();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const solo = (await registerFirstUser(db, "solo", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: solo.id, url: SNAP, position: 0, enabled: 1 });
    return { raw, db, soloId: solo.id };
  }

  function writeSnapshot(db: Db, profileId: string, body: Record<string, unknown>): Promise<void> {
    return writeSetting(db, `nuvio_home:${profileId}`, JSON.stringify(body));
  }

  it("drives order, titles, hides, types, and boxsets from the snapshot", async () => {
    const { raw, db, soloId } = await snapshotHousehold();
    await writeSnapshot(db, soloId, {
      hide_unreleased_content: false,
      show_catalog_type: true,
      items: [
        { addon_id: "snap", base: SNAP, type: "movie", catalog_id: "top", enabled: true, order: 1, custom_title: "Picks", is_collection: false, collection_id: "" },
        { addon_id: "snap", base: SNAP, type: "series", catalog_id: "top", enabled: false, order: 2, custom_title: "", is_collection: false, collection_id: "" },
        { addon_id: "snap", base: null, type: "", catalog_id: "", enabled: true, order: 3, custom_title: "", is_collection: true, collection_id: "col1" },
        { addon_id: "snap", base: SNAP, type: "customtv", catalog_id: "mix", enabled: true, order: 4, custom_title: "", is_collection: false, collection_id: "" },
      ],
      collections: [
        {
          id: "col1",
          title: "Trending",
          backdropImageUrl: null,
          folders: [{ id: "f1", title: "Hot Right Now", coverImageUrl: null, refs: [{ base: SNAP, type: "series", id: "top" }] }],
        },
      ],
    });
    const headers = authHeader(await liveToken(db, soloId));
    const app = createApp();
    const env = testEnv(raw);

    const views = (await (await callApp(app, env, `/Users/${soloId}/Views`, { headers })).json()) as {
      Items: { Id: string; Name: string; Type: string; CollectionType?: string }[];
      TotalRecordCount: number;
    };
    expect(views.TotalRecordCount).toBe(3);
    expect(views.Items.map((v) => v.Name)).toEqual(["Picks", "Mix", "Collections"]);
    const collectionsView = views.Items.find((v) => v.Name === "Collections");
    expect(collectionsView).toMatchObject({ Type: "CollectionFolder", CollectionType: "boxsets" });
    const mix = views.Items.find((v) => v.Name === "Mix");
    expect(mix?.CollectionType).toBeUndefined();

    const boxes = (await (await callApp(app, env, "/Items?IncludeItemTypes=BoxSet", { headers })).json()) as {
      Items: { Id: string; Name: string; Type: string; CollectionType?: string }[];
    };
    expect(boxes.Items.map((i) => [i.Name, i.Type, i.CollectionType])).toEqual([["Hot Right Now", "BoxSet", "tvshows"]]);

    const boxId = boxes.Items[0]?.Id ?? "";
    const detail = await callApp(app, env, `/Users/${soloId}/Items/${boxId}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ Type: "BoxSet", Name: "Hot Right Now", IsFolder: true });

    const children = (await (await callApp(app, env, `/Items?ParentId=${boxId}`, { headers })).json()) as {
      Items: { Name: string; Type: string }[];
    };
    expect(children.Items).toHaveLength(1);
    expect(children.Items[0]).toMatchObject({ Name: "Shared Show", Type: "Series" });

    const mixView = views.Items.find((v) => v.Name === "Mix");
    const mixPage = (await (
      await callApp(app, env, `/Users/${soloId}/Items?parentId=${mixView?.Id}`, { headers })
    ).json()) as { Items: { Name: string; Type: string }[] };
    expect(mixPage.Items[0]).toMatchObject({ Name: "Mixed One" });

    const search = (await (await callApp(app, env, "/Items?searchTerm=anything", { headers })).json()) as {
      Items: { Name: string }[];
    };
    expect(search.Items.map((i) => i.Name)).not.toContain("Shared Show");
  });

  it("keeps plain catalog names when show_catalog_type is off", async () => {
    const { raw, db, soloId } = await snapshotHousehold();
    await writeSnapshot(db, soloId, {
      hide_unreleased_content: false,
      show_catalog_type: false,
      items: [
        { addon_id: "snap", base: SNAP, type: "movie", catalog_id: "top", enabled: true, order: 1, custom_title: "", is_collection: false, collection_id: "" },
        { addon_id: "snap", base: SNAP, type: "customtv", catalog_id: "mix", enabled: true, order: 2, custom_title: "", is_collection: false, collection_id: "" },
      ],
      collections: [],
    });
    const headers = authHeader(await liveToken(db, soloId));
    const views = (await (await callApp(createApp(), testEnv(raw), `/Users/${soloId}/Views`, { headers })).json()) as {
      Items: { Name: string }[];
    };
    expect(views.Items.map((v) => v.Name)).toEqual(["Top", "Mix"]);
  });

  it("merges and dedupes multi-source boxset membership with paging", async () => {
    const { raw, db, soloId } = await snapshotHousehold();
    await writeSnapshot(db, soloId, {
      hide_unreleased_content: false,
      show_catalog_type: true,
      items: [
        { addon_id: "snap", base: null, type: "", catalog_id: "", enabled: true, order: 1, custom_title: "Duo", is_collection: true, collection_id: "col2" },
      ],
      collections: [
        {
          id: "col2",
          title: "Duo",
          backdropImageUrl: null,
          folders: [
            {
              id: "f2",
              title: "Merged",
              coverImageUrl: null,
              refs: [
                { base: SNAP, type: "movie", id: "top" },
                { base: SNAP, type: "series", id: "top" },
              ],
            },
          ],
        },
      ],
    });
    const headers = authHeader(await liveToken(db, soloId));
    const app = createApp();
    const env = testEnv(raw);
    const boxes = (await (await callApp(app, env, "/Items?IncludeItemTypes=BoxSet", { headers })).json()) as {
      Items: { Id: string; Name: string; Type: string }[];
    };
    const boxId = boxes.Items.find((v) => v.Type === "BoxSet")?.Id ?? "";
    expect(boxId).not.toBe("");

    const first = (await (
      await callApp(app, env, `/Items?ParentId=${boxId}&StartIndex=0&Limit=25`, { headers })
    ).json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(first.Items).toHaveLength(25);
    expect(first.Items[0]?.Name).toBe("Movie 1");

    const second = (await (
      await callApp(app, env, `/Items?ParentId=${boxId}&StartIndex=25&Limit=25`, { headers })
    ).json()) as { Items: { Name: string }[] };
    expect(second.Items).toHaveLength(6);
    expect(second.Items[5]?.Name).toBe("Shared Show");
  });

  it("honors hide_unreleased_content when the snapshot asks for it", async () => {
    const { raw, db, soloId } = await snapshotHousehold();
    await writeSnapshot(db, soloId, {
      hide_unreleased_content: true,
      show_catalog_type: true,
      items: [
        { addon_id: "snap", base: SNAP, type: "movie", catalog_id: "top", enabled: true, order: 1, custom_title: "", is_collection: false, collection_id: "" },
      ],
      collections: [],
    });
    const headers = authHeader(await liveToken(db, soloId));
    const app = createApp();
    const env = testEnv(raw);
    const views = (await (await callApp(app, env, `/Users/${soloId}/Views`, { headers })).json()) as {
      Items: { Id: string; Name: string }[];
    };
    const page = (await (
      await callApp(app, env, `/Users/${soloId}/Items?parentId=${views.Items[0]?.Id}`, { headers })
    ).json()) as { Items: { Name: string }[] };
    expect(page.Items).toHaveLength(29);
  });

  it("keeps long addon urls working through the snapshot", async () => {
    const LONG = `https://long.example/${"a".repeat(560)}`;
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
      if (url === `${LONG}/manifest.json`) {
        return Response.json({ catalogs: [{ type: "movie", id: "a", name: "Alpha" }] });
      }
      if (url === `${LONG}/catalog/movie/a.json`) {
        return Response.json({ metas: [{ id: "tt1", type: "movie", name: "Item A" }] });
      }
      return new Response("down", { status: 404 });
    };
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const solo = (await registerFirstUser(db, "solo", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: solo.id, url: LONG, position: 0, enabled: 1 });
    await writeSnapshot(db, solo.id, {
      hide_unreleased_content: false,
      show_catalog_type: false,
      items: [
        { addon_id: "long", base: LONG, type: "movie", catalog_id: "a", enabled: true, order: 0, custom_title: "Alpha Renamed", is_collection: false, collection_id: "" },
      ],
      collections: [],
    });
    const headers = authHeader(await liveToken(db, solo.id));
    const app = createApp();
    const env = testEnv(raw);
    const views = (await (await callApp(app, env, `/Users/${solo.id}/Views`, { headers })).json()) as {
      Items: { Id: string; Name: string }[];
    };
    expect(views.Items.map((v) => v.Name)).toEqual(["Alpha Renamed"]);
    const page = (await (
      await callApp(app, env, `/Users/${solo.id}/Items?parentId=${views.Items[0]?.Id}`, { headers })
    ).json()) as { Items: { Name: string }[] };
    expect(page.Items[0]?.Name).toBe("Item A");
  });
});
