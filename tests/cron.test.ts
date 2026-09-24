import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { runScheduled } from "../src/cron";
import { maintenanceDue, maybeMaintenance } from "../src/cron";
import { writeSetting } from "../src/db";
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
    if (url === `${ALPHA}/manifest.json`) {
      return new Response(JSON.stringify({ catalogs: [{ type: "movie", id: "top", name: "Top" }] }), {
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

describe("scheduled maintenance", () => {
  it("warms manifests and drains the outbox", async () => {
    installNet();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 });
    const first = await runScheduled(db, caches.default, fetch, 2000);
    expect(first.manifests).toBe(1);

    const token = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
    const app = createApp();
    const res = await callApp(app, testEnv(raw), `/Users/${admin.id}/Views`, {
      headers: { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` },
    });
    expect(res.status).toBe(200);
    const second = await runScheduled(db, caches.default, fetch, 2000);
    expect(second.manifests).toBe(1);
  });

  it("throttles lazy maintenance to once per hour", async () => {
    installNet();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    expect(await maintenanceDue(db, 5000)).toBe(true);
    expect(await maybeMaintenance(db, fetch, 5000)).toBe(true);
    expect(await maintenanceDue(db, 5000)).toBe(false);
    expect(await maybeMaintenance(db, fetch, 5000)).toBe(false);
    expect(await maintenanceDue(db, 5000 + 3600)).toBe(true);
    expect(await maybeMaintenance(db, fetch, 5000 + 3600)).toBe(true);
  });
});
