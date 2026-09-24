import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { authenticateByName, issueToken } from "../src/session";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.profiles.push({ id: "kid", name: "kid", password_hash: "", salt: "", is_admin: 0, addon_mode: "custom", created_at: 2000 });
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

describe("profile administration", () => {
  it("lists Nuvio-imported profiles", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const listed = await callApp(app, env, "/api/admin/profiles", { headers: authHeader(token) });
    expect(listed.status).toBe(200);
    const names = ((await listed.json()) as { Profiles: { name: string }[] }).Profiles.map((p) => p.name);
    expect(names).toContain("dad");
    expect(names).toContain("kid");
  });

  it("sets a profile password and revokes the old token", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const kidToken = await liveToken(db, "kid");
    const app = createApp();
    const env = testEnv(raw);

    const before = await callApp(app, env, "/Users/kid/Views", { headers: authHeader(kidToken) });
    expect(before.status).not.toBe(401);

    const saved = adminPost("/api/admin/profiles/kid/password", token, { password: "kidsecret1" });
    const res = await callApp(app, env, saved.path, saved.init);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("kid");

    const login = await authenticateByName(db, "jellino", "kid", "kidsecret1", "9.9.9.9", 3000);
    expect(login.status).toBe(200);

    const after = await callApp(app, env, "/Users/kid/Views", { headers: authHeader(kidToken) });
    expect(after.status).toBe(401);
  });

  it("rejects short passwords, unknown profiles, and anonymous callers", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const short = adminPost("/api/admin/profiles/kid/password", token, { password: "short" });
    expect((await callApp(app, env, short.path, short.init)).status).toBe(400);

    const ghost = adminPost("/api/admin/profiles/ghost/password", token, { password: "ghostsecret1" });
    expect((await callApp(app, env, ghost.path, ghost.init)).status).toBe(404);

    const anon = adminPost("/api/admin/profiles/kid/password", null, { password: "kidsecret1" });
    expect((await callApp(app, env, anon.path, anon.init)).status).toBe(401);
  });
});

describe("per-profile addon management", () => {
  it("reads the addon list back without writes", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    raw.addons.push({ profile_id: "kid", url: "https://one.example", position: 0, enabled: 1 });

    const read = await callApp(app, env, "/api/admin/profiles/kid/addons", { headers: authHeader(token) });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: "kid",
      addonMode: "custom",
      addons: [{ url: "https://one.example", enabled: true, position: 0, name: "" }],
    });

    const ghost = await callApp(app, env, "/api/admin/profiles/ghost/addons", { headers: authHeader(token) });
    expect(ghost.status).toBe(404);
  });

  it("lists system built-ins in the addon list and describes manifests", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const read = await callApp(app, env, `/api/admin/profiles/${adminId}/addons`, { headers: authHeader(token) });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      builtins: { id: string; system: boolean; enabled: boolean }[];
      addons: unknown[];
    };
    expect(body.builtins).toEqual([]);
    expect(body.addons).toEqual([]);
  });
});

describe("per-profile library visibility and inheritance", () => {
  it("reads and toggles library visibility with inheritance to following profiles", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    raw.profiles.push({
      id: "child",
      name: "child",
      password_hash: "",
      salt: "",
      is_admin: 0,
      addon_mode: "follow_primary",
      uses_primary_addons: 1,
      created_at: 2500,
    });

    const snapshot = {
      hide_unreleased_content: false,
      show_catalog_type: true,
      items: [
        {
          addon_id: "cinemeta",
          base: "https://v3-cinemeta.strem.io",
          type: "movie",
          catalog_id: "top",
          enabled: true,
          order: 0,
          custom_title: "Top Movies",
          is_collection: false,
          collection_id: "",
        },
        {
          addon_id: "cinemeta",
          base: "https://v3-cinemeta.strem.io",
          type: "series",
          catalog_id: "top",
          enabled: true,
          order: 1,
          custom_title: "Top Series",
          is_collection: false,
          collection_id: "",
        },
      ],
      collections: [],
    };
    raw.settings.set(`nuvio_home:${adminId}`, JSON.stringify(snapshot));

    const adminLibs = await callApp(app, env, `/api/admin/profiles/${adminId}/libraries`, { headers: authHeader(token) });
    expect(adminLibs.status).toBe(200);
    const adminData = (await adminLibs.json()) as { followsPrimary: boolean; items: { key: string; name: string; enabled: boolean }[] };
    expect(adminData.followsPrimary).toBe(false);
    expect(adminData.items.length).toBe(2);
    expect(adminData.items[0]?.enabled).toBe(true);

    const childLibs = await callApp(app, env, `/api/admin/profiles/child/libraries`, { headers: authHeader(token) });
    expect(childLibs.status).toBe(200);
    const childData = (await childLibs.json()) as { followsPrimary: boolean; items: { key: string; name: string; enabled: boolean }[] };
    expect(childData.followsPrimary).toBe(true);
    expect(childData.items.length).toBe(2);

    const toggle = adminPost(
      `/api/admin/profiles/${adminId}/libraries`,
      token,
      { key: "cinemeta:movie:top", enabled: false },
      "PUT",
    );
    const putRes = await callApp(app, env, toggle.path, toggle.init);
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ ok: true });

    const childAfter = await callApp(app, env, `/api/admin/profiles/child/libraries`, { headers: authHeader(token) });
    const childAfterData = (await childAfter.json()) as { items: { key: string; enabled: boolean }[] };
    expect(childAfterData.items.find((i) => i.key === "cinemeta:movie:top")?.enabled).toBe(false);
    expect(childAfterData.items.find((i) => i.key === "cinemeta:series:top")?.enabled).toBe(true);

    const customKid = await callApp(app, env, `/api/admin/profiles/kid/libraries`, { headers: authHeader(token) });
    expect(customKid.status).toBe(200);
    const customKidData = (await customKid.json()) as { followsPrimary: boolean };
    expect(customKidData.followsPrimary).toBe(false);
  });

  it("filters out ghost catalogs and uninstalled addon items from profile libraries", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    raw.addons.push({
      profile_id: adminId,
      url: "https://v3-cinemeta.strem.io",
      position: 0,
      enabled: 1,
    });

    const snapshot = {
      hide_unreleased_content: false,
      show_catalog_type: true,
      items: [
        {
          addon_id: "cinemeta",
          base: "https://v3-cinemeta.strem.io",
          type: "movie",
          catalog_id: "top",
          enabled: true,
          order: 0,
          custom_title: "Top Movies",
          is_collection: false,
          collection_id: "",
        },
        {
          addon_id: "iptv-addon",
          base: "https://iptv.example.com",
          type: "tv",
          catalog_id: "iptv_channels",
          enabled: true,
          order: 1,
          custom_title: "Live TV",
          is_collection: false,
          collection_id: "",
        },
        {
          addon_id: "cinemeta",
          base: "https://v3-cinemeta.strem.io",
          type: "movie",
          catalog_id: "ghost_catalog_nonexistent",
          enabled: true,
          order: 2,
          custom_title: "Ghost",
          is_collection: false,
          collection_id: "",
        },
      ],
      collections: [],
    };
    raw.settings.set(`nuvio_home:${adminId}`, JSON.stringify(snapshot));

    const adminLibs = await callApp(app, env, `/api/admin/profiles/${adminId}/libraries`, { headers: authHeader(token) });
    expect(adminLibs.status).toBe(200);
    const adminData = (await adminLibs.json()) as { items: { key: string; name: string }[] };
    expect(adminData.items).toHaveLength(1);
    expect(adminData.items[0]?.key).toBe("cinemeta:movie:top");
  });
});

