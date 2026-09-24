import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { authenticateByName, issueToken } from "../src/session";
import { callApp, createFakeDb, testEnv } from "./fake-db";
import {
  nuvioSignIn,
  nuvioPullAddons,
  saveNuvioAccount,
  readNuvioAccount,
  removeNuvioAccount,
  getValidNuvioToken,
  type NuvioProfile,
  type NuvioAddon,
  type WatchProgressSyncEntry,
  type WatchedSyncItem,
  type LibrarySyncItem,
} from "../src/nuvio";
import { pushNuvioFavoriteFor, pushNuvioProgressFor, pushNuvioWatchedFor, syncFromNuvio, syncProfileFromNuvio } from "../src/nuvio-home";
import { profileCollections } from "../src/library";
import { encodeItem } from "../src/ids";

type Db = import("@cloudflare/workers-types").D1Database;

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

function adminPost(path: string, token: string | null, body: unknown, method = "POST") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["X-Emby-Authorization"] = `MediaBrowser Client="test", Token="${token}"`;
  return { path, init: { method, headers, body: JSON.stringify(body) } };
}

describe("nuvio integration and profile sync", () => {
  it("authenticates with nuvio api", async () => {
    const mockFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/auth/v1/token")) {
        const body = JSON.parse(init?.body as string);
        if (body.email === "test@example.com" && body.password === "correct") {
          return new Response(
            JSON.stringify({
              access_token: "mock-access-token",
              refresh_token: "mock-refresh-token",
              expires_in: 3600,
              user: { id: "nuvio-user-1", email: "test@example.com" },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ msg: "Invalid login credentials" }), { status: 400 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const good = await nuvioSignIn(mockFetch, "test@example.com", "correct");
    expect(good.ok).toBe(true);
    expect(good.session?.access_token).toBe("mock-access-token");

    const bad = await nuvioSignIn(mockFetch, "test@example.com", "wrong");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Invalid login");
  });

  it("persists nuvio account and syncs profiles, addons, and collections", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const mockProfiles: NuvioProfile[] = [
      {
        id: "np-1",
        user_id: "nuvio-user-1",
        profile_index: 0,
        name: "Dad",
        avatar_color_hex: "#3b82f6",
        uses_primary_addons: false,
      },
      {
        id: "np-2",
        user_id: "nuvio-user-1",
        profile_index: 1,
        name: "Mom",
        avatar_color_hex: "#ec4899",
        uses_primary_addons: true,
      },
      {
        id: "np-3",
        user_id: "nuvio-user-1",
        profile_index: 2,
        name: "Kids",
        avatar_color_hex: "#10b981",
        uses_primary_addons: false,
      },
    ];

    const mockAddons: NuvioAddon[] = [
      {
        profile_id: 0,
        url: "https://addon-primary.example/manifest.json",
        name: "Torrentio Primary",
        enabled: true,
        sort_order: 0,
      },
      {
        profile_id: 2,
        url: "https://addon-kids.example/manifest.json",
        name: "Anime Addon",
        enabled: true,
        sort_order: 0,
      },
    ];

    const mockFetch = (async (url: string) => {
      if (url.includes("/auth/v1/token")) {
        return new Response(
          JSON.stringify({
            access_token: "mock-access-token",
            refresh_token: "mock-refresh-token",
            expires_in: 3600,
            user: { id: "nuvio-user-1", email: "user@nuvio.tv" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/rest/v1/profiles")) {
        return new Response(JSON.stringify(mockProfiles), { status: 200 });
      }
      if (url.includes("/rest/v1/profile_addons")) {
        return new Response(JSON.stringify(mockAddons), { status: 200 });
      }
      if (url.includes("/rest/v1/collections")) {
        return new Response(JSON.stringify([{ id: "col-1", title: "Trending" }]), { status: 200 });
      }
      if (url.includes("/rest/v1/profile_watch_progress") || url.includes("/rest/v1/profile_watched") || url.includes("/rest/v1/profile_library") || url.includes("/rest/v1/profile_locks")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "mock-token",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    const syncResult = await syncFromNuvio(db, mockFetch, { force: true });
    expect(syncResult.ok).toBe(true);
    expect(syncResult.profilesCount).toBe(3);

    const profilesRes = await callApp(app, env, "/api/admin/profiles", { headers: authHeader(token) });
    expect(profilesRes.status).toBe(200);
    const profilesBody = (await profilesRes.json()) as { Profiles: { id: string; name: string; hasPassword: boolean; nuvioProfileId: string; avatarColorHex: string }[] };
    expect(profilesBody.Profiles).toHaveLength(3);

    const mom = profilesBody.Profiles.find((p) => p.name === "Mom")!;
    expect(mom).toBeDefined();
    expect(mom.hasPassword).toBe(false);
    expect(mom.avatarColorHex).toBe("#ec4899");

    const momLogin = await authenticateByName(db, "test-server", "Mom", "", "127.0.0.1", 2000);
    expect(momLogin.ok).toBe(false);
    expect(momLogin.status).toBe(401);
    expect(momLogin.body.error).toBe("password required");

    const setPass = adminPost(`/api/admin/profiles/${mom.id}/password`, token, { password: "momsecret123" });
    const passRes = await callApp(app, env, setPass.path, setPass.init);
    expect(passRes.status).toBe(200);

    const emptyFail = await authenticateByName(db, "test-server", "Mom", "", "127.0.0.1", 2001);
    expect(emptyFail.ok).toBe(false);
    expect(emptyFail.status).toBe(401);

    const correctPass = await authenticateByName(db, "test-server", "Mom", "momsecret123", "127.0.0.1", 2002);
    expect(correctPass.ok).toBe(true);

    const momAddons = await db.prepare("SELECT url FROM profile_addons WHERE profile_id = ?").bind(mom.id).all<{ url: string }>();
    expect(momAddons.results?.map((a) => a.url)).toContain("https://addon-primary.example/manifest.json");

    const kids = profilesBody.Profiles.find((p) => p.name === "Kids")!;
    const kidsAddons = await db.prepare("SELECT url FROM profile_addons WHERE profile_id = ?").bind(kids.id).all<{ url: string }>();
    expect(kidsAddons.results?.map((a) => a.url)).toContain("https://addon-kids.example/manifest.json");
  });

  it("handles admin nuvio status, sync, and disconnect endpoints", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const statusBefore = await callApp(app, env, "/api/admin/nuvio/status", { headers: authHeader(token) });
    expect(statusBefore.status).toBe(200);
    expect(await statusBefore.json()).toEqual({ connected: false });

    await saveNuvioAccount(db, {
      email: "streamer@nuvio.tv",
      access_token: "test-token",
      refresh_token: "test-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 1700000000,
    });

    const statusAfter = await callApp(app, env, "/api/admin/nuvio/status", { headers: authHeader(token) });
    expect(statusAfter.status).toBe(200);
    expect(await statusAfter.json()).toMatchObject({
      connected: true,
      email: "streamer@nuvio.tv",
      lastSync: 1700000000,
    });

    const disconnectReq = adminPost("/api/admin/nuvio/disconnect", token, {});
    const disconnectRes = await callApp(app, env, disconnectReq.path, disconnectReq.init);
    expect(disconnectRes.status).toBe(200);

    const statusFinal = await callApp(app, env, "/api/admin/nuvio/status", { headers: authHeader(token) });
    expect(statusFinal.status).toBe(200);
    expect(await statusFinal.json()).toEqual({ connected: false });
  });

  it("syncs watch progress bidirectionally between nuvio and jellino", async () => {
    const { raw, db, adminId } = await household();

    const pushedEntries: { profileId: number; entries: WatchProgressSyncEntry[] }[] = [];

    const mockFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/profiles")) {
        return new Response(
          JSON.stringify([
            {
              id: "np-1",
              user_id: "user-1",
              profile_index: 0,
              name: "Dad",
              avatar_color_hex: "#3b82f6",
              uses_primary_addons: false,
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/rest/v1/profile_addons")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/collections")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_watched")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_library")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_locks")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_watch_progress") && (!init || init.method === "GET" || !init.method)) {
        const entries: WatchProgressSyncEntry[] = [
          {
            content_id: "tt123456",
            content_type: "movie",
            video_id: "tt123456",
            season: null,
            episode: null,
            position: 150000,
            duration: 600000,
            last_watched: 1720000000000,
            progress_key: "tt123456",
          },
        ];
        return new Response(JSON.stringify(entries), { status: 200 });
      }
      if (url.endsWith("/rpc/sync_push_watch_progress")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { p_entries: WatchProgressSyncEntry[] };
        pushedEntries.push({ profileId: 0, entries: body.p_entries });
        return new Response("[]", { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "mock-token",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    const syncRes = await syncFromNuvio(db, mockFetch, { force: true });
    expect(syncRes.ok).toBe(true);

    const state = raw.watch.get(`${adminId}\nmovie:tt123456`);
    expect(state).toBeDefined();
    expect(state?.positionTicks).toBe(1500000000);
    expect(state?.played).toBe(0);

    await pushNuvioProgressFor(db, mockFetch, adminId, "movie:tt999999", 3000000000, 7200000000, Math.floor(Date.now() / 1000));
    expect(pushedEntries).toHaveLength(1);
    expect(pushedEntries[0]?.profileId).toBe(0);
    expect(pushedEntries[0]?.entries[0]?.content_id).toBe("tt999999");
    expect(pushedEntries[0]?.entries[0]?.position).toBe(300000);
  });

  it("serves custom avatar SVG with profile color", async () => {
    const { raw, db, adminId } = await household();
    const app = createApp();
    const env = testEnv(raw);

    await db.prepare("UPDATE profiles SET avatar_color_hex = ? WHERE id = ?").bind("#e11d48", adminId).run();

    const res = await callApp(app, env, `/Users/${adminId}/Images/Primary`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    const svg = await res.text();
    expect(svg).toContain('fill="#e11d48"');
  });

  it("syncs fully watched items bidirectionally with nuvio", async () => {
    const { raw, db, adminId } = await household();
    await db.prepare("UPDATE profiles SET nuvio_profile_index = 0 WHERE id = ?").bind(adminId).run();

    const pushedWatched: { profileId: number; items: WatchedSyncItem[] }[] = [];
    const mockFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/profile_watched") && (!init || init.method === "GET" || !init.method)) {
        const items: WatchedSyncItem[] = [
          {
            content_id: "tt888888",
            content_type: "movie",
            watched_at: 1720000000000,
          },
        ];
        return new Response(JSON.stringify(items), { status: 200 });
      }
      if (url.endsWith("/rpc/sync_push_watched_items")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { p_items: WatchedSyncItem[] };
        pushedWatched.push({ profileId: 0, items: body.p_items });
        return new Response("[]", { status: 201 });
      }
      if (url.includes("/rest/v1/profiles")) {
        return new Response(JSON.stringify([{ id: "np-1", user_id: "u1", profile_index: 0, name: "Dad", uses_primary_addons: false }]), { status: 200 });
      }
      if (url.includes("/rest/v1/profile_addons") || url.includes("/rest/v1/collections") || url.includes("/rest/v1/profile_locks")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_watch_progress") || url.includes("/rest/v1/profile_library")) return new Response("[]", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "mock-token",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    const syncRes = await syncFromNuvio(db, mockFetch, { force: true });
    expect(syncRes.ok).toBe(true);

    const watchedState = raw.watch.get(`${adminId}\nmovie:tt888888`);
    expect(watchedState).toBeDefined();
    expect(watchedState?.played).toBe(1);

    await pushNuvioWatchedFor(db, mockFetch, adminId, "movie:tt777777", Math.floor(Date.now() / 1000));
    expect(pushedWatched).toHaveLength(1);
    expect(pushedWatched[0]?.profileId).toBe(0);
    expect(pushedWatched[0]?.items[0]?.content_id).toBe("tt777777");
  });

  it("syncs nuvio library and jellyfin favorites bidirectionally", async () => {
    const { raw, db, adminId } = await household();
    await db.prepare("UPDATE profiles SET nuvio_profile_index = 0 WHERE id = ?").bind(adminId).run();

    const pushedFavs: { profileId: number; items: LibrarySyncItem[] }[] = [];
    const mockFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/rest/v1/profile_library") && (!init || init.method === "GET" || !init.method)) {
        const items: LibrarySyncItem[] = [
          {
            content_id: "tt555555",
            content_type: "movie",
            name: "Favorite Movie",
            poster: "https://image.tmdb.org/t/p/w500/fav.jpg",
            added_at: 1720000000000,
          },
        ];
        return new Response(JSON.stringify(items), { status: 200 });
      }
      if (url.endsWith("/rpc/sync_push_library_items")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { p_items: LibrarySyncItem[] };
        pushedFavs.push({ profileId: 0, items: body.p_items });
        return new Response("[]", { status: 201 });
      }
      if (url.includes("/rest/v1/profiles")) {
        return new Response(JSON.stringify([{ id: "np-1", user_id: "u1", profile_index: 0, name: "Dad", uses_primary_addons: false }]), { status: 200 });
      }
      if (url.includes("/rest/v1/profile_addons") || url.includes("/rest/v1/collections") || url.includes("/rest/v1/profile_locks")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_watch_progress") || url.includes("/rest/v1/profile_watched")) return new Response("[]", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "mock-token",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    const syncRes = await syncFromNuvio(db, mockFetch, { force: true });
    expect(syncRes.ok).toBe(true);

    const fav = raw.favorites.get(`${adminId}\nmovie:tt555555`);
    expect(fav).toBeDefined();
    expect(fav?.name).toBe("Favorite Movie");

    await pushNuvioFavoriteFor(db, mockFetch, adminId, "movie:tt444444", { name: "Another Favorite", poster: "https://img/fav2.jpg" }, Math.floor(Date.now() / 1000));
    expect(pushedFavs).toHaveLength(1);
    expect(pushedFavs[0]?.profileId).toBe(0);
    expect(pushedFavs[0]?.items[0]?.content_id).toBe("tt444444");
    expect(pushedFavs[0]?.items[0]?.name).toBe("Another Favorite");
  });

  it("rejects passwordless profiles without the pin path", async () => {
    const { raw, db, adminId } = await household();
    await db.prepare("UPDATE profiles SET password_hash = '', salt = '', nuvio_profile_index = 0 WHERE id = ?").bind(adminId).run();
    const res = await authenticateByName(db, "jellino", "dad", "1234", "1.1.1.1", 1000);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toBe("password required");
    void raw;
  });

  it("serves nuvio collections as box sets from the snapshot", async () => {
    const { raw, db, adminId } = await household();
    const addonUrl = "https://addon.example";
    const snapshot = {
      hide_unreleased_content: false,
      show_catalog_type: true,
      items: [
        { addon_id: "addon", base: null, type: "", catalog_id: "", enabled: true, order: 0, custom_title: "", is_collection: true, collection_id: "col-action" },
      ],
      collections: [
        {
          id: "col-action",
          title: "Action Movies",
          backdropImageUrl: null,
          folders: [
            { id: "f1", title: "Top Action", coverImageUrl: null, refs: [{ base: addonUrl, type: "movie", id: "top" }] },
          ],
        },
      ],
    };
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(`nuvio_home:${adminId}`, JSON.stringify(snapshot)).run();

    const mockCache = {
      match: async () => null,
      put: async () => {},
    } as unknown as Cache;

    const boxes = await profileCollections(db, mockCache, fetch, adminId, "server-1");
    expect(boxes).toBeDefined();
    expect(boxes?.[0]).toMatchObject({ Name: "Top Action", Type: "BoxSet", CollectionType: "movies", IsFolder: true });
    void raw;
  });

  it("redirects profile avatar to nuvio avatar catalog URL", async () => {
    const { raw, db, adminId } = await household();
    const app = createApp();
    const env = testEnv(raw);

    const avatarUrl = "https://assets.nuvio.tv/avatars/avatar-42.png";
    await db.prepare("UPDATE profiles SET avatar_url = ? WHERE id = ?").bind(avatarUrl, adminId).run();

    const res = await callApp(app, env, `/Users/${adminId}/Images/Primary`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(avatarUrl);
  });

  it("handles 1-click initial setup via nuvio account", async () => {
    const raw = createFakeDb();
    const app = createApp();
    const env = testEnv(raw);

    const mockFetch = (async (url: string) => {
      if (url.includes("/auth/v1/token")) {
        return new Response(JSON.stringify({
          access_token: "setup-token-123",
          refresh_token: "setup-refresh-123",
          expires_in: 3600,
          user: { id: "user-1", email: "dad@nuvio.tv" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/rest/v1/profiles")) {
        return new Response(JSON.stringify([
          { profile_index: 0, name: "Dad", avatar_color_hex: "#7c5cff" },
          { profile_index: 1, name: "Mom", avatar_color_hex: "#ff5c7a" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const res = await callApp(app, env, "/api/setup/nuvio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dad@nuvio.tv", password: "mypassword123" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; token: string; user: { name: string; is_admin: boolean } };
      expect(data.ok).toBe(true);
      expect(data.user.name).toBe("Dad");
      expect(data.user.is_admin).toBe(true);
      expect(typeof data.token).toBe("string");

      const second = await callApp(app, env, "/api/setup/nuvio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dad@nuvio.tv", password: "mypassword123" }),
      });
      expect(second.status).toBe(403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("automatically refreshes nuvio token when receiving 401 and retries operation", async () => {
    const { raw, db, adminId } = await household();
    await db.prepare("UPDATE profiles SET nuvio_profile_index = 0 WHERE id = ?").bind(adminId).run();

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "expired-token",
      refresh_token: "valid-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    let refreshCalled = false;
    let pushAttempt = 0;

    const mockFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("/auth/v1/token")) {
        refreshCalled = true;
        return new Response(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
            user: { id: "u1", email: "user@nuvio.tv" },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/rpc/sync_push_watched_items")) {
        pushAttempt++;
        const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];
        if (authHeader === "Bearer expired-token") {
          return new Response(JSON.stringify({ message: "JWT expired" }), { status: 401 });
        }
        if (authHeader === "Bearer new-access-token") {
          return new Response("[]", { status: 201 });
        }
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await pushNuvioWatchedFor(db, mockFetch, adminId, "movie:tt999888", Math.floor(Date.now() / 1000));

    expect(pushAttempt).toBe(2);
    expect(refreshCalled).toBe(true);

    const saved = await readNuvioAccount(db);
    expect(saved?.access_token).toBe("new-access-token");
  });

  it("never re-authenticates with a stored password and gives up when refresh fails", async () => {
    const { db, adminId } = await household();
    void adminId;

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "expired-token",
      refresh_token: "dead-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) - 100,
      last_sync: 0,
    });

    const mockFetch = (async (url: string) => {
      if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const tokenRes = await getValidNuvioToken(db, mockFetch);
    expect(tokenRes).toBeNull();
  });

  it("isolates single profile sync to target profile only", async () => {
    const { raw, db, adminId } = await household();

    const childId = "child-profile-uuid";
    await db
      .prepare(
        "INSERT INTO profiles (id, name, password_hash, salt, is_admin, addon_mode, disabled, created_at, nuvio_profile_id, nuvio_profile_index, avatar_color_hex, avatar_url, uses_primary_addons) VALUES (?, ?, '', '', ?, 'custom', 0, ?, ?, ?, ?, ?, ?)",
      )
      .bind(childId, "Child", 0, 1000, "np-child", 1, "#10b981", null, 0, 0)
      .run();

    await db.prepare("UPDATE profiles SET nuvio_profile_index = 0 WHERE id = ?").bind(adminId).run();

    await db
      .prepare("INSERT INTO watch_state (profile_id, item_key, position_ticks, played, play_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(adminId, "movie:adminmovie", 5000000, 0, 0, 1000)
      .run();

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "mock-token",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    const mockFetch = (async (url: string) => {
      if (url.includes("/rest/v1/profile_addons")) {
        return new Response(
          JSON.stringify([
            { profile_id: 1, url: "https://child-addon.example/manifest.json", name: "Child Addon", enabled: true, sort_order: 0 },
            { profile_id: 0, url: "https://admin-addon.example/manifest.json", name: "Admin Addon", enabled: true, sort_order: 0 },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/rest/v1/profile_watch_progress?profile_id=eq.1")) {
        return new Response(
          JSON.stringify([
            {
              content_id: "ttchild123",
              content_type: "movie",
              video_id: "ttchild123",
              season: null,
              episode: null,
              position: 200000,
              duration: 500000,
              last_watched: 1720000000000,
              progress_key: "ttchild123",
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/rest/v1/profile_watched") || url.includes("/rest/v1/profile_library")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const singleSyncRes = await syncProfileFromNuvio(db, mockFetch, childId);
    expect(singleSyncRes.ok).toBe(true);

    const childWatch = raw.watch.get(`${childId}\nmovie:ttchild123`);
    expect(childWatch).toBeDefined();
    expect(childWatch?.positionTicks).toBe(2000000000);

    const adminWatch = raw.watch.get(`${adminId}\nmovie:adminmovie`);
    expect(adminWatch).toBeDefined();
    expect(adminWatch?.positionTicks).toBe(5000000);

    const adminChildWatch = raw.watch.get(`${adminId}\nmovie:ttchild123`);
    expect(adminChildWatch).toBeUndefined();

    const childAddons = await db.prepare("SELECT url FROM profile_addons WHERE profile_id = ?").bind(childId).all<{ url: string }>();
    expect(childAddons.results?.map((a) => a.url)).toEqual(["https://child-addon.example/manifest.json"]);
  });

  it("retries with exponential backoff on temporary 429 and 500 responses", async () => {
    let attempts = 0;
    const mockFetch = (async (url: string) => {
      attempts++;
      if (attempts === 1) {
        return new Response("Server error", { status: 503 });
      }
      if (attempts === 2) {
        return new Response("Rate limited", { status: 429, headers: { "retry-after": "0.01" } });
      }
      return new Response(
        JSON.stringify({
          access_token: "recovered-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
          user: { id: "u1", email: "user@nuvio.tv" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await nuvioSignIn(mockFetch, "user@nuvio.tv", "password123");
    expect(result.ok).toBe(true);
    expect(result.session?.access_token).toBe("recovered-token");
    expect(attempts).toBe(3);
  });

  it("pulls addons from /rest/v1/addons table and falls back to /rest/v1/profile_addons", async () => {
    let queriedAddons = false;
    let queriedProfileAddons = false;

    const mockFetch = (async (url: string) => {
      if (url.includes("/rest/v1/addons")) {
        queriedAddons = true;
        return new Response(JSON.stringify([
          { profile_id: 1, url: "https://addon-from-addons-table.example/manifest.json", name: "Addons Table", enabled: true, sort_order: 0 }
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await nuvioPullAddons(mockFetch, "token123");
    expect(res.ok).toBe(true);
    expect(queriedAddons).toBe(true);
    expect(res.addons?.[0]?.url).toBe("https://addon-from-addons-table.example/manifest.json");

    const mockFallbackFetch = (async (url: string) => {
      if (url.includes("/rest/v1/addons")) {
        return new Response("table not found", { status: 404 });
      }
      if (url.includes("/rest/v1/profile_addons")) {
        queriedProfileAddons = true;
        return new Response(JSON.stringify([
          { profile_id: 1, url: "https://addon-from-fallback.example/manifest.json", name: "Fallback Addon", enabled: true, sort_order: 0 }
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const fallbackRes = await nuvioPullAddons(mockFallbackFetch, "token123");
    expect(fallbackRes.ok).toBe(true);
    expect(queriedProfileAddons).toBe(true);
    expect(fallbackRes.addons?.[0]?.url).toBe("https://addon-from-fallback.example/manifest.json");
  });

  it("matches addons flexibly with 1-indexed (Nuvio production) and UUID profile_ids during sync", async () => {
    const { db } = await household();

    await saveNuvioAccount(db, {
      email: "user@nuvio.tv",
      access_token: "mock-access",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    const mockFetch = (async (url: string) => {
      if (url.includes("/rest/v1/profiles")) {
        return new Response(
          JSON.stringify([
            { id: "uuid-primary", user_id: "u1", profile_index: 0, name: "Primary", avatar_color_hex: "#3b82f6", uses_primary_addons: false },
            { id: "uuid-secondary", user_id: "u1", profile_index: 1, name: "Secondary", avatar_color_hex: "#10b981", uses_primary_addons: false },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/rest/v1/addons")) {
        return new Response(
          JSON.stringify([
            { profile_id: 1, url: "https://primary-1indexed.example/manifest.json", name: "Primary 1-indexed", enabled: true, sort_order: 0 },
            { profile_id: "uuid-primary", url: "https://primary-uuid.example/manifest.json", name: "Primary UUID", enabled: true, sort_order: 1 },
            { profile_id: 2, url: "https://secondary-1indexed.example/manifest.json", name: "Secondary 1-indexed", enabled: true, sort_order: 0 },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/rest/v1/collections")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_watch_progress") || url.includes("/rest/v1/profile_watched") || url.includes("/rest/v1/profile_library")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const syncRes = await syncFromNuvio(db, mockFetch, { force: true });
    expect(syncRes.ok).toBe(true);

    const primary = await db.prepare("SELECT id FROM profiles WHERE nuvio_profile_id = ?").bind("uuid-primary").first<{ id: string }>();
    const secondary = await db.prepare("SELECT id FROM profiles WHERE nuvio_profile_id = ?").bind("uuid-secondary").first<{ id: string }>();

    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();

    const primaryAddons = await db.prepare("SELECT url FROM profile_addons WHERE profile_id = ? ORDER BY position ASC").bind(primary!.id).all<{ url: string }>();
    expect(primaryAddons.results?.map((a) => a.url)).toEqual([
      "https://primary-1indexed.example/manifest.json",
      "https://primary-uuid.example/manifest.json",
    ]);

    const secondaryAddons = await db.prepare("SELECT url FROM profile_addons WHERE profile_id = ? ORDER BY position ASC").bind(secondary!.id).all<{ url: string }>();
    expect(secondaryAddons.results?.map((a) => a.url)).toEqual([
      "https://secondary-1indexed.example/manifest.json",
    ]);
  });

  it("resolves default nuvio avatar_id to public storage avatar url", async () => {
    const { resolveNuvioAvatarUrl } = await import("../src/nuvio");
    expect(resolveNuvioAvatarUrl({ avatar_id: "avatar_mikasa" })).toBe(
      "https://api.nuvio.tv/storage/v1/object/public/avatars/animals/otto-v1.png",
    );
    expect(resolveNuvioAvatarUrl({ avatar_id: "otto" })).toBe(
      "https://api.nuvio.tv/storage/v1/object/public/avatars/animals/otto-v1.png",
    );
    expect(resolveNuvioAvatarUrl({ avatar_id: "avatar_saitama" })).toBe(
      "https://api.nuvio.tv/storage/v1/object/public/avatars/animals/poppy-v1.png",
    );
    expect(resolveNuvioAvatarUrl({ avatar_id: "avatar_levi" })).toBe(
      "https://api.nuvio.tv/storage/v1/object/public/avatars/animals/pip-v1.png",
    );
    expect(resolveNuvioAvatarUrl({ avatar_id: "avatar_negan" })).toBe(
      "https://api.nuvio.tv/storage/v1/object/public/avatars/animals/miso-v1.png",
    );
    expect(resolveNuvioAvatarUrl({ avatar_url: "https://custom.example/pic.png", avatar_id: "avatar_mikasa" })).toBe(
      "https://custom.example/pic.png",
    );
  });
  it("imports all 6 profiles even when watch sync fails for some profiles", async () => {
    const { db } = await household();
    await saveNuvioAccount(db, {
      email: "family@nuvio.tv",
      access_token: "mock-token",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      last_sync: 0,
    });

    const mockProfiles = [0, 1, 2, 3, 4, 5].map((idx) => ({
      id: "np-" + idx,
      user_id: "u1",
      profile_index: idx,
      name: idx === 0 ? "dad" : "Member " + (idx + 1),
      avatar_color_hex: "#10b981",
      uses_primary_addons: false,
    }));

    const mockFetch = (async (url: string) => {
      if (url.includes("/rest/v1/profiles")) {
        return new Response(JSON.stringify(mockProfiles), { status: 200 });
      }
      if (url.includes("/rest/v1/profile_addons")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/collections")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/profile_watch_progress")) {
        return new Response(JSON.stringify({ error: "temporary watch failure" }), { status: 500 });
      }
      if (url.includes("/rest/v1/profile_watched") || url.includes("/rest/v1/profile_library")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const syncRes = await syncFromNuvio(db, mockFetch, { force: true });
    expect(syncRes.ok).toBe(true);
    expect(syncRes.profilesCount).toBe(6);

    const rows = await db.prepare("SELECT id, name, nuvio_profile_id, nuvio_profile_index, is_admin FROM profiles").all<{ id: string; name: string }>();
    expect(rows.results?.length).toBe(6);
  });

  it("falls back to select=* when nuvioPullProfiles gets 400 on specific columns", async () => {
    let attemptedFallback = false;
    const mockFetch = (async (url: string) => {
      if (url.includes("select=id,user_id")) {
        return new Response(JSON.stringify({ code: "PGRST100", message: "column not found" }), { status: 400 });
      }
      if (url.includes("select=*")) {
        attemptedFallback = true;
        return new Response(JSON.stringify([
          { id: "np-fb", user_id: "u1", profile_index: 0, name: "FallbackUser", avatar_color_hex: "#3b82f6" }
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { nuvioPullProfiles } = await import("../src/nuvio");
    const res = await nuvioPullProfiles(mockFetch, "token");
    expect(res.ok).toBe(true);
    expect(attemptedFallback).toBe(true);
    expect(res.profiles?.[0]?.name).toBe("FallbackUser");
  });
});
