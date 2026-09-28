import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";

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
    if (url === `${CINE}/manifest.json`) {
      return Response.json({
        catalogs: [
          { type: "movie", id: "top", name: "Top Movies", extra: [{ name: "search" }] },
          { type: "series", id: "top", name: "Top Shows", extra: [{ name: "search" }] },
        ],
      });
    }
    if (url === `${CINE}/catalog/movie/top.json`) {
      return Response.json({ metas: [{ id: "tt100", type: "movie", name: "Gate Film" }] });
    }
    if (url === `${CINE}/catalog/series/top.json`) {
      return Response.json({ metas: [{ id: "tt200", type: "series", name: "Gate Show" }] });
    }
    if (url.includes("/catalog/movie/top/search=")) {
      return Response.json({ metas: [{ id: "tt100", type: "movie", name: "Gate Film" }] });
    }
    if (url.includes("/catalog/series/top/search=")) {
      return Response.json({ metas: [{ id: "tt200", type: "series", name: "Gate Show" }] });
    }
    if (url.endsWith("/meta/movie/tt100.json")) {
      return Response.json({
        meta: { id: "tt100", type: "movie", name: "Gate Film", runtime: "90 min", poster: "https://img.example/f.jpg" },
      });
    }
    if (url.endsWith("/meta/series/tt200.json")) {
      return Response.json({
        meta: {
          id: "tt200",
          type: "series",
          name: "Gate Show",
          poster: "https://img.example/s.jpg",
          videos: [
            { season: 1, episode: 1, title: "Pilot", released: "2024-01-15" },
            { season: 1, episode: 2, title: "Second" },
          ],
        },
      });
    }
    if (url === `${CINE}/stream/movie/tt100.json`) {
      return Response.json({ streams: [{ url: "https://cdn.example/gate.mp4", title: "Gate 1080p" }] });
    }
    if (url === `${CINE}/stream/series/tt200:1:1.json`) {
      return Response.json({ streams: [{ url: "https://cdn.example/gate-s1e1.mp4", title: "Gate S01E01" }] });
    }
    if (url === `${CINE}/stream/series/tt200:1:2.json`) {
      return Response.json({ streams: [{ url: "https://cdn.example/gate-s1e2.mp4", title: "Gate S01E02" }] });
    }
    if (url === `${CINE}/subtitles/movie/tt100.json`) {
      return Response.json({ subtitles: [{ id: "English", url: "https://cdn.example/en.srt", lang: "eng" }] });
    }
    if (url === `${CINE}/subtitles/series/tt200:1:1.json`) {
      return Response.json({ subtitles: [{ id: "English", url: "https://cdn.example/en.srt", lang: "eng" }] });
    }
    if (url === "https://cdn.example/en.srt") {
      return new Response(SRT, { headers: { "content-type": "text/srt" } });
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

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
  return { raw, db, adminId: admin.id };
}

function official(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="Jellyfin", DeviceId="gate", Token="${token}"` };
}

describe("phase7 local gate walk", () => {
  it("official iOS and Android boot, browse, search, and play", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const app = createApp();
    const env = testEnv(raw);

    const pub = await callApp(app, env, "/System/Info/Public");
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { ProductName: string }).ProductName).toBe("Jellyfin Server");

    const login = await callApp(app, env, "/Users/AuthenticateByName", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Username: "dad", Pw: "supersecret1" }),
    });
    expect(login.status).toBe(200);
    const session = (await login.json()) as {
      AccessToken: string;
      SessionInfo: { PlayableMediaTypes: unknown; Id: string; Capabilities: { PlayableMediaTypes: unknown } };
      User: { Id: string };
    };
    expect(typeof session.AccessToken).toBe("string");
    expect(session.SessionInfo.PlayableMediaTypes).toEqual(["Video"]);
    expect(session.SessionInfo.Capabilities.PlayableMediaTypes).toEqual(["Video"]);
    expect(typeof session.SessionInfo.Id).toBe("string");
    const token = session.AccessToken;
    const headers = official(token);

    const me = await callApp(app, env, "/Users/Me", { headers });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { Id: string }).Id).toBe(adminId);

    const views = await callApp(app, env, `/Users/${adminId}/Views`, { headers });
    expect(views.status).toBe(200);
    const library = (await views.json()) as { Items: { Id: string }[]; TotalRecordCount: number };
    expect(library.TotalRecordCount).toBeGreaterThan(0);

    const latest = await callApp(app, env, `/Users/${adminId}/Items/Latest`, { headers });
    expect(latest.status).toBe(200);
    expect(Array.isArray(await latest.json())).toBe(true);

    const search = await callApp(app, env, `/Users/${adminId}/Items?searchTerm=gate`, { headers });
    expect(search.status).toBe(200);
    expect(((await search.json()) as { TotalRecordCount: number }).TotalRecordCount).toBeGreaterThan(0);

    const hints = await callApp(app, env, `/Search/Hints?searchTerm=gate&userId=${adminId}`, { headers });
    expect(hints.status).toBe(200);
    expect(((await hints.json()) as { TotalRecordCount: number }).TotalRecordCount).toBeGreaterThan(0);

    const movieId = encodeItem(CINE, "movie", "tt100");
    const detail = await callApp(app, env, `/Users/${adminId}/Items/${movieId}`, { headers });
    expect(detail.status).toBe(200);
    const film = (await detail.json()) as {
      Type: string;
      MediaSources: { Id: string; Path: string }[];
      UserData: { Key: string };
    };
    expect(film.Type).toBe("Movie");
    expect(film.MediaSources.length).toBeGreaterThan(0);
    expect(film.UserData.Key).toBe(movieId);

    const play = await callApp(app, env, `/Users/${adminId}/Items/${movieId}/PlaybackInfo`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ UserId: adminId }),
    });
    expect(play.status).toBe(200);
    const sources = ((await play.json()) as { MediaSources: { Path: string }[] }).MediaSources;
    expect(sources[0]?.Path).toBe("https://cdn.example/gate.mp4");

    const stream = await callApp(app, env, `/Videos/${movieId}/stream.mp4?api_key=${token}`);
    expect(stream.status).toBe(302);
    expect(stream.headers.get("location")).toBe("https://cdn.example/gate.mp4");

    expect((await callApp(app, env, "/Sessions/Playing", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movieId }),
    })).status).toBe(200);
    expect((await callApp(app, env, "/Sessions/Playing/Progress", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movieId, PositionTicks: 6000000000 }),
    })).status).toBe(200);
    expect((await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movieId, PositionTicks: 6000000000 }),
    })).status).toBe(200);

    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers });
    expect(resume.status).toBe(200);
    expect(((await resume.json()) as { TotalRecordCount: number }).TotalRecordCount).toBeGreaterThan(0);

    expect((await callApp(app, env, `/Users/${adminId}/PlayedItems/${movieId}`, { method: "POST", headers })).status).toBe(200);
    expect((await callApp(app, env, `/Users/${adminId}/PlayedItems/${movieId}`, { method: "DELETE", headers })).status).toBe(200);

    const seriesId = encodeItem(CINE, "series", "tt200");
    const seasons = await callApp(app, env, `/Shows/${seriesId}/Seasons?userId=${adminId}`, { headers });
    expect(seasons.status).toBe(200);
    expect(((await seasons.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(1);
    const episodes = await callApp(app, env, `/Shows/${seriesId}/Episodes?UserId=${adminId}&Season=1`, { headers });
    expect(episodes.status).toBe(200);
    expect(((await episodes.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(2);

    const prefsPost = await callApp(app, env, `/DisplayPreferences/homesection?userId=${adminId}&client=gate`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ CustomPrefs: { homesection1: "resume" } }),
    });
    expect([200, 204]).toContain(prefsPost.status);
    const prefsGet = await callApp(app, env, `/DisplayPreferences/homesection?userId=${adminId}&client=gate`, { headers });
    expect(prefsGet.status).toBe(200);
    expect(((await prefsGet.json()) as { CustomPrefs: Record<string, string> }).CustomPrefs).toEqual({});

    expect((await callApp(app, env, "/Sessions/Logout", { method: "POST", headers })).status).toBe(204);
    expect(db).toBeDefined();
  });

  it("moonfin boots through its own header forms and probes", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const forms = [
      { Authorization: `MediaBrowser Token="${token}"` },
      { "X-Emby-Token": token },
      { "X-MediaBrowser-Token": token },
    ];

    for (const extra of forms) {
      const me = await callApp(app, env, "/Users/Me", { headers: extra });
      expect(me.status).toBe(200);
    }
    const keyed = await callApp(app, env, `/Users/Me?api_key=${token}`);
    expect(keyed.status).toBe(200);
    expect((await callApp(app, env, "/Users/Me")).status).toBe(401);

    expect((await callApp(app, env, "/System/Ping")).status).toBe(200);
    expect((await callApp(app, env, "/System/Ping", { method: "POST" })).status).toBe(200);

    const headers = { Authorization: `MediaBrowser Token="${token}"` };
    const folders = await callApp(app, env, `/Library/MediaFolders?userId=${adminId}`, { headers });
    expect(folders.status).toBe(200);

    const episodeId = encodeEpisode(CINE, "tt200", 1, 1);
    const ancestors = await callApp(app, env, `/Users/${adminId}/Items/${episodeId}/Ancestors`, { headers });
    expect(ancestors.status).toBe(200);
    expect(Array.isArray(await ancestors.json())).toBe(true);
    expect((await callApp(app, env, `/Items/${episodeId}/Intros?userId=${adminId}`, { headers })).status).toBe(200);
    expect((await callApp(app, env, `/Users/${adminId}/Items/${episodeId}/Intros`, { headers })).status).toBe(200);
    expect((await callApp(app, env, "/ClientLog/Document", { method: "POST", body: "{}" })).status).toBe(204);

    const avatar = await callApp(app, env, `/Users/${adminId}/Images/Primary`, { headers });
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toContain("image/svg+xml");

    const resume = await callApp(app, env, `/UserItems/Resume?userId=${adminId}&IncludeItemTypes=Movie,Episode`, { headers });
    expect(resume.status).toBe(200);
    expect((await callApp(app, env, "/Persons", { headers })).status).toBe(200);
  });

  it("swiftfin strict shapes stay decodable", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const headers = official(token);

    const me = (await (await callApp(app, env, "/Users/Me", { headers })).json()) as {
      Configuration: { GroupedFolders: unknown };
      Policy: { AuthenticationProviderId: unknown; PasswordResetProviderId: unknown };
    };
    expect(Array.isArray(me.Configuration.GroupedFolders)).toBe(true);
    expect(typeof me.Policy.AuthenticationProviderId).toBe("string");
    expect(typeof me.Policy.PasswordResetProviderId).toBe("string");

    const views = (await (
      await callApp(app, env, `/Users/${adminId}/Views`, { headers })
    ).json()) as { Items: { CollectionType?: string }[] };
    for (const view of views.Items) {
      expect(view.CollectionType === undefined || view.CollectionType !== "mixed").toBe(true);
    }

    const episodeId = encodeEpisode(CINE, "tt200", 1, 1);
    const episode = (await (
      await callApp(app, env, `/Users/${adminId}/Items/${episodeId}`, { headers })
    ).json()) as { PremiereDate?: string; UserData: { Key: string; ItemId: string } };
    if (episode.PremiereDate !== undefined) {
      expect(Number.isNaN(Date.parse(episode.PremiereDate))).toBe(false);
      expect(episode.PremiereDate).toContain("T");
    }
    expect(episode.UserData.Key).toBe(episodeId);
    expect(episode.UserData.ItemId).toBe(episodeId);
  });

  it("jellyfin web plays through the Videos redirect and js subtitles", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const headers = official(token);
    const movieId = encodeItem(CINE, "movie", "tt100");

    const play = await callApp(app, env, `/Items/${movieId}/PlaybackInfo?UserId=${adminId}`, { headers });
    expect(play.status).toBe(200);
    const sources = ((await play.json()) as {
      MediaSources: { Id: string; MediaStreams: { Type: string; Index: number; DeliveryUrl?: string }[] }[];
    }).MediaSources;
    const sub = sources[0]?.MediaStreams.find((t) => t.Type === "Subtitle");
    expect(sub?.DeliveryUrl).toMatch(/^\/Videos\//);

    const webStream = await callApp(
      app,
      env,
      `/Videos/${movieId}/stream.mp4?Static=true&mediaSourceId=${sources[0]?.Id}&deviceId=web&ApiKey=${token}`,
    );
    expect(webStream.status).toBe(302);
    expect(webStream.headers.get("location")).toBe("https://cdn.example/gate.mp4");

    const delivery = String(sub?.DeliveryUrl);
    const variant = (ext: string) => delivery.replace(/\.vtt(\?.*)?$/, `${ext}$1`);
    const vtt = await callApp(app, env, delivery);
    expect(vtt.status).toBe(200);
    expect((await vtt.text()).slice(0, 6)).toBe("WEBVTT");
    const js = await callApp(app, env, variant(".js"));
    expect(js.status).toBe(200);
    expect(((await js.json()) as { TrackEvents: unknown[] }).TrackEvents.length).toBeGreaterThan(0);
    const srt = await callApp(app, env, variant(".srt"));
    expect(srt.status).toBe(200);
    expect(await srt.text()).toContain("-->");
  });

  it("keeps the playback offer after the item detail resolves media sources", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const headers = official(token);
    const movieId = encodeItem(CINE, "movie", "tt100");

    const play = await callApp(app, env, `/Items/${movieId}/PlaybackInfo?UserId=${adminId}`, { headers });
    expect(play.status).toBe(200);
    const sources = ((await play.json()) as {
      MediaSources: { Id: string; MediaStreams: { Type: string; DeliveryUrl?: string }[] }[];
    }).MediaSources;
    const delivery = String(sources[0]?.MediaStreams.find((t) => t.Type === "Subtitle")?.DeliveryUrl);
    expect(delivery).toMatch(/^\/Videos\//);

    const detail = await callApp(app, env, `/Items/${movieId}?userId=${adminId}&Fields=MediaSources`, { headers });
    expect(detail.status).toBe(200);

    const vtt = await callApp(app, env, delivery);
    expect(vtt.status).toBe(200);
    expect((await vtt.text()).slice(0, 6)).toBe("WEBVTT");
  });

  it("streamyfin and fladder browse through UserViews plus resume rows", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const headers = official(token);
    const movieId = encodeItem(CINE, "movie", "tt100");
    const episodeId = encodeEpisode(CINE, "tt200", 1, 1);

    expect((await callApp(app, env, `/UserViews?userId=${adminId}`, { headers })).status).toBe(200);
    expect((await callApp(app, env, `/Library/VirtualFolders?userId=${adminId}`, { headers })).status).toBe(200);
    expect((await callApp(app, env, `/Items/${movieId}?userId=${adminId}`, { headers })).status).toBe(200);
    expect((await callApp(app, env, `/Shows/NextUp?userId=${adminId}`, { headers })).status).toBe(200);
    expect((await callApp(app, env, `/Users/${adminId}/Items/NextUp`, { headers })).status).toBe(200);

    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ItemId: episodeId, PositionTicks: 1200000000 }),
    });
    const next = (await (
      await callApp(app, env, `/Users/${adminId}/Items/NextUp`, { headers })
    ).json()) as { Items: { SeriesId: string }[]; TotalRecordCount: number };
    expect(next.TotalRecordCount).toBe(1);
  });

  it("tolerated probes never fail the gate and anonymous browsing stays gated", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const movieId = encodeItem(CINE, "movie", "tt100");

    for (const path of [
      "/LiveTv/Programs",
      `/Items/${movieId}/MediaSegments`,
      "/Moonfin/ping",
      "/socket",
      "/System/Configuration/Encoding",
    ]) {
      const res = await callApp(app, env, path);
      expect(res.status).not.toBe(500);
    }

    expect((await callApp(app, env, `/Users/${adminId}/Views`)).status).toBe(401);
    expect((await callApp(app, env, `/Users/${adminId}/Items/Latest`)).status).toBe(401);
    expect((await callApp(app, env, "/Users/Me")).status).toBe(401);
    expect((await callApp(app, env, `/Users/${adminId}/Items/${movieId}/PlaybackInfo`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(db).toBeDefined();
  });
});
