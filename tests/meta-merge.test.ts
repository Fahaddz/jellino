import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const PRIMARY = "https://primary.example";
const SECONDARY = "https://secondary.example";
const STREAMS_ONLY = "https://streams.example";
const calls: string[] = [];

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
    calls.push(url);
    if (url === `${PRIMARY}/manifest.json`) {
      return Response.json({ resources: ["catalog", "meta"], catalogs: [{ type: "series", id: "top", name: "Top", extra: [] }] });
    }
    if (url === `${STREAMS_ONLY}/manifest.json`) {
      return Response.json({ resources: ["stream"], catalogs: [] });
    }
    if (url === `${SECONDARY}/manifest.json`) {
      return Response.json({ resources: ["meta"], catalogs: [] });
    }
    if (url === `${PRIMARY}/meta/series/tt200.json`) {
      return Response.json({
        meta: { id: "tt200", type: "series", name: "Example Show", posterShape: "landscape", poster: "https://img.example/s.jpg" },
      });
    }
    if (url === `${SECONDARY}/meta/series/tt200.json`) {
      return Response.json({
        meta: {
          id: "tt200",
          type: "series",
          name: "Example Show",
          status: "Ended",
          taglines: ["A tagline"],
          videos: [{ season: 1, episode: 1, title: "Merged Pilot" }],
        },
      });
    }
    if (url === `${PRIMARY}/meta/series/tt400.json`) {
      return Response.json({
        meta: { id: "tt400", type: "series", poster: "https://img.example/partial.jpg" },
      });
    }
    if (url === `${SECONDARY}/meta/series/tt400.json`) {
      return Response.json({
        meta: {
          id: "tt400",
          type: "series",
          name: "Named Show",
          videos: [{ season: 1, episode: 1, title: "Named Pilot" }],
          cast: [{ name: "Merge Actor", character: "Lead" }],
        },
      });
    }
    if (url === `${PRIMARY}/meta/movie/tt300.json`) {
      return Response.json({
        meta: { id: "tt300", type: "movie", poster: "https://img.example/partial-movie.jpg" },
      });
    }
    if (url === `${SECONDARY}/meta/movie/tt300.json`) {
      return Response.json({
        meta: {
          id: "tt300",
          type: "movie",
          name: "Named Film",
          cast: [{ name: "Film Actor", character: "Star" }],
        },
      });
    }
    if (url === `${PRIMARY}/meta/series/tt500.json`) {
      return Response.json({
        meta: {
          id: "tt500",
          type: "series",
          name: "US: ESPN 4K",
          videos: [{ season: 1, episode: 1, title: "IPTV Episode One" }],
        },
      });
    }
    if (url === `${SECONDARY}/meta/series/tt500.json`) {
      return Response.json({
        meta: { id: "tt500", type: "series", name: "Some Real Show", cast: [{ name: "Merge Actor" }] },
      });
    }
    return new Response("down", { status: 500 });
  };
}

const realCaches = (globalThis as unknown as Record<string, unknown>).caches;
const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;

beforeEach(() => {
  calls.length = 0;
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
    { profile_id: admin.id, url: PRIMARY, position: 0, enabled: 1 },
    { profile_id: admin.id, url: STREAMS_ONLY, position: 1, enabled: 1 },
    { profile_id: admin.id, url: SECONDARY, position: 2, enabled: 1 },
  );
  return { raw, db, adminId: admin.id };
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("cross-addon meta merge", () => {
  it("fills status and taglines from a second meta addon and honors posterShape", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(PRIMARY, "series", "tt200");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as Record<string, unknown>;
    expect(dto.Status).toBe("Ended");
    expect(dto.Taglines).toEqual(["A tagline"]);
    expect(dto.PrimaryImageAspectRatio).toBeCloseTo(1.778, 2);
    expect(calls.some((url) => url.startsWith(`${STREAMS_ONLY}/meta/`))).toBe(false);
  });

  it("keeps the primary meta when no other addon can fill the gaps", async () => {
    (globalThis as unknown as Record<string, unknown>).caches = {
      default: {
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => true,
      },
    };
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${PRIMARY}/manifest.json`) {
        return Response.json({ catalogs: [{ type: "series", id: "top", name: "Top", extra: [] }] });
      }
      if (url === `${PRIMARY}/meta/series/tt200.json`) {
        return Response.json({ meta: { id: "tt200", type: "series", name: "Example Show" } });
      }
      return new Response("down", { status: 500 });
    };
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(PRIMARY, "series", "tt200");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as Record<string, unknown>;
    expect(dto.Name).toBe("Example Show");
    expect(dto.Status).toBeUndefined();
  });

  it("merges episode lists from another addon so resume can name episodes", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(PRIMARY, "series", "tt200");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as Record<string, unknown>).RecursiveItemCount).toBe(1);

    const episode = encodeEpisode(PRIMARY, "tt200", 1, 1);
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: episode, PositionTicks: 5_000_000_000 }),
    });
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    const body = (await resume.json()) as { Items: { Name: string; SeriesName: string }[] };
    expect(body.Items[0]?.Name).toBe("Merged Pilot");
    expect(body.Items[0]?.SeriesName).toBe("Example Show");
  });

  it("takes the title, episodes, and cast from an addon that has them", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(PRIMARY, "series", "tt400");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as { Name: string; RecursiveItemCount: number; People?: { Name: string }[] };
    expect(dto.Name).toBe("Named Show");
    expect(dto.RecursiveItemCount).toBe(1);
    expect(dto.People?.map((person) => person.Name)).toContain("Merge Actor");

    const episode = encodeEpisode(PRIMARY, "tt400", 1, 1);
    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ ItemId: episode, PositionTicks: 5_000_000_000 }),
    });
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    const body = (await resume.json()) as { Items: { Name: string; SeriesName: string }[] };
    expect(body.Items[0]?.Name).toBe("Named Pilot");
    expect(body.Items[0]?.SeriesName).toBe("Named Show");
  });

  it("fills a movie title and cast from another addon too", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(PRIMARY, "movie", "tt300");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${movie}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as { Name: string; People?: { Name: string }[] };
    expect(dto.Name).toBe("Named Film");
    expect(dto.People?.map((person) => person.Name)).toContain("Film Actor");
  });

  it("never overwrites the first addon's own names, IPTV included", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(PRIMARY, "series", "tt500");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as { Name: string; RecursiveItemCount: number };
    expect(dto.Name).toBe("US: ESPN 4K");
    expect(dto.RecursiveItemCount).toBe(1);

    const episodes = await callApp(app, env, `/Shows/${series}/Episodes?userId=${adminId}`, {
      headers: authHeader(token),
    });
    const body = (await episodes.json()) as { Items: { Name: string }[] };
    expect(body.Items[0]?.Name).toBe("IPTV Episode One");
  });
});
