import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem, encodePerson, encodeSeason, encodeView } from "../src/ids";
import { artImageTag, artUrlAllowed } from "../src/library-art";
import { photoFromImageTag, photoImageTag } from "../src/people";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";
const SERIES_POSTER = "https://image.tmdb.org/art/show.jpg";
const SERIES_BG = "https://image.tmdb.org/art/show-bg.jpg";
const SERIES_LOGO = "https://image.tmdb.org/art/show-logo.png";
const SERIES_LANDSCAPE = "https://image.tmdb.org/art/show-landscape.jpg";
const EP_THUMB = "https://image.tmdb.org/art/ep1.jpg";
const ACTOR_PHOTO = "https://image.tmdb.org/art/rebecca.jpg";

const SERIES_META = {
  id: "tt200",
  type: "series",
  name: "Example Show",
  released: "2024-06-16",
  country: "United States of America",
  poster: SERIES_POSTER,
  background: SERIES_BG,
  logo: SERIES_LOGO,
  landscapePoster: SERIES_LANDSCAPE,
  trailers: [{ source: "abc123", type: "Trailer", name: "Trailer" }],
  trailerStreams: [{ title: "Teaser", ytId: "xyz789" }],
  app_extras: {
    seasonPosters: [null, "https://image.tmdb.org/art/s1.jpg"],
    cast: [{ name: "Rebecca Ferguson", character: "Juliette", photo: ACTOR_PHOTO }],
  },
  videos: [{ season: 1, episode: 1, title: "Pilot", thumbnail: EP_THUMB }],
};

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
      return Response.json({ catalogs: [{ type: "series", id: "top", name: "Top", extra: [] }] });
    }
    if (url === `${CINE}/meta/series/tt200.json`) {
      return Response.json({ meta: SERIES_META });
    }
    if (url === `${CINE}/catalog/series/top.json`) {
      return Response.json({ metas: [SERIES_META] });
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

describe("artwork and metadata completeness", () => {
  it("carries logos, thumbs, aspect ratio, premiere date, and trailers", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(CINE, "series", "tt200");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as Record<string, unknown>;
    const tags = dto.ImageTags as Record<string, string>;
    expect(dto.PrimaryImageAspectRatio).toBeCloseTo(0.667, 2);
    expect(tags.Primary).toBeTruthy();
    expect(tags.Logo).toBeTruthy();
    expect(tags.Thumb).toBeTruthy();
    expect(dto.PremiereDate).toBe("2024-06-16T00:00:00.000Z");
    expect(dto.SortName).toBe("example show");
    expect(dto.ProductionLocations).toEqual(["United States of America"]);
    expect(dto.RemoteTrailers).toEqual([
      { Name: "Teaser", Url: "https://www.youtube.com/watch?v=xyz789" },
      { Name: "Trailer", Url: "https://www.youtube.com/watch?v=abc123" },
    ]);
  });

  it("gives episodes the parent artwork tags Moonfin falls back to", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const episode = encodeEpisode(CINE, "tt200", 1, 1);
    const series = encodeItem(CINE, "series", "tt200");

    const detail = await callApp(app, env, `/Users/${adminId}/Items/${episode}`, { headers: authHeader(token) });
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as Record<string, unknown>;
    expect(dto.PrimaryImageAspectRatio).toBeCloseTo(1.778, 2);
    expect(dto.SeriesPrimaryImageTag).toBeTruthy();
    expect(dto.ParentPrimaryImageItemId).toBe(series);
    expect(dto.ParentPrimaryImageTag).toBeTruthy();
    expect(dto.SeriesThumbImageTag).toBeTruthy();
    expect(dto.ParentThumbItemId).toBe(series);
    expect(dto.ParentThumbImageTag).toBeTruthy();
    expect(dto.ParentBackdropItemId).toBe(series);
    expect((dto.ParentBackdropImageTags as string[]).length).toBe(1);
    expect(dto.ParentLogoItemId).toBe(series);
    expect(dto.ParentLogoImageTag).toBeTruthy();
    expect((dto.ImageTags as Record<string, string>).Primary).toBeTruthy();
  });

  it("serves actor photos from addon cast data and falls back to an avatar", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(CINE, "series", "tt200");
    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    const people = ((await detail.json()) as { People: { Name: string; PrimaryImageTag?: string }[] }).People;
    const actor = people.find((person) => person.Name === "Rebecca Ferguson");
    expect(actor).toBeDefined();
    expect(photoFromImageTag(actor?.PrimaryImageTag)).toBe(ACTOR_PHOTO);

    const tagged = await callApp(app, env, `/Items/${encodePerson("Rebecca Ferguson")}/Images/Primary?tag=${actor?.PrimaryImageTag}`, {
      headers: authHeader(token),
    });
    expect(tagged.status).toBe(302);
    expect(tagged.headers.get("location")).toBe(ACTOR_PHOTO);

    const unknown = await callApp(app, env, `/Items/${encodePerson("Nobody Here")}/Images/Primary`, { headers: authHeader(token) });
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("does not let a person image tag poison the shared cache", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const attacker = "https://evil.example/fake.png";
    const tag = photoImageTag(attacker);
    const person = encodePerson("Nobody Here");

    const poison = await callApp(app, env, `/Items/${person}/Images/Primary?tag=${encodeURIComponent(tag)}`, {
      headers: authHeader(token),
    });
    expect(poison.status).toBe(302);
    expect(poison.headers.get("location")).toBe(attacker);

    const afterItem = await callApp(app, env, `/Items/${person}/Images/Primary`, { headers: authHeader(token) });
    expect(afterItem.status).toBe(200);
    expect(afterItem.headers.get("content-type")).toContain("image/svg+xml");
    expect(afterItem.headers.get("location")).toBeNull();

    const personPoison = await callApp(app, env, `/Persons/${person}/Images/Primary?tag=${encodeURIComponent(tag)}`);
    expect(personPoison.status).toBe(302);
    expect(personPoison.headers.get("location")).toBe(attacker);

    const afterPerson = await callApp(app, env, `/Persons/${person}/Images/Primary`);
    expect(afterPerson.status).toBe(200);
    expect(afterPerson.headers.get("content-type")).toContain("image/svg+xml");
    expect(afterPerson.headers.get("location")).toBeNull();
  });

  it("encodes item id segments before the artwork fetch", async () => {
    const calls: string[] = [];
    installNet();
    const realFetch = (globalThis as unknown as Record<string, unknown>).fetch as typeof fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return realFetch(input as RequestInfo, init);
    };
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(CINE, "movie", "../admin");
    await callApp(app, env, `/Items/${movie}/Images/Primary`, { headers: authHeader(token) });
    const metaCalls = calls.filter((url) => url.startsWith(`${CINE}/meta/`));
    expect(metaCalls.length).toBeGreaterThan(0);
    expect(metaCalls.some((url) => url.includes("..%2Fadmin"))).toBe(true);
    expect(metaCalls.some((url) => url.includes("/../"))).toBe(false);
  });

  it("resolves item artwork straight from the image tag without calling the addon", async () => {
    const calls: string[] = [];
    installNet();
    const realFetch = (globalThis as unknown as Record<string, unknown>).fetch as typeof fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return realFetch(input as RequestInfo, init);
    };
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const series = encodeItem(CINE, "series", "tt200");
    const detail = await callApp(app, env, `/Users/${adminId}/Items/${series}`, { headers: authHeader(token) });
    const tag = ((await detail.json()) as { ImageTags: Record<string, string> }).ImageTags.Primary;
    expect(tag?.startsWith("art_")).toBe(true);
    calls.length = 0;
    const image = await callApp(app, env, `/Items/${series}/Images/Primary?tag=${encodeURIComponent(String(tag))}`, {
      headers: authHeader(token),
    });
    expect(image.status).toBe(302);
    expect(image.headers.get("location")).toBe(SERIES_POSTER);
    expect(calls.filter((url) => url.includes("/meta/"))).toHaveLength(0);
  });

  it("redirects an image tag from a host outside the addon list", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(CINE, "movie", "tt100");
    const weird = "http://trex.iptv.example/logo.png";
    const tag = String(artImageTag(weird));
    const image = await callApp(app, env, `/Items/${movie}/Images/Primary?tag=${encodeURIComponent(tag)}`, {
      headers: authHeader(token),
    });
    expect(image.status).toBe(302);
    expect(image.headers.get("location")).toBe(weird);
  });

  it("resolves catalog item artwork without a tag and without a meta fetch", async () => {
    const calls: string[] = [];
    installNet();
    const realFetch = (globalThis as unknown as Record<string, unknown>).fetch as typeof fetch;
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return realFetch(input as RequestInfo, init);
    };
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "series", "top");
    const page = await callApp(app, env, `/Items?ParentId=${view}`, { headers: authHeader(token) });
    expect(page.status).toBe(200);
    const series = encodeItem(CINE, "series", "tt200");
    calls.length = 0;
    const image = await callApp(app, env, `/Items/${series}/Images/Primary`, { headers: authHeader(token) });
    expect(image.status).toBe(302);
    expect(image.headers.get("location")).toBe(SERIES_POSTER);
    expect(calls.filter((url) => url.includes("/meta/"))).toHaveLength(0);
  });

  it("serves season posters and episode stills through the image route", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const season = encodeSeason(CINE, "tt200", 1);
    const episode = encodeEpisode(CINE, "tt200", 1, 1);

    const seasonImage = await callApp(app, env, `/Items/${season}/Images/Primary`, { headers: authHeader(token) });
    expect(seasonImage.status).toBe(302);
    expect(seasonImage.headers.get("location")).toContain("s1.jpg");

    const episodeImage = await callApp(app, env, `/Items/${episode}/Images/Primary`, { headers: authHeader(token) });
    expect(episodeImage.status).toBe(302);
    expect(episodeImage.headers.get("location")).toContain("ep1.jpg");
  });

  it("reports LastPlayedDate in list user data so clients can sort and hide", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const view = encodeView(CINE, "series", "top");
    const series = encodeItem(CINE, "series", "tt200");
    await callApp(app, env, `/UserPlayedItems/${series}`, { method: "POST", headers: authHeader(token) });

    const res = await callApp(app, env, `/Items?ParentId=${view}`, { headers: authHeader(token) });
    const body = (await res.json()) as { Items: { UserData: { LastPlayedDate?: string } }[] };
    expect(body.Items[0]?.UserData.LastPlayedDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("artwork fallback", () => {
  it("follows any http addon host encoded in the item id", async () => {
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
    const OTHER = "https://iptv.example";
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${OTHER}/meta/movie/tt999.json`) {
        return Response.json({
          meta: {
            id: "tt999",
            type: "movie",
            name: "IPTV Movie",
            poster: "http://images.trex.example/poster.jpg",
          },
        });
      }
      return new Response("down", { status: 500 });
    };
    const { raw } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(OTHER, "movie", "tt999");
    const res = await callApp(app, env, `/Items/${id}/Images/Primary`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://images.trex.example/poster.jpg");
  });

  it("returns 404 instead of 500 when the addon meta cannot be fetched", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const evil = encodeItem("https://evil.example", "movie", "tt100");
    const res = await callApp(app, env, `/Items/${evil}/Images/Primary`, { headers: authHeader(token) });
    expect(res.status).toBe(404);
  });

  it("redirects addon art from any http host and rejects non-http tags", () => {
    expect(artUrlAllowed("https://artworks.thetvdb.com/banners/posters/1.jpg")).toBe(
      "https://artworks.thetvdb.com/banners/posters/1.jpg",
    );
    expect(artUrlAllowed("http://iptv.example/logo.png")).toBe("http://iptv.example/logo.png");
    expect(artUrlAllowed("https://anything.example/x.jpg")).toBe("https://anything.example/x.jpg");
    expect(artUrlAllowed("javascript:alert(1)")).toBeNull();
    expect(artUrlAllowed("ftp://host/a.jpg")).toBeNull();
    expect(artUrlAllowed("data:image/png;base64,AAAA")).toBeNull();
    expect(artUrlAllowed(null)).toBeNull();
  });

  it("serves Nuvio favorite posters through the image tag", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    raw.favorites.set(`${adminId}\nmovie:tt777`, {
      profile_id: adminId,
      item_key: "movie:tt777",
      content_id: "tt777",
      content_type: "movie",
      name: "IPTV Favorite",
      poster: "http://images.trex.example/fav.jpg",
      added_at: 1,
    });
    const list = await callApp(app, env, `/Users/${adminId}/Items?Filters=IsFavorite&Recursive=true`, {
      headers: authHeader(token),
    });
    const body = (await list.json()) as { Items: { Id: string; ImageTags?: { Primary?: string } }[] };
    const tag = body.Items[0]?.ImageTags?.Primary ?? "";
    expect(tag.startsWith("art_")).toBe(true);
    const image = await callApp(app, env, `/Items/${body.Items[0]?.Id}/Images/Primary?tag=${encodeURIComponent(tag)}`);
    expect(image.status).toBe(302);
    expect(image.headers.get("location")).toBe("http://images.trex.example/fav.jpg");
  });
});
