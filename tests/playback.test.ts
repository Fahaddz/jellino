import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { writeSetting } from "../src/db";
import { encodeEpisode, encodeItem, encodePlaceholderMarker, encodeSeason } from "../src/ids";
import { bitrateFor, classifyStreams, containerFor, isHttpUrl, mediaSource, mediaSourceIdFor, placeholderMediaSources, type StremioStream, parseTags, playableStreams, rewriteAddonUrl, sourceLabel, streamSize, streamUrl } from "../src/streams";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";
const BETA = "https://beta.example";

function installNet(calls: string[]) {
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
    calls.push(url);
    if (url === `${ALPHA}/stream/movie/tt100.json`) {
      return new Response(
        JSON.stringify({
          streams: [
            { url: "https://cdn.example/a.mp4", title: "Alpha 1080p" },
            { infoHash: "deadbeef", title: "Alpha torrent" },
            {
              url: "https://cdn.example/auth.mp4",
              title: "Alpha authed",
              behaviorHints: { proxyHeaders: { request: { Authorization: "Bearer x" } } },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${BETA}/stream/movie/tt100.json`) {
      return new Response(
        JSON.stringify({ streams: [{ url: "https://cdn.example/b.mkv", name: "Beta 4K" }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${ALPHA}/stream/series/tt200:1:2.json`) {
      return new Response(
        JSON.stringify({ streams: [{ url: "https://cdn.example/e2.mp4", title: "S01E02" }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/meta/movie/tt100.json")) {
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt100",
            type: "movie",
            name: "Film",
            runtime: "120 min",
            cast: [{ name: "Jane Star", character: "Lead" }, { name: "Extra" }],
            director: ["Auteur Director"],
            writer: ["Script Writer"],
            studios: ["Gate Films"],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/meta/series/tt200.json")) {
      return new Response(
        JSON.stringify({
          meta: {
            id: "tt200",
            type: "series",
            name: "Show",
            runtime: "45 min",
            cast: [{ name: "Serial Star" }],
            director: ["Show Runner"],
            studios: ["Serial Works"],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.themoviedb.org/3/find/tt100")) {
      return new Response(JSON.stringify({ movie_results: [{ id: 456 }], tv_results: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.themoviedb.org/3/movie/456/credits")) {
      return new Response(
        JSON.stringify({
          cast: [
            { name: "Jane Star", character: "Lead", order: 0 },
            { name: "Extra", order: 5 },
          ],
          crew: [
            { name: "Auteur Director", job: "Director" },
            { name: "Script Writer", job: "Screenplay" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.themoviedb.org/3/movie/456")) {
      return new Response(JSON.stringify({ id: 456, production_companies: [{ id: 11, name: "Gate Films" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.themoviedb.org/3/find/tt200")) {
      return new Response(JSON.stringify({ movie_results: [], tv_results: [{ id: 789 }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.themoviedb.org/3/tv/789/credits")) {
      return new Response(
        JSON.stringify({
          cast: [{ name: "Serial Star", character: "Detective", order: 0 }],
          crew: [{ name: "Show Runner", job: "Director" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("https://api.themoviedb.org/3/tv/789")) {
      return new Response(JSON.stringify({ id: 789, production_companies: [{ id: 22, name: "Serial Works" }] }), {
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

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push(
    { profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 },
    { profile_id: admin.id, url: BETA, position: 1, enabled: 1 },
  );
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("stream helpers", () => {
  it("keeps http urls and drops torrents", () => {
    const kept = playableStreams([
      { url: "https://cdn.example/a.mp4" },
      { url: "http://cdn.example/b.mp4" },
      { infoHash: "deadbeef" },
      { url: "magnet:?xt=urn:btih:deadbeef" },
    ]);
    expect(kept).toHaveLength(2);
    expect(isHttpUrl("ftp://cdn.example/a.mp4")).toBe(false);
  });

  it("infers containers with an mp4 default", () => {
    expect(containerFor("https://cdn.example/a.mkv?x=1")).toBe("mkv");
    expect(containerFor("https://cdn.example/a")).toBe("mp4");
    expect(containerFor("https://debrid.example/dl/abc123", "Show.S01E01.1080p.mkv")).toBe("mkv");
  });

  it("passes header-authenticated streams through and drops unplayable links", () => {
    const breakdown = classifyStreams([
      { url: "https://cdn.example/a.mp4" },
      { url: "https://cdn.example/auth.mp4", behaviorHints: { proxyHeaders: { request: { Authorization: "x" } } } },
      { infoHash: "deadbeef" },
      { externalUrl: "https://youtube.example/watch?v=x" },
    ]);
    expect(breakdown.playable).toHaveLength(2);
    expect(breakdown.withHeaders).toHaveLength(1);
    expect(breakdown.nonHttpFiltered).toHaveLength(2);
  });

  it("keeps direct urls, skips external links, combines labels, and rewrites internal hosts", () => {
    expect(streamUrl({ externalUrl: "https://cdn.example/e.mp4" })).toBeNull();
    expect(streamUrl({ url: "https://cdn.example/a.mp4", externalUrl: "https://cdn.example/e.mp4" })).toBe(
      "https://cdn.example/a.mp4",
    );
    expect(streamUrl({ infoHash: "deadbeef" })).toBeNull();
    expect(sourceLabel({ name: "RD+", description: "4K\n12 GB" }, "https://a.example")).toBe("RD+\n4K\n12 GB");
    expect(sourceLabel({ title: "Just a title" }, "https://a.example")).toBe("Just a title");
    expect(sourceLabel({}, "https://a.example")).toBe("a.example");
    expect(streamSize({ behaviorHints: { videoSize: 123456789 } })).toBe(123456789);
    expect(streamSize({ size: 42 })).toBe(42);
    expect(streamSize({})).toBeNull();
    expect(rewriteAddonUrl("http://aiostreams:3000/file.mkv", "https://aio.example/stremio/xyz")).toBe(
      "https://aio.example/file.mkv",
    );
    expect(rewriteAddonUrl("http://192.168.1.50/file.mkv", "https://aio.example/x")).toBe("https://aio.example/file.mkv");
    expect(rewriteAddonUrl("https://cdn.example/a.mp4", "https://aio.example/x")).toBe("https://cdn.example/a.mp4");
  });

  it("parses resolution, codecs, audio, and hdr from release names", () => {
    expect(parseTags("Movie.2024.2160p.WEB-DL.DDP5.1.H.265.DV.mkv")).toMatchObject({
      width: 3840,
      height: 2160,
      codec: "hevc",
      audioCodec: "eac3",
      audioChannels: "5.1",
      channelLayout: 6,
      hdr: "Dolby Vision",
    });
    expect(parseTags("Show.S01E01.1080p.BluRay.x264.DTS-HD.MA.7.1.mkv")).toMatchObject({
      width: 1920,
      height: 1080,
      codec: "h264",
      audioCodec: "dts",
      audioChannels: "7.1",
    });
    expect(parseTags("Some Cam No Tags")).toEqual({});
  });

  it("offers two placeholder versions so clients show the versions picker", () => {
    const id = encodeItem(ALPHA, "movie", "tt100");
    const sources = placeholderMediaSources(id);
    expect(sources.map((source) => source.Name)).toEqual(["Streams load when played", "Load the stream list"]);
    expect(sources[0]?.Id).toBe(id);
    expect(sources[1]?.Id).toBe(encodePlaceholderMarker(id));
    expect(sources.every((source) => source.Protocol === "Http")).toBe(true);
    expect(
      sources.every(
        (source) =>
          source.ReadAtNativeFramerate === false &&
          source.IgnoreDts === false &&
          source.IgnoreIndex === false &&
          source.GenPtsInput === false &&
          source.HasSegments === false,
      ),
    ).toBe(true);
  });

  it("emits etag plus hdr range facts on every source", () => {
    const dolby = mediaSource(2, ALPHA, {
      url: "https://cdn.example/f.mkv",
      title: "GRP\n2160p WEB-DL DDP5.1 H.265 DV",
    }, 120 * 600000000) as { Id: string; ETag: string; MediaStreams: Record<string, unknown>[] };
    expect(dolby.Id).toBe("s_2a66a2ec340f8d5f");
    expect(dolby.ETag).toBe("s_2a66a2ec340f8d5f");
    expect(dolby.MediaStreams[0]).toMatchObject({
      Type: "Video",
      Width: 3840,
      Height: 2160,
      Codec: "hevc",
      VideoRange: "HDR",
      VideoRangeType: "DOVI",
    });
    const hdr10plus = mediaSource(0, ALPHA, {
      url: "https://cdn.example/g.mkv",
      title: "GRP\n1080p HDR10+ x264",
    }, null) as { MediaStreams: Record<string, unknown>[] };
    expect(hdr10plus.MediaStreams[0]).toMatchObject({ VideoRange: "HDR", VideoRangeType: "HDR10Plus" });
    const plain = mediaSource(0, ALPHA, { url: "https://cdn.example/h.mp4" }, null) as {
      MediaStreams: Record<string, unknown>[];
    };
    expect(plain.MediaStreams[0]).not.toHaveProperty("VideoRange");
    expect(plain.MediaStreams[0]).not.toHaveProperty("VideoRangeType");
  });

  it("carries every field the web pickers and player need", () => {
    const id = encodeItem(ALPHA, "movie", "tt100");
    const source = mediaSource(1, ALPHA, {
      url: "https://cdn.example/f.mkv",
      title: "GRP\n1080p BluRay DTS 5.1",
      behaviorHints: { filename: "Film.2024.1080p.BluRay.DTS.5.1.x264.mkv", videoSize: 12000000000 },
    }, 120 * 600000000, {
      itemId: id,
      tracks: [{ url: "https://cdn.example/en.srt", lang: "eng", title: "English", ordinal: 1, format: "vtt" }],
    }) as Record<string, unknown>;
    expect(source).toMatchObject({
      Id: "s_dd7c7ba0ee15f972",
      ETag: "s_dd7c7ba0ee15f972",
      Protocol: "Http",
      Type: "Default",
      IsRemote: true,
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
      Container: "mkv",
      Size: 12000000000,
      RunTimeTicks: 120 * 600000000,
    });
    expect(typeof source.Path).toBe("string");
    expect(typeof source.Name).toBe("string");
    expect(source.RequiredHttpHeaders).toEqual({});
    expect(typeof source.Bitrate).toBe("number");
    const tracks = source.MediaStreams as Record<string, unknown>[];
    const video = tracks.find((t) => t.Type === "Video");
    expect(video).toMatchObject({ Index: 0, Width: 1920, Height: 1080, Codec: "h264" });
    expect(typeof video?.DisplayTitle).toBe("string");
    const audio = tracks.find((t) => t.Type === "Audio");
    expect(audio).toMatchObject({ Index: 1, Codec: "dts", Channels: 6, ChannelLayout: "5.1" });
    expect(typeof audio?.DisplayTitle).toBe("string");
    const sub = tracks.find((t) => t.Type === "Subtitle");
    expect(sub).toMatchObject({
      Index: 2,
      Codec: "webvtt",
      DeliveryMethod: "External",
      IsExternalUrl: false,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      Language: "eng",
      Title: "English",
      DisplayTitle: "English (external)",
    });
    const delivery = new URL(String(sub?.DeliveryUrl), "https://server.local");
    expect(delivery.pathname).toBe(`/Videos/${id}/s_dd7c7ba0ee15f972/Subtitles/2/0/Stream.vtt`);
    expect(delivery.searchParams.get("ApiKey")).toBeNull();
    expect(delivery.searchParams.get("t")).toBeNull();
    expect(sub?.Path).toBe(sub?.DeliveryUrl);
    expect(source.DefaultAudioStreamIndex).toBe(1);
    expect("DefaultSubtitleStreamIndex" in source).toBe(true);
    expect(source.DefaultSubtitleStreamIndex).toBeNull();
  });

  it("builds video plus audio tracks with bitrate from size and runtime", () => {
    const source = mediaSource(0, ALPHA, {
      url: "https://cdn.example/f.mkv",
      title: "GRP\n1080p BluRay DTS 5.1",
      behaviorHints: { filename: "Film.2024.1080p.BluRay.DTS.5.1.x264.mkv", videoSize: 12000000000 },
    }, 120 * 600000000) as { MediaStreams: Record<string, unknown>[]; Bitrate: number; Size: number; Container: string };
    expect(source.Container).toBe("mkv");
    expect(source.Size).toBe(12000000000);
    expect(source.Bitrate).toBe(Math.round((12000000000 * 8) / 7200));
    const video = source.MediaStreams[0];
    expect(video).toMatchObject({ Type: "Video", Index: 0, Codec: "h264", Width: 1920, Height: 1080 });
    const audio = source.MediaStreams[1];
    expect(audio).toMatchObject({ Type: "Audio", Index: 1, Codec: "dts", Channels: 6, ChannelLayout: "5.1" });
    expect(source).toMatchObject({ DefaultAudioStreamIndex: 1 });
    expect(bitrateFor(null, 100)).toBeNull();
    expect(bitrateFor(100, null)).toBeNull();
  });
});

describe("playback info", () => {
  it("merges addon streams in profile order with direct-play sources", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ UserId: adminId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { MediaSources: Record<string, unknown>[]; PlaySessionId: string };
    expect(body.MediaSources).toHaveLength(3);
    expect(body.MediaSources[0]?.Path).toBe("https://cdn.example/a.mp4");
    expect(body.MediaSources[1]?.Path).toBe("https://cdn.example/auth.mp4");
    expect(body.MediaSources[2]?.Path).toBe("https://cdn.example/b.mkv");
    for (const source of body.MediaSources) {
      expect(source.Protocol).toBe("Http");
      expect(source.IsRemote).toBe(true);
      expect(source.SupportsDirectPlay).toBe(true);
      expect(source.SupportsTranscoding).toBe(false);
    }
    expect(body.MediaSources[0]?.RequiredHttpHeaders).toEqual({});
    expect(body.MediaSources[1]?.RequiredHttpHeaders).toEqual({ Authorization: "Bearer x" });
    expect(body.MediaSources[0]?.Name).toBe("Alpha 1080p");
    expect(body.MediaSources[0]?.RunTimeTicks).toBe(120 * 600000000);
    expect(typeof body.PlaySessionId).toBe("string");
  });

  it("puts the requested source first while keeping stable ids and urls", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");

    async function idsFor(init: RequestInit, path: string) {
      const res = await callApp(app, env, path, init);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { MediaSources: Record<string, unknown>[] };
      return body.MediaSources;
    }

    const [s0, s1, s2] = ["s_0881761959008a7f", "s_9a2cc7f95020b632", "s_52f7e4208313e5d5"];

    const viaBody = await idsFor(
      {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ MediaSourceId: s2 }),
      },
      `/Users/${adminId}/Items/${id}/PlaybackInfo`,
    );
    expect(viaBody.map((s) => s.Id)).toEqual([s2, s0, s1]);
    expect(viaBody[0]?.Path).toBe("https://cdn.example/b.mkv");
    expect(viaBody.map((s) => s.Path)).toEqual([
      "https://cdn.example/b.mkv",
      "https://cdn.example/a.mp4",
      "https://cdn.example/auth.mp4",
    ]);

    const viaLegacyBody = await idsFor(
      {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ MediaSourceId: "src2" }),
      },
      `/Users/${adminId}/Items/${id}/PlaybackInfo`,
    );
    expect(viaLegacyBody.map((s) => s.Id)).toEqual([s2, s0, s1]);

    const viaQuery = await idsFor(
      {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: "{}",
      },
      `/Users/${adminId}/Items/${id}/PlaybackInfo?MediaSourceId=src1`,
    );
    expect(viaQuery.map((s) => s.Id)).toEqual([s1, s0, s2]);

    const viaGet = await idsFor(
      { headers: authHeader(token) },
      `/Items/${id}/PlaybackInfo?UserId=${adminId}&mediaSourceId=src2`,
    );
    expect(viaGet.map((s) => s.Id)).toEqual([s2, s0, s1]);

    const unknown = await idsFor(
      {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ MediaSourceId: "src9" }),
      },
      `/Users/${adminId}/Items/${id}/PlaybackInfo`,
    );
    expect(unknown.map((s) => s.Id)).toEqual([s0, s1, s2]);

    const itemIdAsSource = await idsFor(
      {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ MediaSourceId: id }),
      },
      `/Users/${adminId}/Items/${id}/PlaybackInfo`,
    );
    expect(itemIdAsSource.map((s) => s.Id)).toEqual([s0, s1, s2]);

    const marker = encodePlaceholderMarker(id);
    const markerAsItem = await idsFor({ headers: authHeader(token) }, `/Users/${adminId}/Items/${marker}/PlaybackInfo`);
    expect(markerAsItem.map((s) => s.Id)).toEqual([s0, s1, s2]);

    const markerAsSource = await idsFor(
      {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ MediaSourceId: marker }),
      },
      `/Users/${adminId}/Items/${id}/PlaybackInfo`,
    );
    expect(markerAsSource.map((s) => s.Id)).toEqual([s0, s1, s2]);
  });

  it("reorders detail versions when a source is requested", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const plain = await callApp(app, env, `/Users/${adminId}/Items/${id}`, { headers: authHeader(token) });
    expect(plain.status).toBe(200);
    const plainBody = (await plain.json()) as { EnableMediaSourceDisplay?: boolean; MediaSources: { Id: string; Name: string }[] };
    expect(plainBody.EnableMediaSourceDisplay).toBe(true);
    expect(plainBody.MediaSources.map((s) => s.Name)).toEqual(["Streams load when played", "Load the stream list"]);
    expect(plainBody.MediaSources[0]?.Id).toBe(id);
    expect(plainBody.MediaSources[1]?.Id).toBe(encodePlaceholderMarker(id));

    const withFields = await callApp(app, env, `/Users/${adminId}/Items/${id}?Fields=MediaSources`, {
      headers: authHeader(token),
    });
    expect(withFields.status).toBe(200);
    const withFieldsBody = (await withFields.json()) as { MediaSources: { Id: string }[] };
    expect(withFieldsBody.MediaSources.map((s) => s.Id)).toEqual(["s_0881761959008a7f", "s_9a2cc7f95020b632", "s_52f7e4208313e5d5"]);

    const reordered = await callApp(app, env, `/Users/${adminId}/Items/${id}?MediaSourceId=src2`, {
      headers: authHeader(token),
    });
    expect(reordered.status).toBe(200);
    const reorderedBody = (await reordered.json()) as { MediaSources: { Id: string; Path: string }[] };
    expect(reorderedBody.MediaSources.map((s) => s.Id)).toEqual(["s_52f7e4208313e5d5", "s_0881761959008a7f", "s_9a2cc7f95020b632"]);
    expect(reorderedBody.MediaSources[0]?.Path).toBe("https://cdn.example/b.mkv");
  });

  it("serves the bare route and the GET variant", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const id = encodeItem(BETA, "movie", "tt100");
    const res = await callApp(createApp(), testEnv(raw), `/Items/${id}/PlaybackInfo?UserId=${adminId}`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { MediaSources: unknown[] };
    expect(body.MediaSources).toHaveLength(3);
  });

  it("requests episode streams with the series season episode id", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const id = encodeEpisode(ALPHA, "tt200", 1, 2);
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { MediaSources: Record<string, unknown>[] };
    expect(body.MediaSources).toHaveLength(1);
    expect(body.MediaSources[0]?.Path).toBe("https://cdn.example/e2.mp4");
    expect(calls).toContain(`${ALPHA}/stream/series/tt200:1:2.json`);
  });

  it("requests episode streams with the addon's own video id", async () => {
    const calls: string[] = [];
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
    const json = (data: unknown): Response =>
      new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.endsWith("/manifest.json")) {
        return json({ id: "xt", resources: ["catalog", "meta", "stream"], catalogs: [] });
      }
      if (url === `${ALPHA}/meta/series/xtremio_series_5.json`) {
        return json({
          meta: {
            id: "xtremio_series_5",
            type: "series",
            name: "Show",
            videos: [{ id: "xtremio_episode_5:1:777", season: 1, episode: 1, title: "Pilot" }],
          },
        });
      }
      if (url === `${ALPHA}/stream/series/xtremio_episode_5:1:777.json`) {
        return json({ streams: [{ url: "https://cdn.example/ep.mp4", title: "EP" }] });
      }
      return new Response("down", { status: 404 });
    };
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const id = encodeEpisode(ALPHA, "xtremio_series_5", 1, 1);
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { MediaSources: Record<string, unknown>[] };
    expect(body.MediaSources).toHaveLength(1);
    expect(body.MediaSources[0]?.Path).toBe("https://cdn.example/ep.mp4");
    expect(calls).toContain(`${ALPHA}/stream/series/xtremio_episode_5:1:777.json`);
    expect(calls).not.toContain(`${ALPHA}/stream/series/xtremio_series_5:1:1.json`);
  });

  it("embeds playable versions and cast into detail items", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    await writeSetting(db, "tmdb_api_key", "test-key");
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const movieId = encodeItem(ALPHA, "movie", "tt100");
    const defaultRes = await callApp(app, env, `/Users/${adminId}/Items/${movieId}`, { headers: authHeader(token) });
    expect(defaultRes.status).toBe(200);
    const defaultMovie = (await defaultRes.json()) as { EnableMediaSourceDisplay: boolean; MediaSources: { Id: string; Name: string }[] };
    expect(defaultMovie.EnableMediaSourceDisplay).toBe(true);
    expect(defaultMovie.MediaSources.map((s) => s.Name)).toEqual(["Streams load when played", "Load the stream list"]);
    expect(defaultMovie.MediaSources[0]?.Id).toBe(movieId);

    const movieRes = await callApp(app, env, `/Users/${adminId}/Items/${movieId}?Fields=MediaSources`, { headers: authHeader(token) });
    expect(movieRes.status).toBe(200);
    const movie = (await movieRes.json()) as {
      Type: string;
      MediaSources: { Id: string; Name: string; MediaStreams: Record<string, unknown>[] }[];
      People: { Name: string; Role: string; Type: string; PrimaryImageTag: string }[];
      Studios: { Id: string; Name: string }[];
    };
    expect(movie.Type).toBe("Movie");
    expect(movie.MediaSources.length).toBeGreaterThan(1);
    expect(movie.MediaSources[0]).toMatchObject({ Id: "s_0881761959008a7f", Name: "Alpha 1080p" });
    expect(movie.MediaSources[0]?.MediaStreams[0]).toMatchObject({ Type: "Video", Width: 1920, Height: 1080 });
    expect(movie.People).toMatchObject([
      { Name: "Auteur Director", Role: "Director", Type: "Director" },
      { Name: "Script Writer", Type: "Writer" },
      { Name: "Jane Star", Role: "Lead", Type: "Actor" },
      { Name: "Extra", Type: "Actor" },
    ]);
    for (const person of movie.People) expect(typeof person.PrimaryImageTag).toBe("string");
    expect(movie.Studios).toMatchObject([{ Name: "Gate Films" }]);

    const seriesId = encodeItem(ALPHA, "series", "tt200");
    const seriesRes = await callApp(app, env, `/Items/${seriesId}?userId=${adminId}`, { headers: authHeader(token) });
    expect(seriesRes.status).toBe(200);
    const series = (await seriesRes.json()) as { Type: string; People: { Name: string }[]; Studios: { Name: string }[] };
    expect(series.Type).toBe("Series");
    expect(series.People).toMatchObject([{ Name: "Show Runner", Type: "Director" }, { Name: "Serial Star", Type: "Actor" }]);
    expect(series.Studios).toMatchObject([{ Name: "Serial Works" }]);
    expect(series).not.toHaveProperty("MediaSources");
  });

  it("lands cast taps on person pages", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    await writeSetting(db, "tmdb_api_key", "test-key");
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const headers = authHeader(token);

    const movieId = encodeItem(ALPHA, "movie", "tt100");
    const movieRes = await callApp(app, env, `/Users/${adminId}/Items/${movieId}`, { headers });
    expect(movieRes.status).toBe(200);
    const movie = (await movieRes.json()) as {
      People: { Id: string; Name: string; Type: string }[];
    };
    expect(movie.People.length).toBeGreaterThan(0);
    for (const person of movie.People) {
      expect(["Actor", "Director", "Writer"]).toContain(person.Type);
      expect(typeof person.Name).toBe("string");
      expect(person.Id.startsWith("p.")).toBe(true);
    }
    const first = movie.People[0];
    if (!first) throw new Error("missing cast");

    const scoped = await callApp(app, env, `/Users/${adminId}/Items/${first.Id}`, { headers });
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toMatchObject({ Id: first.Id, Name: first.Name, Type: "Person" });

    const bare = await callApp(app, env, `/Items/${first.Id}?userId=${adminId}`, { headers });
    expect(bare.status).toBe(200);
    expect(await bare.json()).toMatchObject({ Id: first.Id, Name: first.Name, Type: "Person" });

    const byName = await callApp(app, env, `/Persons/${encodeURIComponent(first.Name)}`, { headers });
    expect(byName.status).toBe(200);
    expect(await byName.json()).toMatchObject({ Id: first.Id, Name: first.Name, Type: "Person" });

    const anon = await callApp(app, env, `/Users/${adminId}/Items/${first.Id}`);
    expect(anon.status).toBe(401);

    const ghost = await callApp(app, env, `/Users/${adminId}/Items/p.!!!`, { headers });
    expect(ghost.status).toBe(404);
  });

  it("redirects video stream urls to the chosen source", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const anon = await callApp(app, env, `/Videos/${id}/stream.mp4?api_key=wrong`);
    expect(anon.status).toBe(401);

    const first = await callApp(app, env, `/Videos/${id}/stream.mp4?api_key=${token}`);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("https://cdn.example/a.mp4");

    const second = await callApp(app, env, `/Videos/${id}/stream?api_key=${token}&mediaSourceId=src2`);
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toBe("https://cdn.example/b.mkv");

    const orig = await callApp(app, env, `/Videos/${id}/original?api_key=${token}`);
    expect(orig.status).toBe(302);
    expect(orig.headers.get("location")).toBe("https://cdn.example/a.mp4");

    const origExt = await callApp(app, env, `/Videos/${id}/original.mp4?api_key=${token}`);
    expect(origExt.status).toBe(302);
    expect(origExt.headers.get("location")).toBe("https://cdn.example/a.mp4");

    const streamFile = await callApp(app, env, `/Videos/${id}/stream/my_video.mkv?api_key=${token}`);
    expect(streamFile.status).toBe(302);
    expect(streamFile.headers.get("location")).toBe("https://cdn.example/a.mp4");

    const sourcesRes = await callApp(app, env, `/Items/${id}/MediaSources?userId=${adminId}`, {
      headers: authHeader(token),
    });
    expect(sourcesRes.status).toBe(200);
    const sources = (await sourcesRes.json()) as Record<string, unknown>[];
    expect(Array.isArray(sources)).toBe(true);
    expect(sources.length).toBeGreaterThan(0);

    const userSourcesRes = await callApp(app, env, `/Users/${adminId}/Items/${id}/MediaSources`, {
      headers: authHeader(token),
    });
    expect(userSourcesRes.status).toBe(200);
    const userSources = (await userSourcesRes.json()) as Record<string, unknown>[];
    expect(Array.isArray(userSources)).toBe(true);
    expect(userSources.length).toBe(sources.length);

    const ghost = await callApp(app, env, `/Videos/nope/stream?api_key=${token}`);
    expect(ghost.status).toBe(404);
  });

  it("unfolds unicode small-caps and strips zero-width chars when parsing tags", () => {
    const folded = parseTags("Release.ᴜʜᴅ.ʜᴇᴠᴄ.ʜᴅʀ.ᴅᴠ.ᴀᴛᴍᴏs.7.1");
    expect(folded.width).toBe(3840);
    expect(folded.codec).toBe("hevc");
    expect(folded.hdr).toBe("Dolby Vision");
    expect(folded.audioCodec).toBe("atmos");
    expect(folded.audioChannels).toBe("7.1");
  });

  it("skips addons without the stream resource for streams", async () => {
    const calls: string[] = [];
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
      calls.push(url);
      if (url === `${ALPHA}/manifest.json`) {
        return new Response(JSON.stringify({ resources: ["subtitles"], types: ["movie"], catalogs: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${BETA}/manifest.json`) {
        return new Response(JSON.stringify({ resources: ["stream"], types: ["movie"], catalogs: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${BETA}/stream/movie/tt100.json`) {
        return new Response(JSON.stringify({ streams: [{ url: "https://cdn.example/b.mkv", name: "Beta" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/meta/movie/tt100.json")) {
        return new Response(JSON.stringify({ meta: { id: "tt100", type: "movie", name: "Film" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 500 });
    };
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const res = await callApp(app, env, `/Users/${adminId}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { MediaSources: { Path: string }[] };
    expect(body.MediaSources).toHaveLength(1);
    expect(body.MediaSources[0]?.Path).toBe("https://cdn.example/b.mkv");
    expect(calls.some((u) => u === `${ALPHA}/stream/movie/tt100.json`)).toBe(false);
    expect(calls).toContain(`${BETA}/stream/movie/tt100.json`);
  });

  it("redirects episode streams without subtitle fan-out", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeEpisode(ALPHA, "tt200", 1, 2);

    const res = await callApp(app, env, `/Videos/${id}/stream?api_key=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://cdn.example/e2.mp4");
    expect(calls).toContain(`${ALPHA}/stream/series/tt200:1:2.json`);
    expect(calls.some((u) => u.includes("/subtitles/"))).toBe(false);
  });

  it("returns empty sources when only torrents exist", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const id = encodeItem(ALPHA, "movie", "tt999");
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { MediaSources: unknown[] };
    expect(body.MediaSources).toHaveLength(0);
  });

  it("falls back to placeholder versions when the addon resolves nothing", async () => {
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
      if (url.endsWith("/manifest.json")) {
        return Response.json({ resources: ["catalog", "meta", "stream"], catalogs: [] });
      }
      if (url.endsWith("/meta/movie/tt777.json")) {
        return Response.json({ meta: { id: "tt777", type: "movie", name: "Torrent Only" } });
      }
      if (url.endsWith("/stream/movie/tt777.json")) {
        return Response.json({ streams: [{ infoHash: "deadbeef", title: "Only torrent" }] });
      }
      return new Response("down", { status: 404 });
    };
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt777");
    const res = await callApp(app, env, `/Users/${adminId}/Items/${id}?Fields=MediaSources`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { EnableMediaSourceDisplay?: boolean; MediaSources: { Name: string }[] };
    expect(body.EnableMediaSourceDisplay).toBe(true);
    expect(body.MediaSources.map((s) => s.Name)).toEqual(["Streams load when played", "Load the stream list"]);
  });

  it("rejects bad ids, seasons, and foreign users", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    const anon = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${movie}/PlaybackInfo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anon.status).toBe(401);
    const bad = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/nope/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(404);
    const season = encodeSeason(ALPHA, "tt200", 1);
    const seasonRes = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${season}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(seasonRes.status).toBe(404);
    const foreign = await callApp(createApp(), testEnv(raw), `/Users/someone-else/Items/${movie}/PlaybackInfo`, {
      method: "POST",
      headers: { ...authHeader(token), "content-type": "application/json" },
      body: "{}",
    });
    expect(foreign.status).toBe(401);
  });

  it("reports per-addon filter reasons without leaking to other profiles", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const id = encodeItem(ALPHA, "movie", "tt100");
    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${id}/StreamReport`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ItemId: string;
      Addons: { addonUrl: string; total: number; playable: number; withHeaders: number; filteredNonHttp: number }[];
    };
    expect(body.ItemId).toBe(id);
    expect(body.Addons).toHaveLength(2);
    expect(body.Addons[0]).toMatchObject({
      addonUrl: ALPHA,
      total: 3,
      playable: 2,
      withHeaders: 1,
      filteredNonHttp: 1,
    });
    expect(body.Addons[1]).toMatchObject({ addonUrl: BETA, total: 1, playable: 1 });
    const anon = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/${id}/StreamReport`);
    expect(anon.status).toBe(401);
  });

  it("consults all addons per playback without artificial slicing", async () => {
    const calls: string[] = [];
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
      calls.push(url);
      if (url.includes("/stream/")) {
        const host = new URL(url).host;
        return new Response(JSON.stringify({ streams: [{ url: `https://${host}/v.mp4`, title: host }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/meta/")) {
        return new Response(JSON.stringify({ meta: { id: "tt100", type: "movie", name: "Film" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 500 });
    };
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
    for (let i = 0; i < 14; i += 1) {
      raw.addons.push({ profile_id: admin.id, url: `https://s${i}.example`, position: i, enabled: 1 });
    }
    const token = await liveToken(db, admin.id);
    const id = encodeItem("https://s0.example", "movie", "tt100");
    const res = await callApp(createApp(), testEnv(raw), `/Users/${admin.id}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const hosts = new Set(calls.filter((u) => u.includes("/stream/")).map((u) => new URL(u).host));
    expect(hosts.size).toBe(14);
    expect(hosts.has("s12.example")).toBe(true);
    expect(hosts.has("s13.example")).toBe(true);
  });

  it("carries watch-state UserData on movie and series details", async () => {
    const calls: string[] = [];
    installNet(calls);
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const headers = authHeader(token);
    const movieId = encodeItem(ALPHA, "movie", "tt100");

    const fresh = (await (
      await callApp(app, env, `/Users/${adminId}/Items/${movieId}`, { headers })
    ).json()) as { UserData: Record<string, unknown> };
    expect(fresh.UserData).toMatchObject({
      Key: movieId,
      ItemId: movieId,
      Played: false,
      PlaybackPositionTicks: 0,
      PlayCount: 0,
    });

    await callApp(app, env, "/Sessions/Playing/Stopped", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ItemId: movieId, PositionTicks: 6000000000 }),
    });
    const resumed = (await (
      await callApp(app, env, `/Users/${adminId}/Items/${movieId}`, { headers })
    ).json()) as { UserData: Record<string, unknown> };
    expect(resumed.UserData).toMatchObject({
      Key: movieId,
      ItemId: movieId,
      Played: false,
      PlaybackPositionTicks: 6000000000,
    });

    await callApp(app, env, `/Users/${adminId}/PlayedItems/${movieId}`, { method: "POST", headers });
    const played = (await (
      await callApp(app, env, `/Users/${adminId}/Items/${movieId}`, { headers })
    ).json()) as { UserData: Record<string, unknown> };
    expect(played.UserData).toMatchObject({ Played: true });

    const seriesId = encodeItem(ALPHA, "series", "tt200");
    const series = (await (
      await callApp(app, env, `/Users/${adminId}/Items/${seriesId}`, { headers })
    ).json()) as { Type: string; UserData: Record<string, unknown> };
    expect(series.Type).toBe("Series");
    expect(series.UserData).toMatchObject({ Key: seriesId, ItemId: seriesId, Played: false });
  });

  it("computes deterministic MediaSource IDs that remain identical across calls and order shifts", () => {
    const s1 = {
      url: "https://cdn.example/movie.mkv",
      title: "Movie 1080p",
      behaviorHints: { filename: "Movie.2024.1080p.mkv", videoSize: 5000000000 },
    };
    const s2 = {
      url: "https://cdn.example/movie.4k.mkv",
      title: "Movie 2160p",
      streamData: { torrent: { infoHash: "0123456789abcdef0123456789abcdef01234567", fileIdx: 0 } },
    };
    const id1First = mediaSourceIdFor(s1);
    const id2First = mediaSourceIdFor(s2 as unknown as StremioStream);
    expect(id1First).toMatch(/^s_[0-9a-f]{16}$/);
    expect(id2First).toMatch(/^s_[0-9a-f]{16}$/);

    const [id2Second, id1Second] = ([s2, s1] as unknown as StremioStream[]).map(mediaSourceIdFor);
    expect(id1First).toBe(id1Second);
    expect(id2First).toBe(id2Second);
  });

  it("preserves stream name, title, and description in sourceLabel without dropping info", () => {
    const full = sourceLabel(
      {
        name: "[RD+] Torrentio",
        title: "Movie.2024.1080p.BluRay",
        description: "1080p | 5.2 GB | 10 seeds",
      },
      "https://torrentio.example",
    );
    expect(full).toBe("[RD+] Torrentio\nMovie.2024.1080p.BluRay\n1080p | 5.2 GB | 10 seeds");

    const partial = sourceLabel(
      {
        name: "Torrentio",
        title: "Movie.2024.1080p",
      },
      "https://torrentio.example",
    );
    expect(partial).toBe("Torrentio\nMovie.2024.1080p");
  });

  it("identifies HLS and m3u8 containers", () => {
    expect(containerFor("https://cdn.example/live/master.m3u8")).toBe("m3u8");
    expect(containerFor("https://cdn.example/live?format=hls", "stream.m3u8")).toBe("m3u8");
    expect(containerFor("https://cdn.example/live.hls")).toBe("hls");
    expect(containerFor("https://cdn.example/video.mp4")).toBe("mp4");
  });

  it("returns all streams without dropping or capping at MAX_SOURCES", async () => {
    const calls: string[] = [];
    const manyStreams = Array.from({ length: 45 }, (_, i) => ({
      url: `https://cdn.example/stream_${i}.mp4`,
      title: `Stream ${i}`,
    }));
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
      calls.push(url);
      if (url === `${ALPHA}/manifest.json`) {
        return new Response(JSON.stringify({ resources: ["stream"], types: ["movie"], catalogs: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${ALPHA}/stream/movie/tt100.json`) {
        return new Response(JSON.stringify({ streams: manyStreams }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/meta/movie/tt100.json")) {
        return new Response(JSON.stringify({ meta: { id: "tt100", type: "movie", name: "Film" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("down", { status: 500 });
    };

    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 });
    const token = await liveToken(db, admin.id);
    const id = encodeItem(ALPHA, "movie", "tt100");

    const res = await callApp(createApp(), testEnv(raw), `/Users/${admin.id}/Items/${id}/PlaybackInfo`, {
      method: "POST",
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { MediaSources: { Path: string }[] };
    expect(body.MediaSources).toHaveLength(45);
  });

});
