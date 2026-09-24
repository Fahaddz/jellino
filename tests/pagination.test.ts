import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeView } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";

function catalogPage(skip: number): { metas: Record<string, unknown>[] } {
  const total = 45;
  const size = 20;
  const metas: Record<string, unknown>[] = [];
  for (let i = skip; i < Math.min(skip + size, total); i += 1) {
    metas.push({ id: `tt${1000 + i}`, type: "movie", name: `Movie ${i + 1}`, genres: ["Action"], releaseInfo: "2024" });
  }
  return { metas };
}

function longPage(skip: number): { metas: Record<string, unknown>[] } {
  const total = 145;
  const size = 20;
  const metas: Record<string, unknown>[] = [];
  for (let i = skip; i < Math.min(skip + size, total); i += 1) {
    metas.push({ id: `tt${4000 + i}`, type: "movie", name: `Long ${i + 1}`, genres: ["Action"], releaseInfo: "2024" });
  }
  return { metas };
}

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
          { type: "movie", id: "top", name: "Top", extra: [], pageSize: 20 },
          { type: "movie", id: "long", name: "Long", extra: [], pageSize: 20 },
          { type: "movie", id: "search.movie", name: "Search", extra: [{ name: "search", isRequired: true }, { name: "skip" }] },
          { type: "movie", id: "mismatch", name: "Mismatch", extra: [], pageSize: 100 },
        ],
      });
    }
    if (url === `${CINE}/catalog/movie/top.json`) {
      return Response.json(catalogPage(0));
    }
    const skip = /^https:\/\/cine\.example\/catalog\/movie\/top\/skip=(\d+)\.json$/.exec(url);
    if (skip?.[1] !== undefined) {
      return Response.json(catalogPage(Number(skip[1])));
    }
    if (url === `${CINE}/catalog/movie/mismatch.json`) {
      return Response.json({ metas: Array.from({ length: 20 }, (_, i) => ({ id: `tt${5000 + i}`, type: "movie", name: `Mismatch ${i + 1}` })) });
    }
    const mismatchSkip = /^https:\/\/cine\.example\/catalog\/movie\/mismatch\/skip=(\d+)\.json$/.exec(url);
    if (mismatchSkip?.[1] !== undefined) {
      const skip = Number(mismatchSkip[1]);
      return Response.json({ metas: Array.from({ length: 20 }, (_, i) => ({ id: `tt${5000 + skip + i}`, type: "movie", name: `Mismatch ${skip + i + 1}` })) });
    }
    if (url === `${CINE}/catalog/movie/long.json`) {
      return Response.json(longPage(0));
    }
    const longSkip = /^https:\/\/cine\.example\/catalog\/movie\/long\/skip=(\d+)\.json$/.exec(url);
    if (longSkip?.[1] !== undefined) {
      return Response.json(longPage(Number(longSkip[1])));
    }
    if (url === `${CINE}/catalog/movie/search.movie/search=Silo.json`) {
      return Response.json({ metas: Array.from({ length: 20 }, (_, i) => ({ id: `tt${2000 + i}`, type: "movie", name: `Silo Result ${i + 1}` })) });
    }
    if (url === `${CINE}/catalog/movie/search.movie/search=Silo&skip=20.json`) {
      return Response.json({ metas: [{ id: "tt3000", type: "movie", name: "Silo Result 21" }] });
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
  raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
  return { raw, db, adminId: admin.id };
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("catalog pagination", () => {
  it("pages past the first addon page and reports more to come", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "movie", "top");

    const first = await callApp(app, env, `/Items?ParentId=${view}&StartIndex=0&Limit=20`, { headers: authHeader(token) });
    const firstBody = (await first.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(firstBody.Items.map((item) => item.Name)).toEqual(Array.from({ length: 20 }, (_, i) => `Movie ${i + 1}`));
    expect(firstBody.TotalRecordCount).toBeGreaterThan(20);

    const second = await callApp(app, env, `/Items?ParentId=${view}&StartIndex=20&Limit=20`, { headers: authHeader(token) });
    const secondBody = (await second.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(secondBody.Items.map((item) => item.Name)).toEqual(Array.from({ length: 20 }, (_, i) => `Movie ${i + 21}`));
    expect(secondBody.TotalRecordCount).toBeGreaterThan(40);

    const last = await callApp(app, env, `/Items?ParentId=${view}&StartIndex=40&Limit=20`, { headers: authHeader(token) });
    const lastBody = (await last.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(lastBody.Items.map((item) => item.Name)).toEqual(Array.from({ length: 5 }, (_, i) => `Movie ${i + 41}`));
    expect(lastBody.TotalRecordCount).toBe(45);
    expect(calls.some((url) => url.includes("skip=40"))).toBe(true);
  });

  it("pages deep windows from the requested offset without refetching earlier pages", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "movie", "long");

    const res = await callApp(app, env, `/Items?ParentId=${view}&StartIndex=100&Limit=20`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(body.Items).toHaveLength(20);
    expect(body.Items[0]?.Name).toBe("Long 101");
    expect(body.Items[19]?.Name).toBe("Long 120");
    expect(calls.some((url) => url.includes("long/skip=100"))).toBe(true);
    expect(calls.some((url) => url.includes("long/skip=0"))).toBe(false);
    expect(calls.some((url) => url.includes("/catalog/movie/long.json"))).toBe(false);
  });

  it("keeps a single page for Latest requests", async () => {    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "movie", "top");

    const res = await callApp(app, env, `/Users/${adminId}/Items/Latest?ParentId=${view}&Limit=5`, { headers: authHeader(token) });
    const body = (await res.json()) as { Name: string }[];
    expect(body.length).toBe(5);
    expect(calls.some((url) => url.includes("skip="))).toBe(false);
  });

  it("pages search results with the addon skip extra", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);

    const res = await callApp(app, env, `/Items?searchTerm=Silo&StartIndex=20&Limit=20`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(body.Items.map((item) => item.Name)).toEqual(["Silo Result 21"]);
    expect(calls.some((url) => url.includes("search=Silo&skip=20"))).toBe(true);
  });
  it("ignores a declared pageSize that does not match the addon's real page length", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "movie", "mismatch");

    const first = await callApp(app, env, `/Items?ParentId=${view}&StartIndex=0&Limit=20`, { headers: authHeader(token) });
    const firstBody = (await first.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(firstBody.Items.map((item) => item.Name)).toEqual(Array.from({ length: 20 }, (_, i) => `Mismatch ${i + 1}`));
    expect(firstBody.TotalRecordCount).toBeGreaterThan(20);

    const second = await callApp(app, env, `/Items?ParentId=${view}&StartIndex=20&Limit=20`, { headers: authHeader(token) });
    const secondBody = (await second.json()) as { Items: { Name: string }[] };
    expect(secondBody.Items[0]?.Name).toBe("Mismatch 21");
  });
});
