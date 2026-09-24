import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeItem } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";

function installNet() {
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
    if (url === `${CINE}/manifest.json`) {
      return Response.json({
        catalogs: [
          { type: "movie", id: "top", name: "Top", extra: [] },
          { type: "series", id: "top", name: "Top", extra: [] },
        ],
      });
    }
    if (url === `${CINE}/meta/movie/tt1.json`) {
      return Response.json({ meta: { id: "tt1", type: "movie", name: "Source Film", genres: ["Action"] } });
    }
    if (url === `${CINE}/meta/movie/tt4.json`) {
      return Response.json({ meta: { id: "tt4", type: "movie", name: "Action Comedy", genres: ["Action", "Comedy"] } });
    }
    if (url === `${CINE}/catalog/movie/top.json`) {
      return Response.json({
        metas: [
          { id: "tt1", type: "movie", name: "Source Film", genres: ["Action"], imdbRating: "9.0" },
          { id: "tt2", type: "movie", name: "Only Action", genres: ["Action"], imdbRating: "5.0" },
          { id: "tt3", type: "movie", name: "Only Comedy", genres: ["Comedy"], imdbRating: "9.9" },
          { id: "tt4", type: "movie", name: "Action Comedy", genres: ["Action", "Comedy"], imdbRating: "6.0" },
        ],
      });
    }
    if (url === `${CINE}/catalog/series/top.json`) {
      return Response.json({ metas: [{ id: "tt9", type: "series", name: "A Show", genres: ["Action"] }] });
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

describe("similar items", () => {
  it("ranks same-type items by genre overlap and excludes the source", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const source = encodeItem(CINE, "movie", "tt1");

    const res = await callApp(app, env, `/Items/${source}/Similar?Limit=10`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Name: string; Type: string }[] };
    expect(body.Items.map((item) => item.Name)).toEqual(["Action Comedy", "Only Action"]);
    expect(body.Items.every((item) => item.Type === "Movie")).toBe(true);
  });

  it("returns an empty list without a token", async () => {
    installNet();
    const { raw, db } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const source = encodeItem(CINE, "movie", "tt1");
    const res = await callApp(app, env, `/Items/${source}/Similar`);
    expect(res.status).toBe(401);
  });
});

describe("movie recommendations", () => {
  it("builds a SimilarToRecentlyPlayed row from watch history", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const source = encodeItem(CINE, "movie", "tt1");
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: source, PositionTicks: 5_000_000_000 }),
    });

    const res = await callApp(app, env, `/Movies/Recommendations?userId=${adminId}`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      RecommendationType: string;
      BaselineItemName: string;
      Items: { Name: string }[];
    }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ RecommendationType: "SimilarToRecentlyPlayed", BaselineItemName: "Source Film" });
    expect(body[0]?.Items.map((item) => item.Name)).toEqual(["Action Comedy", "Only Action"]);
  });

  it("builds a SimilarToLikedItem row from favorites", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const liked = encodeItem(CINE, "movie", "tt4");
    await callApp(app, env, `/UserFavoriteItems/${liked}`, { method: "POST", headers: authHeader(token) });

    const res = await callApp(app, env, `/Movies/Recommendations?userId=${adminId}`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      RecommendationType: string;
      BaselineItemName: string;
      Items: { Name: string }[];
    }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ RecommendationType: "SimilarToLikedItem", BaselineItemName: "Action Comedy" });
    expect(body[0]?.Items.map((item) => item.Name)).toEqual(["Only Comedy", "Source Film", "Only Action"]);
  });

  it("returns an empty list without a token and for fresh profiles", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const anon = await callApp(app, env, `/Movies/Recommendations?userId=${adminId}`);
    expect(anon.status).toBe(401);
    const fresh = await callApp(app, env, `/Movies/Recommendations?userId=${adminId}`, { headers: authHeader(token) });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual([]);
  });
});
