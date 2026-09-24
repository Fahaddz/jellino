import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { manifestMemoryStats } from "../src/library";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem } from "../src/ids";
import { callApp, createFakeDb } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;
type R2Bucket = import("@cloudflare/workers-types").R2Bucket;
type Fetcher = import("@cloudflare/workers-types").Fetcher;

const CINE = "https://cine.example";
const TOONS = "https://toons.example";

const meter = {
  workerRequests: 0,
  upstream: 0,
  cacheGets: 0,
  cachePuts: 0,
  staticGets: 0,
  staticHits: 0,
};

const r2Counts = { reads: 0, writes: 0 };

function installNet() {
  const store = new Map<string, { body: string; headers: Record<string, string> }>();
  (globalThis as unknown as Record<string, unknown>).caches = {
    default: {
      match: async (key: Request) => {
        meter.cacheGets += 1;
        const isStatic =
          key.url.includes("/catalog/") ||
          key.url.includes("/manifest") ||
          key.url.includes("/meta/") ||
          key.url.includes("/img/") ||
          key.url.includes("/Images/");
        if (isStatic) meter.staticGets += 1;
        const entry = store.get(key.url);
        if (entry !== undefined) {
          if (isStatic) meter.staticHits += 1;
          return new Response(entry.body, { headers: entry.headers });
        }
        return undefined;
      },
      put: async (key: Request, value: Response) => {
        meter.cachePuts += 1;
        const headers: Record<string, string> = {};
        value.headers.forEach((v, k) => {
          headers[k] = v;
        });
        store.set(key.url, { body: await value.clone().text(), headers });
      },
      delete: async (key: Request) => store.delete(key.url),
    },
  };
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    meter.upstream += 1;
    if (url.endsWith("/manifest.json")) {
      return new Response(
        JSON.stringify({
          catalogs: [
            { type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] },
            { type: "series", id: "top", name: "Top", extra: [{ name: "search" }] },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/catalog/movie/top.json") || url.includes("/catalog/series/top.json")) {
      const type = url.includes("/catalog/movie/") ? "movie" : "series";
      return new Response(
        JSON.stringify({
          metas: [
            { id: "tt100", type: "movie", name: "The Epic", poster: "https://cdn.example/p100.jpg" },
            { id: "tt101", type: "movie", name: "Toon Feature", poster: "https://cdn.example/p101.jpg" },
            { id: "tt200", type: "series", name: "The Drama", poster: "https://cdn.example/s200.jpg" },
            { id: "tt300", type: "series", name: "Toon Series", poster: "https://cdn.example/s300.jpg" },
            { id: "tt400", type: "series", name: "Mini Series", poster: "https://cdn.example/s400.jpg" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/meta/movie/tt100.json")) {
      return new Response(
        JSON.stringify({ meta: { id: "tt100", type: "movie", name: "The Epic", runtime: "150 min", poster: "https://cdn.example/p100.jpg" } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/meta/movie/tt101.json")) {
      return new Response(
        JSON.stringify({ meta: { id: "tt101", type: "movie", name: "Toon Feature", runtime: "90 min", poster: "https://cdn.example/p101.jpg" } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/meta/series/tt200.json")) {
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt200",
            type: "series",
            name: "The Drama",
            runtime: "45 min",
            poster: "https://cdn.example/s200.jpg",
            videos: [
              { season: 1, episode: 1, title: "Drama 1" },
              { season: 1, episode: 2, title: "Drama 2" },
              { season: 1, episode: 3, title: "Drama 3" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/meta/series/tt300.json")) {
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt300",
            type: "series",
            name: "Toon Series",
            runtime: "22 min",
            poster: "https://cdn.example/s300.jpg",
            videos: [
              { season: 1, episode: 1, title: "Cartoon 1" },
              { season: 1, episode: 2, title: "Cartoon 2" },
              { season: 1, episode: 3, title: "Cartoon 3" },
              { season: 1, episode: 4, title: "Cartoon 4" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/meta/series/tt400.json")) {
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt400",
            type: "series",
            name: "Mini Series",
            runtime: "45 min",
            poster: "https://cdn.example/s400.jpg",
            videos: [{ season: 1, episode: 1, title: "Mini 1" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/stream/")) {
      return new Response(
        JSON.stringify({
          streams: [
            { url: "https://cdn.example/video.mp4", title: "1080p" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/subtitles/")) {
      return new Response(
        JSON.stringify({
          subtitles: [{ id: "sub1", url: "https://cdn.example/sub.srt", lang: "eng" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(".jpg")) {
      return new Response("fake-image", { headers: { "content-type": "image/jpeg" } });
    }
    return new Response("down", { status: 500 });
  };
}

const realCaches = (globalThis as unknown as Record<string, unknown>).caches;
const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;

beforeEach(() => {
  meter.workerRequests = 0;
  meter.upstream = 0;
  meter.cacheGets = 0;
  meter.cachePuts = 0;
  meter.staticGets = 0;
  meter.staticHits = 0;
  r2Counts.reads = 0;
  r2Counts.writes = 0;
  delete (globalThis as unknown as Record<string, unknown>).caches;
  delete (globalThis as unknown as Record<string, unknown>).fetch;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).caches = realCaches;
  (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
});

describe("family of six full-day simulation", () => {
  it("stays under one percent of every free cap", async () => {
    installNet();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };

    const familyMembers = ["mom", "kid1", "kid2", "kid3", "guest"];
    raw.profiles.push(
      ...familyMembers.map((name, i) => ({
        id: name,
        name,
        password_hash: "x",
        salt: "y",
        is_admin: 0,
        addon_mode: "inherit",
        disabled: 0,
        created_at: 2000 + i,
      })),
    );

    raw.addons.push(
      { profile_id: admin.id, url: CINE, position: 0, enabled: 1 },
      { profile_id: admin.id, url: TOONS, position: 1, enabled: 1 },
    );

    const r2Store = new Map<string, ArrayBuffer>();
    const r2Mock: R2Bucket = {
      async get(key: string) {
        r2Counts.reads += 1;
        const val = r2Store.get(key);
        if (!val) return null as unknown as import("@cloudflare/workers-types").R2ObjectBody;
        return {
          arrayBuffer: async () => val,
          text: async () => new TextDecoder().decode(val),
        } as unknown as import("@cloudflare/workers-types").R2ObjectBody;
      },
      async head(key: string) {
        r2Counts.reads += 1;
        return r2Store.has(key) ? ({} as import("@cloudflare/workers-types").R2Object) : null;
      },
      async put(key: string, value: unknown) {
        r2Counts.writes += 1;
        r2Store.set(key, new ArrayBuffer(0));
        return {} as import("@cloudflare/workers-types").R2Object;
      },
      async delete(key: string | string[]) {
        r2Counts.writes += 1;
        if (Array.isArray(key)) key.forEach((k) => r2Store.delete(k));
        else r2Store.delete(key);
      },
      async list() {
        r2Counts.reads += 1;
        return { objects: [], truncated: false } as unknown as import("@cloudflare/workers-types").R2Objects;
      },
    } as unknown as R2Bucket;

    const app = createApp();
    const env = {
      DB: db,
      ARTWORK: r2Mock,
      ASSETS: {
        fetch: async () => new Response("asset"),
      } as unknown as Fetcher,
    };

    async function get(profileId: string, token: string, path: string) {
      meter.workerRequests += 1;
      return callApp(app, env, path, {
        headers: { "X-Emby-Authorization": `MediaBrowser Client="day", Token="${token}"` },
      });
    }

    async function postSession(token: string, path: string, body: unknown) {
      meter.workerRequests += 1;
      return callApp(app, env, path, {
        method: "POST",
        headers: {
          "X-Emby-Authorization": `MediaBrowser Client="day", Token="${token}"`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    const dadToken = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
    const momToken = await issueToken(db, "mom", Math.floor(Date.now() / 1000));
    const kid1Token = await issueToken(db, "kid1", Math.floor(Date.now() / 1000));
    const kid2Token = await issueToken(db, "kid2", Math.floor(Date.now() / 1000));
    const kid3Token = await issueToken(db, "kid3", Math.floor(Date.now() / 1000));
    const guestToken = await issueToken(db, "guest", Math.floor(Date.now() / 1000));

    const epicMovie = encodeItem(CINE, "movie", "tt100");
    const toonMovie = encodeItem(CINE, "movie", "tt101");
    const dramaEp1 = encodeEpisode(CINE, "tt200", 1, 1);
    const dramaEp2 = encodeEpisode(CINE, "tt200", 1, 2);
    const dramaEp3 = encodeEpisode(CINE, "tt200", 1, 3);
    const toonEp1 = encodeEpisode(TOONS, "tt300", 1, 1);
    const toonEp2 = encodeEpisode(TOONS, "tt300", 1, 2);
    const toonEp3 = encodeEpisode(TOONS, "tt300", 1, 3);
    const toonEp4 = encodeEpisode(TOONS, "tt300", 1, 4);
    const guestEp1 = encodeEpisode(CINE, "tt400", 1, 1);

    async function browseCatalog(profileId: string, token: string) {
      const viewsRes = await get(profileId, token, `/Users/${profileId}/Views`);
      const views = (await viewsRes.json()) as { Items: { Id: string }[] };
      const viewId = views.Items[0]?.Id as string;

      await get(profileId, token, `/Users/${profileId}/Items?parentId=${viewId}`);
      await get(profileId, token, `/Users/${profileId}/Items?searchTerm=Epic`);
      await get(profileId, token, `/Users/${profileId}/Items/Latest`);
      await get(profileId, token, `/Users/${profileId}/Items/Resume`);
      await get(profileId, token, `/Shows/NextUp?userId=${profileId}`);
      await get(profileId, token, `/Items/${epicMovie}/Images/Primary`);
      await get(profileId, token, `/Items/${toonMovie}/Images/Primary`);
      await get(profileId, token, `/Items/${dramaEp1}/Images/Primary`);
      await get(profileId, token, `/Items/${toonEp1}/Images/Primary`);
    }

    async function streamItem(
      profileId: string,
      token: string,
      itemId: string,
      durationMinutes: number,
      isEpisode = false,
    ) {
      await get(profileId, token, `/Users/${profileId}/Items/${itemId}`);
      if (isEpisode) {
        await get(profileId, token, `/Items/${itemId}/MediaSegments`);
      }

      const infoRes = await postSession(token, `/Users/${profileId}/Items/${itemId}/PlaybackInfo`, {});
      const info = (await infoRes.json()) as {
        MediaSources?: { Id: string; MediaStreams?: { DeliveryUrl?: string }[] }[];
      };
      const subUrl = info.MediaSources?.[0]?.MediaStreams?.find((s) => s.DeliveryUrl)?.DeliveryUrl;
      if (subUrl) {
        await get(profileId, token, subUrl);
      }

      await postSession(token, "/Sessions/Playing", { ItemId: itemId });

      const totalTicks = durationMinutes * 60;
      for (let sec = 10; sec <= totalTicks; sec += 10) {
        await postSession(token, "/Sessions/Playing/Progress", {
          ItemId: itemId,
          PositionTicks: sec * 10_000_000,
        });
      }

      await postSession(token, "/Sessions/Playing/Stopped", {
        ItemId: itemId,
        PositionTicks: totalTicks * 10_000_000,
      });
      await postSession(token, `/Users/${profileId}/PlayedItems/${itemId}`, {});
      await get(profileId, token, `/Users/${profileId}/Items/${itemId}/StreamReport`);
    }

    await browseCatalog(admin.id, dadToken);
    await browseCatalog("mom", momToken);
    await browseCatalog("kid1", kid1Token);
    await browseCatalog("kid2", kid2Token);
    await browseCatalog("kid3", kid3Token);
    await browseCatalog("guest", guestToken);

    for (let b = 0; b < 10; b += 1) {
      await get("guest", guestToken, `/Users/guest/Items/${epicMovie}`);
      await get("guest", guestToken, `/Users/guest/Items/${toonMovie}`);
      await get("guest", guestToken, `/Users/guest/Items/${dramaEp1}`);
      await get("guest", guestToken, `/Users/guest/Items/${toonEp1}`);
      await get("guest", guestToken, `/Items/${epicMovie}/Images/Primary`);
      await get("guest", guestToken, `/Items/${toonMovie}/Images/Primary`);
    }

    await Promise.all([
      (async () => {
        await streamItem(admin.id, dadToken, epicMovie, 150, false);
      })(),
      (async () => {
        await streamItem("mom", momToken, dramaEp1, 45, true);
        await streamItem("mom", momToken, dramaEp2, 45, true);
        await streamItem("mom", momToken, dramaEp3, 45, true);
      })(),
      (async () => {
        await streamItem("kid1", kid1Token, toonEp1, 22, true);
        await streamItem("kid1", kid1Token, toonEp2, 22, true);
        await streamItem("kid1", kid1Token, toonEp3, 22, true);
        await streamItem("kid1", kid1Token, toonEp4, 22, true);
      })(),
      (async () => {
        await streamItem("kid2", kid2Token, toonEp1, 22, true);
        await streamItem("kid2", kid2Token, toonEp2, 22, true);
        await streamItem("kid2", kid2Token, toonEp3, 22, true);
        await streamItem("kid2", kid2Token, toonEp4, 22, true);
      })(),
      (async () => {
        await streamItem("kid3", kid3Token, toonMovie, 90, false);
      })(),
      (async () => {
        await streamItem("guest", guestToken, guestEp1, 45, true);
      })(),
    ]);

    expect(meter.workerRequests).toBeLessThan(15000);
    expect(raw.counts.writes).toBeLessThan(15000);
    expect(raw.counts.reads).toBeLessThan(50000);
    expect(r2Counts.writes).toBeLessThan(500);
    expect(r2Counts.reads).toBeLessThan(1000);

    const staticGets = meter.staticGets + manifestMemoryStats.hits + manifestMemoryStats.misses;
    const staticHits = meter.staticHits + manifestMemoryStats.hits;
    const staticHitRatio = staticGets > 0 ? staticHits / staticGets : 1;
    const manifestGets = manifestMemoryStats.hits + manifestMemoryStats.misses;
    const manifestHitRatio = manifestGets > 0 ? manifestMemoryStats.hits / manifestGets : 1;
    expect(manifestHitRatio).toBeGreaterThan(0.95);
    expect(staticHitRatio).toBeGreaterThan(0.7);
  }, 30000);
});
