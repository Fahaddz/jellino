import { describe, expect, it } from "vitest";
import { registerFirstUser } from "../src/auth";
import { readSetting, writeSetting } from "../src/db";
import { saveNuvioAccount, type NuvioAddon } from "../src/nuvio";
import { catalogDisplayName } from "../src/library";
import {
  deriveLibraryFromNuvio,
  mergeNuvioProgress,
  nuvioPullCollectionsRpc,
  nuvioPullHomeSettings,
  pushNuvioProgressFor,
  pushNuvioWatchedFor,
  type NuvioHomeSettings,
} from "../src/nuvio-home";
import { readWatchEntry, setPlayed, writeWatchPosition } from "../src/watch-state";
import { createFakeDb } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  return { raw, db, adminId: admin.id };
}

describe("nuvio home rpc", () => {
  it("pulls home settings via rpc", async () => {
    const mockFetch = (async (url: unknown) => {
      if (String(url).endsWith("/rpc/sync_pull_home_catalog_settings")) {
        return new Response(JSON.stringify({ settings_json: { items: [{ addon_id: "m", type: "movie", catalog_id: "top", enabled: true, order: 0, custom_title: "Top", is_collection: false, collection_id: "" }] } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await nuvioPullHomeSettings(mockFetch, "tok", 1);
    expect(res.ok).toBe(true);
    expect(res.home?.items).toHaveLength(1);
  });

  it("pushes progress and watched entries with nuvio shapes", async () => {
    const { db, adminId } = await household();
    const seen: { fn: string; body: Record<string, unknown> }[] = [];
    const mockFetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/auth/v1/token")) {
        return new Response(JSON.stringify({ access_token: "t", refresh_token: "r", expires_in: 3600, user: { id: "u1", email: "a@b.c" } }), { status: 200 });
      }
      if (target.includes("/rpc/sync_push_")) {
        seen.push({ fn: target.split("/rpc/")[1] ?? "", body: JSON.parse((init?.body as string) ?? "{}") });
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    await saveNuvioAccount(db, {
      email: "a@b.c",
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });
    await db
      .prepare("UPDATE profiles SET nuvio_profile_id = ?, nuvio_profile_index = ? WHERE id = ?")
      .bind("np-9", 2, adminId)
      .run();
    const now = Math.floor(Date.now() / 1000);
    expect(await pushNuvioProgressFor(db, mockFetch, adminId, "movie:tt100", 6000000000, 7200000000, now)).toBe(true);
    expect(await pushNuvioProgressFor(db, mockFetch, adminId, "movie:tmdb:99", 1, 7200000000, now)).toBe(false);
    expect(await pushNuvioProgressFor(db, mockFetch, adminId, "movie:tt100", 1, null, now)).toBe(false);
    expect(await pushNuvioWatchedFor(db, mockFetch, adminId, "episode:tt200:1:2", now)).toBe(true);
    const progress = seen.find((s) => s.fn === "sync_push_watch_progress");
    expect(progress?.body.p_profile_id).toBe(2);
    const entries = progress?.body.p_entries as { content_id: string; position: number; progress_key: string }[];
    expect(entries[0]).toMatchObject({ content_id: "tt100", position: 600000, progress_key: "tt100" });
    const watched = seen.find((s) => s.fn === "sync_push_watched_items");
    const items = watched?.body.p_items as { content_id: string; season: number; episode: number }[];
    expect(items[0]).toMatchObject({ content_id: "tt200", season: 1, episode: 2 });
  });

  it("imports small nuvio progress that jellyfin's old minimum used to drop", async () => {
    const { db } = await household();
    await saveNuvioAccount(db, {
      email: "a@b.c",
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });
    const admin = (await db.prepare("SELECT id FROM profiles LIMIT 1").first<{ id: string }>())!;
    const now = Math.floor(Date.now() / 1000);
    await mergeNuvioProgress(db, admin.id, [
      { content_id: "tt100", content_type: "movie", video_id: "tt100", season: null, episode: null, position: 30000, duration: 2700000, last_watched: now * 1000, progress_key: "tt100" },
    ], now);
    expect((await readWatchEntry(db, admin.id, "movie:tt100"))?.positionTicks).toBe(300_000_000);
    expect((await readWatchEntry(db, admin.id, "movie:tt100"))?.played).toBe(0);
  });

  it("keeps newer local watch state over older nuvio progress", async () => {
    const { db } = await household();
    await saveNuvioAccount(db, {
      email: "a@b.c",
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });
    const admin = (await db.prepare("SELECT id FROM profiles LIMIT 1").first<{ id: string }>())!;
    const now = Math.floor(Date.now() / 1000);
    await writeWatchPosition(db, admin.id, "movie:tt100", 9000000000, now);
    await mergeNuvioProgress(db, admin.id, [
      { content_id: "tt100", content_type: "movie", video_id: "tt100", season: null, episode: null, position: 1000, duration: 3600000, last_watched: (now - 3600) * 1000, progress_key: "tt100" },
    ], now);
    expect((await readWatchEntry(db, admin.id, "movie:tt100"))?.positionTicks).toBe(9000000000);
  });

  it("does not resurrect a locally played item from older nuvio progress", async () => {
    const { db } = await household();
    await saveNuvioAccount(db, {
      email: "a@b.c",
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });
    const admin = (await db.prepare("SELECT id FROM profiles LIMIT 1").first<{ id: string }>())!;
    const now = Math.floor(Date.now() / 1000);
    await writeWatchPosition(db, admin.id, "movie:tt100", 6000000000, now - 30);
    await setPlayed(db, admin.id, "movie:tt100", true, now);
    await mergeNuvioProgress(db, admin.id, [
      { content_id: "tt100", content_type: "movie", video_id: "tt100", season: null, episode: null, position: 600000, duration: 3600000, last_watched: (now - 5) * 1000, progress_key: "tt100" },
    ], now);
    const entry = await readWatchEntry(db, admin.id, "movie:tt100");
    expect(entry?.played).toBe(1);
    expect(entry?.positionTicks).toBe(6000000000);
  });
});

describe("nuvio library derivation", () => {
  const addonUrl = "https://addon.example";

  function homeWith(nuvioHiddenEnabled: boolean): NuvioHomeSettings {
    return {
      hide_unreleased_content: false,
      items: [
        { addon_id: addonUrl, type: "movie", catalog_id: "keep", enabled: true, order: 0, custom_title: "", is_collection: false, collection_id: "" },
        { addon_id: addonUrl, type: "movie", catalog_id: "fromNuvio", enabled: nuvioHiddenEnabled, order: 1, custom_title: "", is_collection: false, collection_id: "" },
      ],
    };
  }

  const addons: NuvioAddon[] = [{ url: addonUrl, name: "Addon", enabled: true, sort_order: 0 }];

  async function snapshotFor(db: Db, profileId: string): Promise<Record<string, any> | null> {
    const raw = await readSetting(db, `nuvio_home:${profileId}`);
    return raw ? (JSON.parse(raw) as Record<string, any>) : null;
  }

  it("writes one snapshot with resolved bases and enabled flags", async () => {
    const { db, adminId } = await household();
    await deriveLibraryFromNuvio(db, fetch, null, adminId, homeWith(false), null, addons);
    const snap = await snapshotFor(db, adminId);
    expect(snap).toMatchObject({ hide_unreleased_content: false, show_catalog_type: true });
    expect(snap?.items.map((i: Record<string, unknown>) => [i.catalog_id, i.base, i.enabled])).toEqual([
      ["keep", addonUrl, true],
      ["fromNuvio", addonUrl, false],
    ]);

    await deriveLibraryFromNuvio(db, fetch, null, adminId, homeWith(true), null, addons);
    const again = await snapshotFor(db, adminId);
    expect(again?.items.map((i: Record<string, unknown>) => i.enabled)).toEqual([true, true]);
  });

  it("carries flags, order, and collection folders into the snapshot", async () => {
    const { db, adminId } = await household();
    const collections = [
      {
        id: "col-1",
        title: "Mix",
        backdropImageUrl: null,
        folders: [
          {
            id: "f1",
            title: "F",
            coverImageUrl: "https://art.example/f.jpg",
            catalogSources: [
              { addonId: addonUrl, type: "movie", catalogId: "keep" },
              { addonId: "unknown-addon-id", type: "series", catalogId: "shows" },
            ],
          },
        ],
      },
    ];
    await deriveLibraryFromNuvio(
      db,
      fetch,
      null,
      adminId,
      {
        hide_unreleased_content: true,
        items: [
          { addon_id: addonUrl, type: "movie", catalog_id: "keep", enabled: true, order: 5, custom_title: "Picks", is_collection: false, collection_id: "" },
          { addon_id: "", type: "", catalog_id: "", enabled: true, order: 9, custom_title: "", is_collection: true, collection_id: "col-1" },
        ],
      },
      collections,
      addons,
    );
    const snap = await snapshotFor(db, adminId);
    expect(snap?.hide_unreleased_content).toBe(true);
    expect(snap?.items.map((i: Record<string, unknown>) => i.order)).toEqual([5, 9]);
    expect(snap?.items[0]).toMatchObject({ custom_title: "Picks", is_collection: false });
    expect(snap?.items[1]).toMatchObject({ is_collection: true, collection_id: "col-1" });
    expect(snap?.collections[0]).toMatchObject({ id: "col-1", title: "Mix" });
    const folder = snap?.collections[0].folders[0];
    expect(folder.id).toBe("f1");
    expect(folder.coverImageUrl).toBe("https://art.example/f.jpg");
    expect(folder.refs.map((r: Record<string, unknown>) => [r.type, r.id, r.base])).toEqual([
      ["movie", "keep", addonUrl],
    ]);
  });

  it("isolates profiles and skips items from foreign addons or missing catalogs", async () => {
    const { db, adminId } = await household();
    const installedUrl = "https://my-movies.example";
    const installedAddons: NuvioAddon[] = [{ url: installedUrl, name: "Movies", enabled: true, sort_order: 0 }];
    const mockFetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("my-movies.example/manifest.json")) {
        return new Response(JSON.stringify({
          id: "org.example.mymovies",
          name: "My Movies",
          catalogs: [
            { type: "movie", id: "popular", name: "Popular Movies" },
          ],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await deriveLibraryFromNuvio(
      db,
      mockFetch,
      null,
      adminId,
      {
        hide_unreleased_content: false,
        items: [
          { addon_id: "org.example.mymovies", type: "movie", catalog_id: "popular", enabled: true, order: 0, custom_title: "", is_collection: false, collection_id: "" },
          { addon_id: "org.example.mymovies", type: "movie", catalog_id: "ghost_catalog", enabled: true, order: 1, custom_title: "", is_collection: false, collection_id: "" },
          { addon_id: "foreign.iptv.addon", type: "tv", catalog_id: "iptv_channels", enabled: true, order: 2, custom_title: "", is_collection: false, collection_id: "" },
        ],
      },
      null,
      installedAddons,
    );

    const snap = await snapshotFor(db, adminId);
    expect(snap?.items).toHaveLength(1);
    expect(snap?.items[0]).toMatchObject({
      addon_id: "org.example.mymovies",
      base: installedUrl,
      type: "movie",
      catalog_id: "popular",
    });
  });

  it("queries only the specified profileIndex and does not probe other profiles", async () => {
    const requestedProfiles: number[] = [];
    const mockFetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/rpc/sync_pull_home_catalog_settings") || target.endsWith("/rpc/sync_pull_collections")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        requestedProfiles.push(body.p_profile_id);
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await nuvioPullHomeSettings(mockFetch, "tok", 1);
    await nuvioPullCollectionsRpc(mockFetch, "tok", 1);
    expect(requestedProfiles).toEqual([1, 1]);
  });

  it("composes catalog titles from the snapshot at view time", () => {
    expect(catalogDisplayName("Top", "movies", true, false)).toBe("Top - Movies");
    expect(catalogDisplayName("Top", "tvshows", true, false)).toBe("Top - Shows");
    expect(catalogDisplayName("Top", "movies", false, true)).toBe("Top Movies");
    expect(catalogDisplayName("Top", "movies", false, false)).toBe("Top");
    expect(catalogDisplayName("Top", "mixed", true, true)).toBe("Top");
  });
});
