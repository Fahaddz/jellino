import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeItem } from "../src/ids";
import { recordAddonResult } from "../src/health";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const GOOD = "https://good.example";
const BAD = "https://bad.example";

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
    if (url === `${GOOD}/stream/movie/tt100.json`) {
      return new Response(JSON.stringify({ streams: [{ url: "https://cdn.example/a.mp4" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `${GOOD}/subtitles/movie/tt100.json`) {
      return new Response(JSON.stringify({ subtitles: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/meta/movie/tt100.json") && url.startsWith(GOOD)) {
      return new Response(JSON.stringify({ meta: { id: "tt100", type: "movie", name: "Film" } }), {
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
  raw.addons.push(
    { profile_id: admin.id, url: GOOD, position: 0, enabled: 1 },
    { profile_id: admin.id, url: BAD, position: 1, enabled: 1 },
  );
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("usage and health", () => {
  it("flags unhealthy addons with their failure counts", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(GOOD, "movie", "tt100");
    const playback = {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    };

    await callApp(app, env, `/Users/${adminId}/Items/${id}/PlaybackInfo`, playback);
    installNet();
    await callApp(app, env, `/Users/${adminId}/Items/${id}/PlaybackInfo`, playback);
    installNet();
    await callApp(app, env, `/Users/${adminId}/Items/${id}/PlaybackInfo`, playback);

    const res = await callApp(app, env, "/api/admin/usage", { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      Health: { addonUrl: string; fails: number }[];
    };
    expect(body.Health).toHaveLength(1);
    expect(body.Health[0]).toMatchObject({ addonUrl: BAD, fails: 3 });

    const anon = await callApp(app, env, "/api/admin/usage");
    expect(anon.status).toBe(401);
  });

  it("records failing addons while successful ones stay clear", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(GOOD, "movie", "tt100");

    await callApp(app, env, `/Users/${adminId}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });

    const failing = (await (
      await callApp(app, env, "/api/admin/usage", { headers: authHeader(token) })
    ).json()) as { Health: { addonUrl: string; fails: number; lastError: string }[] };
    const badRow = failing.Health.find((h) => h.addonUrl === BAD);
    expect(badRow?.fails).toBeGreaterThanOrEqual(1);
    expect(badRow?.lastError).toContain("500");
    expect(failing.Health.find((h) => h.addonUrl === GOOD)).toBeUndefined();

    const anon = await callApp(app, env, "/api/admin/usage");
    expect(anon.status).toBe(401);
  });

  it("never lets health bookkeeping throw into stream or subtitle resolution", async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("no such column: latency_ms");
          },
        }),
      }),
    } as unknown as Db;
    await expect(recordAddonResult(db, "p", BAD, false, "boom", 1, 5)).resolves.toBeUndefined();
    await expect(recordAddonResult(db, "p", GOOD, true, "", 1, 5)).resolves.toBeUndefined();
  });
});
