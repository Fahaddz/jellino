import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { writeSetting } from "../src/db";
import { createFakeDb } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

export const CINE = "https://cine.example";
const TMDB = "https://api.themoviedb.org/3";

export interface NetCounters {
  urls: string[];
  active: number;
  maxActive: number;
}

export function freshCounters(): NetCounters {
  return { urls: [], active: 0, maxActive: 0 };
}

export function tmdbCalls(counters: NetCounters): string[] {
  return counters.urls.filter((u) => u.startsWith(TMDB));
}

export function perfAuth(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="perf", Token="${token}"` };
}

export function installPerfNet(counters: NetCounters, delayMs: number) {
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
    counters.urls.push(url);
    counters.active += 1;
    counters.maxActive = Math.max(counters.maxActive, counters.active);
    try {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (url === `${CINE}/manifest.json`) {
        return new Response(
          JSON.stringify({ catalogs: [{ type: "movie", id: "top", name: "Top", extra: [{ name: "search" }] }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${CINE}/catalog/movie/top.json`) {
        return new Response(JSON.stringify({ metas: [{ id: "tt1", type: "movie", name: "Addon Film" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith(`${CINE}/catalog/movie/top/search=`)) {
        return new Response(JSON.stringify({ metas: [{ id: "tt1", type: "movie", name: "Addon Film" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      const addonMeta = /\/meta\/movie\/(tt20\d)\.json$/.exec(url);
      if (url.startsWith(CINE) && addonMeta?.[1]) {
        return new Response(JSON.stringify({ meta: { id: addonMeta[1], type: "movie", name: "Resume Film" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${CINE}/meta/movie/tt1.json`) {
        return new Response(
          JSON.stringify({ meta: { id: "tt1", type: "movie", name: "Addon Film", poster: "https://img.example/a.jpg" } }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (!url.startsWith(TMDB)) return new Response("down", { status: 404 });
      const path = url.slice(TMDB.length).split("?")[0] ?? "";
      if (path === "/discover/movie") {
        return new Response(
          JSON.stringify({
            results: [101, 102, 103, 104, 105].map((id) => ({
              id,
              title: `Popular ${id}`,
              poster_path: `/p${id}.jpg`,
              backdrop_path: `/b${id}.jpg`,
            })),
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/tv/22") {
        return new Response(
          JSON.stringify({
            id: 22,
            name: "Series",
            poster_path: "/series.jpg",
            seasons: [{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path.startsWith("/tv/22/season/")) {
        return new Response(JSON.stringify({ episodes: [{ episode_number: 1, name: "Pilot" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/search/movie") {
        return new Response(
          JSON.stringify({ results: [{ id: 301, title: "Found A" }, { id: 302, title: "Found B" }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/search/tv") {
        return new Response(JSON.stringify({ results: [{ id: 303, name: "Found C" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      const movieDetails = /^\/movie\/(\d+)$/.exec(path);
      if (movieDetails?.[1]) {
        const id = movieDetails[1];
        return new Response(
          JSON.stringify({ id: Number(id), imdb_id: `tt${id}`, title: `Film ${id}`, poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg` }),
          { headers: { "content-type": "application/json" } },
        );
      }
      const tvIds = /^\/tv\/(\d+)\/external_ids$/.exec(path);
      if (tvIds?.[1]) {
        return new Response(JSON.stringify({ imdb_id: `tt${tvIds[1]}` }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 404 });
    } finally {
      counters.active -= 1;
    }
  };
}

export function saveGlobals() {
  return {
    caches: (globalThis as unknown as Record<string, unknown>).caches,
    fetch: (globalThis as unknown as Record<string, unknown>).fetch,
  };
}

export async function tmdbHousehold() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
  await writeSetting(db, "tmdb_api_key", "test-key");
  const token = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
  return { raw, db, adminId: admin.id, token };
}
