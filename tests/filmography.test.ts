import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodePerson } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";

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
          { type: "movie", id: "people_search.people_search_movie", name: "People Search", extra: [{ name: "search", isRequired: true }] },
          { type: "series", id: "people_search.people_search_series", name: "People Search", extra: [{ name: "search", isRequired: true }] },
          { type: "movie", id: "top", name: "Top", extra: [] },
        ],
      });
    }
    if (url.startsWith(`${CINE}/catalog/movie/people_search.people_search_movie/search=Bryan%20Cranston`)) {
      return Response.json({
        metas: [
          { id: "tt1", type: "movie", name: "Godzilla", genres: ["Action"], releaseInfo: "2014", poster: "https://img.example/godzilla.jpg" },
          { id: "tt2", type: "movie", name: "Saving Private Ryan", genres: ["Drama"], releaseInfo: "1998", poster: "https://img.example/spr.jpg" },
        ],
      });
    }
    if (url.startsWith(`${CINE}/catalog/series/people_search.people_search_series/search=Bryan%20Cranston`)) {
      return Response.json({
        metas: [{ id: "tt3", type: "series", name: "Breaking Bad", genres: ["Drama"], releaseInfo: "2008", poster: "https://img.example/bb.jpg" }],
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
  raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
  return { raw, db, adminId: admin.id };
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("actor filmography", () => {
  it("returns the actor's movies and shows from the addon people-search catalogs", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const person = encodePerson("Bryan Cranston");

    const res = await callApp(
      app,
      env,
      `/Items?PersonIds=${person}&IncludeItemTypes=Movie,Series&SortBy=PremiereDate&SortOrder=Descending&Recursive=true&Limit=100`,
      { headers: authHeader(token) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string; Type: string; ImageTags?: Record<string, string> }[]; TotalRecordCount: number };
    expect(body.Items.map((item) => item.Name)).toEqual(["Godzilla", "Breaking Bad", "Saving Private Ryan"]);
    expect(body.Items.every((item) => item.ImageTags?.Primary)).toBe(true);
    expect(calls.some((url) => url.includes("people_search.people_search_movie/search=Bryan%20Cranston"))).toBe(true);
    expect(calls.some((url) => url.includes("people_search.people_search_series/search=Bryan%20Cranston"))).toBe(true);
  });

  it("falls back to an empty page when the addon has no people-search catalogs", async () => {
    const calls: string[] = [];
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url === `${CINE}/manifest.json`) {
        return Response.json({ catalogs: [{ type: "movie", id: "top", name: "Top", extra: [] }] });
      }
      return new Response("down", { status: 500 });
    };
    (globalThis as unknown as Record<string, unknown>).caches = {
      default: {
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => true,
      },
    };
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const person = encodePerson("Bryan Cranston");
    const res = await callApp(app, env, `/Items?PersonIds=${person}&IncludeItemTypes=Movie`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { Items: unknown[] }).Items).toHaveLength(0);
  });
});
