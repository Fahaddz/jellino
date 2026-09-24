import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { writeSetting } from "../src/db";
import { decodeItem, encodeEpisode, encodeItem, encodeSeason } from "../src/ids";
import {
  communityRating,
  criticRating,
  episodeDto,
  extractGenresAndTags,
  extractPeople,
  extractStudios,
  movieDto,
  officialRating,
  premiereDate,
  productionYear,
  providerIds,
  runtimeTicks,
  seasonDto,
  seasonPoster,
  seriesDto,
} from "../src/meta";
import type { StremioMeta } from "../src/meta";
import { artFromImageTag, artImageTag } from "../src/library-art";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";

const MOVIE_META = {
  id: "tt123",
  type: "movie",
  name: "Example Film",
  description: "A film.",
  genres: ["Drama"],
  released: "2023-05-01",
  runtime: "120 min",
  imdbRating: "7.5",
  poster: "https://img.example/p.jpg",
  background: "https://img.example/b.jpg",
};

const SERIES_META = {
  id: "tt456",
  type: "series",
  name: "Example Show",
  genres: ["Comedy"],
  released: "2022",
  poster: "https://img.example/s.jpg",
  videos: [
    { season: 1, episode: 1, title: "Pilot", released: "2022-01-01" },
    { season: 1, episode: 2, title: "Second" },
    { season: 2, episode: 1, title: "Return" },
  ],
};

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
    if (url === `${CINE}/meta/movie/tt123.json`) {
      return Response.json({ meta: MOVIE_META });
    }
    if (url === `${CINE}/meta/series/tt456.json`) {
      return Response.json({ meta: SERIES_META });
    }
    return new Response("missing", { status: 404 });
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

async function setup() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
  const token = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
  return { raw, db, adminId: admin.id, token };
}

function auth(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("item ids", () => {
  it("round-trips movie, season, and episode", () => {
    expect(decodeItem(encodeItem(CINE, "movie", "tt123"))).toEqual({
      kind: "movie",
      addonUrl: CINE,
      stremioId: "tt123",
      season: null,
      episode: null,
    });
    expect(decodeItem(encodeSeason(CINE, "tt456", 2))).toMatchObject({ kind: "season", season: 2 });
    expect(decodeItem(encodeEpisode(CINE, "tt456", 1, 2))).toMatchObject({ kind: "episode", season: 1, episode: 2 });
  });

  it("rejects malformed ids", () => {
    expect(decodeItem("m.bad")).toBeNull();
    expect(decodeItem(encodeEpisode(CINE, "tt456", 1, 0))).toBeNull();
  });
});

describe("meta inference", () => {
  it("parses provider ids, years, runtimes, ratings", () => {
    expect(providerIds("tt123")).toEqual({ Imdb: "tt123" });
    expect(providerIds("tmdb:99")).toEqual({ Tmdb: "99" });
    expect(providerIds("kitsu:abc")).toEqual({ Kitsu: "abc" });
    expect(productionYear("2023-05-01")).toBe(2023);
    expect(productionYear(undefined)).toBeNull();
    expect(runtimeTicks("120 min")).toBe(120 * 600000000);
    expect(runtimeTicks("unknown")).toBeNull();
    expect(communityRating("7.5")).toBe(7.5);
    expect(communityRating("high")).toBeNull();
  });

  it("extracts complete provider ids from metadata, app_extras, and links", () => {
    const meta = {
      id: "tt99999",
      type: "movie",
      imdb_id: "tt99999",
      moviedb_id: 12345,
      tvdb_id: 67890,
      zap2it_id: "MV00123",
      links: [
        { category: "imdb", url: "https://www.imdb.com/title/tt99999/" },
        { category: "tmdb", url: "https://www.themoviedb.org/movie/12345" },
        { category: "tvdb", url: "https://thetvdb.com/series/my-series" },
      ],
    };
    const provs = providerIds("tt99999", meta);
    expect(provs).toEqual({
      Imdb: "tt99999",
      Tmdb: "12345",
      Tvdb: "67890",
      Zap2It: "MV00123",
    });
  });

  it("guards per-entry anime from Western IMDb ID folding", () => {
    const meta = {
      id: "kitsu:1234",
      type: "series",
      imdb_id: "tt99999",
      _kitsuId: "1234",
      _malId: "5678",
      links: [{ category: "imdb", url: "https://www.imdb.com/title/tt99999/" }],
    };
    const provs = providerIds("kitsu:1234", meta);
    expect(provs).toEqual({
      Kitsu: "1234",
      MyAnimeList: "5678",
    });
    expect(provs.Imdb).toBeUndefined();
  });

  it("extracts studios from various fields and app_extras", () => {
    const meta = {
      studios: ["Warner Bros.", "DC Films"],
      productionCompanies: [{ name: "Syncopy" }],
      network: "HBO",
      app_extras: {
        studios: ["Legendary Pictures"],
      },
    };
    const studios = extractStudios(meta);
    expect(studios.map((s) => s.Name)).toEqual([
      "Warner Bros.",
      "DC Films",
      "Syncopy",
      "HBO",
      "Legendary Pictures",
    ]);
    expect(studios.every((s) => s.Id.startsWith("studio-"))).toBe(true);
  });

  it("extracts genres and tags with stable genreItems", () => {
    const meta = {
      genres: ["Action", "Sci-Fi"],
      tags: ["Superhero", "Blockbuster"],
    };
    const { genres, tags, genreItems } = extractGenresAndTags(meta);
    expect(genres).toEqual(["Action", "Sci-Fi"]);
    expect(tags).toEqual(["Superhero", "Blockbuster"]);
    expect(genreItems.length).toBe(2);
    expect(genreItems[0]?.Name).toBe("Action");
    expect(genreItems[0]?.Id).toMatch(/^genre-/);
  });

  it("extracts official and critic ratings", () => {
    const meta = {
      certification: "PG-13",
      criticRating: 88,
      tomatoRating: "92%",
    };
    expect(officialRating(meta)).toBe("PG-13");
    expect(criticRating(meta)).toBe(88);

    const tomatoMeta = {
      tomatoRating: "95%",
    };
    expect(criticRating(tomatoMeta)).toBe(95);
  });

  it("extracts people from cast, directors, writers, and app_extras", () => {
    const meta = {
      director: "Christopher Nolan",
      writer: ["Christopher Nolan", "Jonathan Nolan"],
      cast: [
        { name: "Christian Bale", character: "Bruce Wayne / Batman" },
        "Heath Ledger",
      ],
    };
    const people = extractPeople(meta);
    expect(people.some((p) => p.Name === "Christopher Nolan" && p.Type === "Director")).toBe(true);
    expect(people.some((p) => p.Name === "Jonathan Nolan" && p.Type === "Writer")).toBe(true);
    expect(people.some((p) => p.Name === "Christian Bale" && p.Role === "Bruce Wayne / Batman" && p.Type === "Actor")).toBe(true);
    expect(people.some((p) => p.Name === "Heath Ledger" && p.Type === "Actor")).toBe(true);
  });
});

describe("item routes", () => {
  it("serves movie and series DTOs", async () => {
    installNet();
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const movie = (await (
      await callApp(app, env, `/Users/${adminId}/Items/${encodeItem(CINE, "movie", "tt123")}`, { headers: auth(token) })
    ).json()) as Record<string, unknown>;
    expect(movie).toMatchObject({
      Type: "Movie",
      Name: "Example Film",
      ProductionYear: 2023,
      ProviderIds: { Imdb: "tt123" },
      Genres: ["Drama"],
    });
    expect(movie.RunTimeTicks).toBe(120 * 600000000);
    const series = (await (
      await callApp(app, env, `/Items/${encodeItem(CINE, "series", "tt456")}?userId=${adminId}`, { headers: auth(token) })
    ).json()) as Record<string, unknown>;
    expect(series).toMatchObject({ Type: "Series", Name: "Example Show", ChildCount: 2, RecursiveItemCount: 3, Genres: ["Comedy"] });
  });

  it("lists seasons and filters episodes", async () => {
    installNet();
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const seriesId = encodeItem(CINE, "series", "tt456");
    const seasons = (await (
      await callApp(app, env, `/Shows/${seriesId}/Seasons?userId=${adminId}`, { headers: auth(token) })
    ).json()) as { Items: { IndexNumber: number; SeriesId: string; ChildCount: number }[]; TotalRecordCount: number };
    expect(seasons.TotalRecordCount).toBe(2);
    expect(seasons.Items.map((s) => s.IndexNumber)).toEqual([1, 2]);
    expect(seasons.Items[0]?.SeriesId).toBe(seriesId);
    expect(seasons.Items[0]?.ChildCount).toBe(2);
    expect(seasons.Items[1]?.ChildCount).toBe(1);
    const seasonId = encodeSeason(CINE, "tt456", 1);
    const single = (await (
      await callApp(app, env, `/Users/${adminId}/Items/${seasonId}`, { headers: auth(token) })
    ).json()) as Record<string, unknown>;
    expect(single).toMatchObject({ Type: "Season", IndexNumber: 1, ChildCount: 2 });
    const eps = (await (
      await callApp(app, env, `/Shows/${seriesId}/Episodes?userId=${adminId}&season=1`, { headers: auth(token) })
    ).json()) as { Items: { IndexNumber: number; ParentIndexNumber: number }[]; TotalRecordCount: number };
    expect(eps.TotalRecordCount).toBe(2);
    expect(eps.Items[0]).toMatchObject({ IndexNumber: 1, ParentIndexNumber: 1 });
    const ep = (await (
      await callApp(app, env, `/Items/${encodeEpisode(CINE, "tt456", 2, 1)}?userId=${adminId}`, { headers: auth(token) })
    ).json()) as Record<string, unknown>;
    expect(ep).toMatchObject({ Type: "Episode", Name: "Return", SortName: "0001 - return" });

    const paged = (await (
      await callApp(app, env, `/Shows/${seriesId}/Episodes?userId=${adminId}&season=1&StartIndex=1&Limit=1`, { headers: auth(token) })
    ).json()) as { Items: { IndexNumber: number; ParentIndexNumber: number }[]; TotalRecordCount: number; StartIndex: number };
    expect(paged.TotalRecordCount).toBe(2);
    expect(paged.Items.length).toBe(1);
    expect(paged.Items[0]?.IndexNumber).toBe(2);
    expect(paged.StartIndex).toBe(1);
  });

  it("filters episodes on PascalCase Season and SeasonId like real clients send", async () => {
    installNet();
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const seriesId = encodeItem(CINE, "series", "tt456");
    const pascalSeason = (await (
      await callApp(app, env, `/Shows/${seriesId}/Episodes?userId=${adminId}&Season=1`, { headers: auth(token) })
    ).json()) as { Items: { IndexNumber: number; ParentIndexNumber: number }[]; TotalRecordCount: number };
    expect(pascalSeason.TotalRecordCount).toBe(2);
    expect(pascalSeason.Items.every((e) => e.ParentIndexNumber === 1)).toBe(true);
    const otherSeasonId = encodeSeason(CINE, "tt456", 2);
    const pascalSeasonId = (await (
      await callApp(app, env, `/Shows/${seriesId}/Episodes?userId=${adminId}&SeasonId=${otherSeasonId}`, { headers: auth(token) })
    ).json()) as { Items: { IndexNumber: number; ParentIndexNumber: number }[]; TotalRecordCount: number };
    expect(pascalSeasonId.TotalRecordCount).toBe(1);
    expect(pascalSeasonId.Items[0]).toMatchObject({ IndexNumber: 1, ParentIndexNumber: 2 });
    const pascalUser = await callApp(app, env, `/Shows/${seriesId}/Seasons?UserId=${adminId}`, { headers: auth(token) });
    expect(pascalUser.status).toBe(200);
    expect(((await pascalUser.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(2);
  });

  it("returns 401 without a matching token and 404 for missing meta", async () => {
    installNet();
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(CINE, "movie", "tt123");
    expect((await callApp(app, env, `/Users/${adminId}/Items/${id}`)).status).toBe(401);
    expect((await callApp(app, env, `/Items/${id}?userId=${adminId}`)).status).toBe(401);
    const ghost = encodeItem(CINE, "movie", "tt000");
    expect((await callApp(app, env, `/Users/${adminId}/Items/${ghost}`, { headers: auth(token) })).status).toBe(404);
    expect((await callApp(app, env, "/Items/garbage?userId=" + adminId, { headers: auth(token) })).status).toBe(404);
  });

  it("drills series and season ids through parentId instead of 404", async () => {
    installNet();
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const seriesId = encodeItem(CINE, "series", "tt456");
    const seasons = (await (
      await callApp(app, env, `/Users/${adminId}/Items?parentId=${seriesId}`, { headers: auth(token) })
    ).json()) as { Items: { Type: string; IndexNumber: number }[]; TotalRecordCount: number };
    expect(seasons.TotalRecordCount).toBe(2);
    expect(seasons.Items[0]).toMatchObject({ Type: "Season", IndexNumber: 1 });
    const seasonId = encodeSeason(CINE, "tt456", 1);
    const episodes = (await (
      await callApp(app, env, `/Items?userId=${adminId}&parentId=${seasonId}`, { headers: auth(token) })
    ).json()) as { Items: { Type: string; IndexNumber: number }[]; TotalRecordCount: number };
    expect(episodes.TotalRecordCount).toBe(2);
    expect(episodes.Items[0]).toMatchObject({ Type: "Episode", IndexNumber: 1 });
    expect((await callApp(app, env, `/Users/${adminId}/Items?parentId=nope`, { headers: auth(token) })).status).toBe(404);
  });

  it("serves ancestor chains for seasons and episodes", async () => {
    installNet();
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const movie = await callApp(app, env, `/Items/${encodeItem(CINE, "movie", "tt123")}/Ancestors?userId=${adminId}`, {
      headers: auth(token),
    });
    expect(movie.status).toBe(200);
    expect(await movie.json()).toEqual([]);
    const episode = await callApp(
      app,
      env,
      `/Users/${adminId}/Items/${encodeEpisode(CINE, "tt456", 2, 1)}/Ancestors`,
      { headers: auth(token) },
    );
    expect(episode.status).toBe(200);
    const chain = (await episode.json()) as { Type: string; IndexNumber?: number }[];
    expect(chain.map((c) => c.Type)).toEqual(["Series", "Season"]);
    expect(chain[1]?.IndexNumber).toBe(2);
    expect((await callApp(app, env, `/Items/nope/Ancestors?userId=${adminId}`, { headers: auth(token) })).status).toBe(404);
  });

  it("lists every episode recursively when asked", async () => {
    installNet();
    const { raw, adminId, token } = await setup();
    const app = createApp();
    const env = testEnv(raw);
    const seriesId = encodeItem(CINE, "series", "tt456");
    const res = await callApp(app, env, `/Users/${adminId}/Items?parentId=${seriesId}&Recursive=true`, {
      headers: auth(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { Items: { Type: string }[]; TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(3);
    expect(body.Items.every((i) => i.Type === "Episode")).toBe(true);
  });
});

describe("season artwork", () => {
  const POSTER_S1 = "https://img.example/s1.jpg";
  const POSTER_S2 = "https://img.example/s2.jpg";
  const SHOW = {
    ...SERIES_META,
    background: "https://img.example/s-bg.jpg",
    app_extras: { seasonPosters: [null, POSTER_S1, POSTER_S2] },
  } as unknown as StremioMeta;

  it("resolves per-season posters by season number", () => {
    expect(seasonPoster(SHOW, 1)).toBe(POSTER_S1);
    expect(seasonPoster(SHOW, 2)).toBe(POSTER_S2);
    expect(seasonPoster(SHOW, 9)).toBeNull();
    expect(seasonPoster(SERIES_META as unknown as StremioMeta, 1)).toBeNull();
  });

  it("gives each season its own poster instead of the series poster", () => {
    const series = seriesDto("jellino", CINE, SHOW);
    const s1 = seasonDto("jellino", CINE, SHOW, 1);
    const s2 = seasonDto("jellino", CINE, SHOW, 2);
    const background = artImageTag("https://img.example/s-bg.jpg");
    expect(s1.ImageTags).toEqual({ Primary: artImageTag(POSTER_S1), Thumb: background });
    expect(s2.ImageTags).toEqual({ Primary: artImageTag(POSTER_S2), Thumb: background });
    expect(s1.ImageTags).not.toEqual(series.ImageTags);
    expect(s1.ImageTags).not.toEqual(s2.ImageTags);
    expect(s1.BackdropImageTags).toEqual([background]);
  });

  it("falls back to the series poster when a season has no poster", () => {
    const bare = seasonDto("jellino", CINE, SERIES_META as unknown as StremioMeta, 1);
    const seriesPoster = artImageTag("https://img.example/s.jpg");
    expect(bare.ImageTags).toEqual({ Primary: seriesPoster, Thumb: seriesPoster });
    expect(bare.BackdropImageTags).toEqual([]);
  });

  it("falls back to the series poster when an episode has no still", () => {
    const series = SERIES_META as unknown as StremioMeta;
    const bare = episodeDto("jellino", CINE, series, { season: 1, episode: 2, title: "Second" });
    expect(bare?.ImageTags).toEqual({ Primary: artImageTag("https://img.example/s.jpg") });
    const still = episodeDto("jellino", CINE, series, { season: 1, episode: 1, title: "Pilot", thumbnail: "https://img.example/e1.jpg" });
    const stillTag = artImageTag("https://img.example/e1.jpg");
    expect(still?.ImageTags).toEqual({ Primary: stillTag, Thumb: stillTag });
  });
});

describe("series status", () => {
  it("derives status from the releaseInfo range when the addon omits it", () => {
    const series = SERIES_META as unknown as StremioMeta;
    const ended = seriesDto("jellino", CINE, { ...series, releaseInfo: "2008-2013" });
    expect(ended.Status).toBe("Ended");
    const running = seriesDto("jellino", CINE, { ...series, releaseInfo: "2023-" });
    expect(running.Status).toBe("Continuing");
    const explicit = seriesDto("jellino", CINE, { ...series, releaseInfo: "2023-", status: "Canceled" });
    expect(explicit.Status).toBe("Canceled");
    const movie = movieDto("jellino", CINE, { ...series, type: "movie", releaseInfo: "2023" });
    expect(movie.Status).toBeUndefined();
  });
});

describe("episode premiere dates", () => {
  it("expands date-only releases to datetimes strict clients can parse", () => {
    expect(premiereDate("2022-01-01")).toBe("2022-01-01T00:00:00.000Z");
    expect(premiereDate("2022-01-01T10:00:00.000Z")).toBe("2022-01-01T10:00:00.000Z");
    expect(premiereDate("2022")).toBeUndefined();
    expect(premiereDate(undefined)).toBeUndefined();
  });

  it("emits PremiereDate only when the release is a real datetime", () => {
    const series = SERIES_META as unknown as StremioMeta;
    const dated = episodeDto("jellino", CINE, series, { season: 1, episode: 1, title: "Pilot", released: "2022-01-01" });
    expect(dated?.PremiereDate).toBe("2022-01-01T00:00:00.000Z");
    const bare = episodeDto("jellino", CINE, series, { season: 1, episode: 2, title: "Second" });
    expect(bare).not.toHaveProperty("PremiereDate");
  });
});

describe("rich jellyfin metadata dtos", () => {
  const RICH_META: StremioMeta = {
    id: "tt789",
    type: "series",
    name: "Rich Show",
    description: "An epic television series.",
    genres: ["Drama", "Fantasy"],
    tags: ["Dragons", "Kingdoms"],
    released: "2024-06-16",
    runtime: "60 min",
    imdbRating: "8.9",
    criticRating: 94,
    certification: "TV-MA",
    studios: ["HBO", "Warner Bros. Television"],
    director: "Miguel Sapochnik",
    writer: ["Ryan J. Condal", "George R.R. Martin"],
    cast: [
      { name: "Emma D'Arcy", character: "Rhaenyra Targaryen" },
      { name: "Matt Smith", character: "Daemon Targaryen" },
    ],
    poster: "https://img.example/rich-poster.jpg",
    background: "https://img.example/rich-bg.jpg",
    videos: [
      {
        season: 1,
        episode: 1,
        title: "A Son for a Son",
        released: "2024-06-16",
        overview: "War begins.",
        rating: "9.1",
        directors: ["Alan Taylor"],
        writers: ["Ryan J. Condal"],
        thumbnail: "https://img.example/ep1-thumb.jpg",
      },
    ],
  };

  it("builds seriesDto with complete metadata fields", () => {
    const dto = seriesDto("jellino", CINE, RICH_META);
    expect(dto.Type).toBe("Series");
    expect(dto.Name).toBe("Rich Show");
    expect(dto.ChildCount).toBe(1);
    expect(dto.RecursiveItemCount).toBe(1);
    expect(dto.Genres).toEqual(["Drama", "Fantasy"]);
    expect(dto.Tags).toEqual(["Dragons", "Kingdoms"]);
    expect(dto.OfficialRating).toBe("TV-MA");
    expect(dto.CustomRating).toBe("TV-MA");
    expect(dto.CommunityRating).toBe(8.9);
    expect(dto.CriticRating).toBe(94);
    expect(dto.ProductionYear).toBe(2024);
    expect(dto.ProviderIds).toEqual({ Imdb: "tt789" });
    expect(dto.Studios).toEqual([
      { Id: expect.stringMatching(/^studio-/), Name: "HBO" },
      { Id: expect.stringMatching(/^studio-/), Name: "Warner Bros. Television" },
    ]);
    expect(dto.ProductionCompanies).toEqual(dto.Studios);
    const people = dto.People as Record<string, unknown>[];
    expect(people.length).toBeGreaterThanOrEqual(4);
    expect(people.some((p) => p.Name === "Miguel Sapochnik" && p.Type === "Director")).toBe(true);
    expect(people.some((p) => p.Name === "Emma D'Arcy" && p.Role === "Rhaenyra Targaryen" && p.Type === "Actor")).toBe(true);
  });

  it("builds seasonDto with complete metadata fields and ChildCount", () => {
    const dto = seasonDto("jellino", CINE, RICH_META, 1);
    expect(dto.Type).toBe("Season");
    expect(dto.Name).toBe("Season 1");
    expect(dto.ChildCount).toBe(1);
    expect(dto.Genres).toEqual(["Drama", "Fantasy"]);
    expect(dto.Tags).toEqual(["Dragons", "Kingdoms"]);
    expect(dto.OfficialRating).toBe("TV-MA");
    expect(dto.CustomRating).toBe("TV-MA");
    expect(dto.CommunityRating).toBe(8.9);
    expect(dto.CriticRating).toBe(94);
    expect(dto.Studios).toEqual([
      { Id: expect.stringMatching(/^studio-/), Name: "HBO" },
      { Id: expect.stringMatching(/^studio-/), Name: "Warner Bros. Television" },
    ]);
  });

  it("builds episodeDto with complete metadata fields and specific episode credits", () => {
    const video = RICH_META.videos![0]!;
    const dto = episodeDto("jellino", CINE, RICH_META, video);
    expect(dto).not.toBeNull();
    expect(dto!.Type).toBe("Episode");
    expect(dto!.Name).toBe("A Son for a Son");
    expect(dto!.Overview).toBe("War begins.");
    expect(dto!.IndexNumber).toBe(1);
    expect(dto!.ParentIndexNumber).toBe(1);
    expect(dto!.RunTimeTicks).toBe(60 * 600000000);
    expect(dto!.CommunityRating).toBe(9.1);
    expect(dto!.CriticRating).toBe(94);
    expect(dto!.OfficialRating).toBe("TV-MA");
    expect(dto!.Genres).toEqual(["Drama", "Fantasy"]);
    expect(dto!.Studios).toEqual([
      { Id: expect.stringMatching(/^studio-/), Name: "HBO" },
      { Id: expect.stringMatching(/^studio-/), Name: "Warner Bros. Television" },
    ]);
    const people = dto!.People as Record<string, unknown>[];
    expect(people.some((p) => p.Name === "Alan Taylor" && p.Type === "Director")).toBe(true);
    expect(people.some((p) => p.Name === "Ryan J. Condal" && p.Type === "Writer")).toBe(true);
  });

  it("builds movieDto with complete metadata fields", () => {
    const { videos: _, ...movieRest } = RICH_META;
    const movieMeta: StremioMeta = {
      ...movieRest,
      type: "movie",
    };
    const dto = movieDto("jellino", CINE, movieMeta);
    expect(dto.Type).toBe("Movie");
    expect(dto.MediaType).toBe("Video");
    expect(dto.RunTimeTicks).toBe(60 * 600000000);
    expect(dto.OfficialRating).toBe("TV-MA");
    expect(dto.CommunityRating).toBe(8.9);
    expect(dto.CriticRating).toBe(94);
    expect(dto.Genres).toEqual(["Drama", "Fantasy"]);
    expect(dto.Studios).toEqual([
      { Id: expect.stringMatching(/^studio-/), Name: "HBO" },
      { Id: expect.stringMatching(/^studio-/), Name: "Warner Bros. Television" },
    ]);
  });

  it("maps addon links to ExternalUrls and ignores unusable entries", () => {
    const { videos: _, ...movieRest } = RICH_META;
    const dto = movieDto("jellino", CINE, {
      ...movieRest,
      type: "movie",
      links: [
        { name: "IMDb", category: "imdb", url: "https://www.imdb.com/title/tt789/" },
        { name: "", category: "tmdb", url: "https://www.themoviedb.org/tv/789" },
        { name: "Broken", category: "x", url: "not-a-url" },
        { name: "Duplicate", category: "imdb", url: "https://www.imdb.com/title/tt789/" },
      ],
    } as StremioMeta);
    expect(dto.ExternalUrls).toEqual([
      { Name: "IMDb", Url: "https://www.imdb.com/title/tt789/" },
      { Name: "tmdb", Url: "https://www.themoviedb.org/tv/789" },
    ]);
  });

  it("carries ExternalUrls onto episodes from the series links", () => {
    const dto = episodeDto("jellino", CINE, {
      ...RICH_META,
      links: [{ name: "TVDB", category: "tvdb", url: "https://thetvdb.com/series/789" }],
    }, RICH_META.videos![0]!);
    expect(dto?.ExternalUrls).toEqual([{ Name: "TVDB", Url: "https://thetvdb.com/series/789" }]);
  });
});

describe("season posters", () => {
  it("reads the object shape AIOMetadata v3 sends keyed by season", () => {
    const meta = {
      ...SERIES_META,
      app_extras: {
        seasonPosters: {
          "1": "https://image.tmdb.org/art/s1.jpg",
          "2": "https://image.tmdb.org/art/s2.jpg",
        },
      },
    } as unknown as StremioMeta;
    expect(seasonPoster(meta, 1)).toBe("https://image.tmdb.org/art/s1.jpg");
    expect(seasonPoster(meta, 2)).toBe("https://image.tmdb.org/art/s2.jpg");
    expect(seasonPoster(meta, 3)).toBeNull();
    const dto = seasonDto("jellino", CINE, meta, 2);
    const tags = dto.ImageTags as Record<string, string>;
    expect(artFromImageTag(tags.Primary ?? null)).toBe("https://image.tmdb.org/art/s2.jpg");
  });

  it("keeps reading the legacy array shape indexed by season", () => {
    const meta = {
      ...SERIES_META,
      app_extras: { season_posters: [null, "https://image.tmdb.org/art/s1.jpg"] },
    } as unknown as StremioMeta;
    expect(seasonPoster(meta, 1)).toBe("https://image.tmdb.org/art/s1.jpg");
    expect(seasonPoster(meta, 2)).toBeNull();
  });
});
