import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { writeSetting } from "../src/db";
import { issueToken } from "../src/session";
import { catalogBases } from "../src/library";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const GOOD = "https://good.example";
const DEAD = "https://dead.example";
const STREAMS = "https://streams.example";

function installAddonNet() {
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
    if (url === `${GOOD}/manifest.json`) {
      return new Response(
        JSON.stringify({
          id: "good.addon",
          name: "Good Streams",
          description: "Movies and shows from Good",
          resources: ["catalog", "meta", "stream", "subtitles"],
          types: ["movie", "series", "music"],
          catalogs: [
            { type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] },
            { type: "series", id: "top", name: "Top" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${STREAMS}/manifest.json`) {
      return new Response(
        JSON.stringify({
          id: "streams.only",
          name: "Streams Only",
          description: "Stream lookups only",
          resources: ["stream"],
          types: ["movie"],
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
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("addon describe", () => {
  it("surfaces manifest names, descriptions, resources, and health", async () => {
    installAddonNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    raw.addons.push(
      { profile_id: adminId, url: GOOD, position: 0, enabled: 1 },
      { profile_id: adminId, url: DEAD, position: 1, enabled: 1 },
    );

    const res = await callApp(app, env, `/api/admin/profiles/${adminId}/addons`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { addons: Record<string, unknown>[] };
    const good = body.addons.find((a) => a.url === GOOD) as Record<string, unknown>;
    expect(good).toMatchObject({
      name: "Good Streams",
      manifestName: "Good Streams",
      description: "Movies and shows from Good",
      kind: "stremio",
      ok: true,
    });
    expect(good.resources as string[]).toEqual(expect.arrayContaining(["catalog", "meta", "stream", "subtitles", "search"]));
    expect(good.types as string[]).toEqual(["movie", "series"]);
    expect((good.types as string[]).includes("music")).toBe(false);
    const dead = body.addons.find((a) => a.url === DEAD) as Record<string, unknown>;
    expect(dead.ok).toBe(false);
    expect(dead.resources as string[]).toEqual([]);
    expect(dead.types as string[]).toEqual([]);
  });

  it("prefers custom labels but keeps manifest fields", async () => {
    installAddonNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    raw.addons.push({ profile_id: adminId, url: GOOD, position: 0, enabled: 1 });
    await writeSetting(db, "addon_labels", JSON.stringify({ [`${adminId}|${GOOD}`]: "Mine" }));

    const res = await callApp(app, env, `/api/admin/profiles/${adminId}/addons`, { headers: authHeader(token) });
    const body = (await res.json()) as { addons: Record<string, unknown>[] };
    expect(body.addons[0]).toMatchObject({ name: "Mine", manifestName: "Good Streams", description: "Movies and shows from Good", ok: true });
  });

  it("marks stream-only manifests healthy with no catalogs", async () => {
    installAddonNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    raw.addons.push({ profile_id: adminId, url: STREAMS, position: 0, enabled: 1 });

    const res = await callApp(app, env, `/api/admin/profiles/${adminId}/addons`, { headers: authHeader(token) });
    const body = (await res.json()) as { addons: Record<string, unknown>[] };
    expect(body.addons[0]).toMatchObject({ manifestName: "Streams Only", ok: true });
    expect(body.addons[0]?.resources as string[]).toEqual(["stream"]);
    expect(body.addons[0]?.types as string[]).toEqual(["movie"]);
  });

  it("matches suffixed pastes to manifests", async () => {
    installAddonNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    raw.addons.push({ profile_id: adminId, url: `${GOOD}/manifest.json`, position: 0, enabled: 1 });

    const res = await callApp(app, env, `/api/admin/profiles/${adminId}/addons`, { headers: authHeader(token) });
    const body = (await res.json()) as { addons: Record<string, unknown>[] };
    expect(body.addons[0]).toMatchObject({ manifestName: "Good Streams", ok: true });
  });
  it("serves the primary addons to profiles that follow primary addons", async () => {
    installAddonNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    raw.addons.push({ profile_id: adminId, url: GOOD, position: 0, enabled: 1 });
    raw.profiles.push({
      id: "kid", name: "kid", password_hash: "", salt: "", is_admin: 0,
      addon_mode: "custom", uses_primary_addons: 1, created_at: 2000,
    });

    expect(await catalogBases(db, "kid")).toEqual([GOOD]);
    void app;
    void env;
    void token;
  });
});
