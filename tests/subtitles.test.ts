import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeItem } from "../src/ids";
import {
  convertSubtitle,
  decodeSubtitleBytes,
  fetchAddonSubtitles,
  formatOf,
  pickSubtitles,
  recallOffered,
  rememberOffered,
  streamSubtitleTracks,
  subtitleCodecFor,
  subtitleExtensionOf,
  subtitleFormatFor,
  subtitleMenuLanguage,
  subtitleStream,
  type OfferedTrack,
} from "../src/subtitles";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
const ASS = [
  "[Script Info]",
  "Title: Test",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hello{\\i0}",
  "",
].join("\n");

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
  raw.addons.push({ profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 });
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser.Client="test", Token="${token}"` };
}

interface NetOptions {
  subtitles?: unknown[];
  subtitleStatus?: number;
  subtitleBody?: string;
  subtitleContentType?: string;
  streamSubtitles?: unknown[];
  streamData?: unknown;
}

function installNet(opts: NetOptions = {}) {
  const store = new Map<string, string>();
  const calls: string[] = [];
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
      return Response.json({
        streams: [
          {
            url: "https://cdn.example/a.mp4",
            ...(opts.streamSubtitles ? { subtitles: opts.streamSubtitles } : {}),
            ...(opts.streamData ? { streamData: opts.streamData } : {}),
          },
        ],
      });
    }
    if (url.startsWith(`${ALPHA}/subtitles/movie/tt100`)) {
      return Response.json({ subtitles: opts.subtitles ?? [] });
    }
    if (url.startsWith("https://cdn.example/")) {
      if (opts.subtitleStatus !== undefined && opts.subtitleStatus !== 200) {
        return new Response("blocked", { status: opts.subtitleStatus });
      }
      return new Response(opts.subtitleBody ?? SRT, {
        headers: { "content-type": opts.subtitleContentType ?? "text/srt" },
      });
    }
    return new Response("down", { status: 500 });
  };
  return { calls, store };
}

async function playbackSubs(
  opts: NetOptions = {},
  init: { headers?: Record<string, string>; body?: string } = {},
) {
  const net = installNet(opts);
  const { raw, db, adminId } = await household();
  const token = await liveToken(db, adminId);
  const app = createApp();
  const env = testEnv(raw);
  const id = encodeItem(ALPHA, "movie", "tt100");
  const info = await callApp(app, env, `/Items/${id}/PlaybackInfo`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body ?? "{}",
  });
  expect(info.status).toBe(200);
  const payload = (await info.json()) as { MediaSources: { Id: string; MediaStreams: Record<string, unknown>[] }[] };
  const subs = (payload.MediaSources[0]?.MediaStreams ?? []).filter((s) => s.Type === "Subtitle");
  return { ...net, app, env, id, token, adminId, subs, payload };
}

describe("subtitle helpers (AIOMetadata method)", () => {
  it("maps languages to the bibliographic code clients match on", () => {
    expect(subtitleMenuLanguage("en", () => undefined)).toBe("eng");
    expect(subtitleMenuLanguage("fr", () => undefined)).toBe("fre");
    expect(subtitleMenuLanguage("de", () => undefined)).toBe("ger");
    expect(subtitleMenuLanguage("deu", () => undefined)).toBe("ger");
    expect(subtitleMenuLanguage("ara", () => undefined)).toBe("ara");
    expect(subtitleMenuLanguage("Arabic", (name) => String(name).toLowerCase().startsWith("arab") ? "ara" : undefined)).toBe("ara");
    expect(subtitleMenuLanguage("und", () => undefined)).toBe("und");
  });

  it("negotiates the advertised format exactly like the reference", () => {
    const assProfile = { SubtitleProfiles: [{ Method: "External", Format: "ssa" }] };
    const vttProfile = { SubtitleProfiles: [{ Method: "External", Format: "webvtt" }] };
    const srtProfile = { SubtitleProfiles: [{ Method: "External", Format: "subrip" }] };
    expect(subtitleFormatFor(assProfile, undefined, "ass")).toBe("ass");
    expect(subtitleFormatFor(assProfile, undefined, "srt")).toBe("ass");
    expect(subtitleFormatFor(vttProfile, undefined, "srt")).toBe("vtt");
    expect(subtitleFormatFor(srtProfile, undefined, "srt")).toBe("srt");
    expect(subtitleFormatFor(undefined, "Kodi/20.5", "srt")).toBe("srt");
    expect(subtitleFormatFor(undefined, undefined, "srt")).toBe("vtt");
  });

  it("maps file names and extensions to formats", () => {
    expect(formatOf("vtt")).toBe("vtt");
    expect(formatOf("srt")).toBe("srt");
    expect(formatOf("subrip")).toBe("srt");
    expect(formatOf("ass")).toBe("ass");
    expect(formatOf("ssa")).toBe("ass");
    expect(formatOf("json")).toBe("json");
    expect(formatOf("weird")).toBe("vtt");
    expect(subtitleExtensionOf("https://cdn.example/en.srt?x=1")).toBe("srt");
    expect(subtitleExtensionOf("https://cdn.example/en.vtt")).toBe("vtt");
    expect(subtitleExtensionOf("https://cdn.example/en.ass")).toBe("ass");
    expect(subtitleExtensionOf("https://cdn.example/track")).toBe("srt");
    expect(subtitleCodecFor("vtt")).toBe("webvtt");
    expect(subtitleCodecFor("ass")).toBe("ass");
    expect(subtitleCodecFor("srt")).toBe("subrip");
  });

  it("picks a few per language round-robin so a late language is not lost", () => {
    const tracks = [
      { url: "a1", language: "ara" },
      { url: "a2", language: "ara" },
      { url: "a3", language: "ara" },
      { url: "a4", language: "ara" },
      { url: "e1", language: "eng" },
      { url: "e2", language: "eng" },
    ];
    const picked = pickSubtitles(tracks, 3, 40);
    expect(picked.map((t) => t.url)).toEqual(["a1", "e1", "a2", "e2", "a3"]);
    expect(picked.map((t) => t.ordinal)).toEqual([1, 1, 2, 2, 3]);
    expect(pickSubtitles(tracks, 3, 2).map((t) => t.url)).toEqual(["a1", "e1"]);
  });

  it("converts cues to the requested format", () => {
    const vtt = convertSubtitle(SRT, "srt", "vtt");
    expect(vtt.contentType).toBe("text/vtt; charset=utf-8");
    expect(vtt.body).toContain("WEBVTT");
    expect(vtt.body).toContain("00:00:01.000 --> 00:00:02.000");
    expect(vtt.body).toContain("Hello");

    const srt = convertSubtitle(SRT, "srt", "srt");
    expect(srt.contentType).toBe("application/x-subrip; charset=utf-8");
    expect(srt.body).toBe(SRT);

    const assToVtt = convertSubtitle(ASS, "ass", "vtt");
    expect(assToVtt.body).toContain("Hello");
    expect(assToVtt.body).not.toContain("{\\i1}");

    const ass = convertSubtitle(ASS, "ass", "ass");
    expect(ass.contentType).toBe("text/x-ssa; charset=utf-8");
    expect(ass.body).toContain("Dialogue:");

    const json = convertSubtitle(SRT, "srt", "json");
    expect(JSON.parse(json.body)).toEqual({
      TrackEvents: [{ Id: "1", Text: "Hello", StartPositionTicks: 10000000, EndPositionTicks: 20000000 }],
    });

    const unknown = convertSubtitle("not cues", "sup", "vtt");
    expect(unknown.contentType).toBe("text/plain; charset=utf-8");
  });

  it("decodes BOM, UTF-16 and language-hinted legacy Arabic", () => {
    expect(decodeSubtitleBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]).buffer)).toBe("A");
    expect(decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00]).buffer)).toBe("A");
    const arabic = new Uint8Array([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]).buffer;
    expect(decodeSubtitleBytes(arabic, "ara")).toBe("مرحبا");
  });

  it("advertises the exact reference field set with the delivery url", () => {
    const track: OfferedTrack = { url: "https://cdn.example/en.srt", lang: "eng", title: "English", ordinal: 2, format: "vtt" };
    const stream = subtitleStream("item1", "src1", track, 5, "tok");
    expect(stream).toMatchObject({
      Type: "Subtitle",
      Index: 5,
      Codec: "webvtt",
      Language: "eng",
      Title: "English 2",
      DisplayTitle: "English 2 (external)",
      IsDefault: false,
      IsForced: false,
      IsHearingImpaired: false,
      IsOriginal: false,
      IsInterlaced: false,
      IsExternal: true,
      IsExternalUrl: false,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: "External",
    });
    expect(stream.DeliveryUrl).toBe("/Videos/item1/src1/Subtitles/5/0/Stream.vtt?ApiKey=tok");
    expect(stream.Path).toBe(stream.DeliveryUrl);
    expect(subtitleStream("item1", "src1", track, 5).DeliveryUrl).toBe("/Videos/item1/src1/Subtitles/5/0/Stream.vtt");
  });

  it("reads stream-attached subtitles in order and skips MicroDVD", () => {
    const tracks = streamSubtitleTracks({
      subtitles: [
        { id: "a", url: "https://cdn.example/a.srt", lang: "eng" },
        { id: "b", url: "https://cdn.example/a.srt", lang: "eng" },
        { id: "c", url: "https://cdn.example/b.sub", lang: "eng" },
        { id: "d", url: "https://cdn.example/c.ass", lang: "ara" },
      ],
    });
    expect(tracks.map((t) => t.url)).toEqual(["https://cdn.example/a.srt", "https://cdn.example/c.ass"]);
    expect(tracks[0]?.source).toBe("stream");
  });
});

describe("subtitle list fetching", () => {
  it("fetches the addon list once with the file hints and keeps it", async () => {
    const { calls, store } = installNet({ subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }] });
    void store;
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
    const hints = { videoHash: "abc", filename: "Film.2024.mkv" };
    const first = await fetchAddonSubtitles(cache, fetch, ALPHA, "movie", "tt100", hints);
    expect(first.map((t) => t.url)).toEqual(["https://cdn.example/en.srt"]);
    const listCalls = calls.filter((url) => url.startsWith(`${ALPHA}/subtitles/`));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toContain("videoHash=abc");
    expect(listCalls[0]).toContain("filename=Film.2024.mkv");

    const second = await fetchAddonSubtitles(cache, fetch, ALPHA, "movie", "tt100", hints);
    expect(second.map((t) => t.url)).toEqual(["https://cdn.example/en.srt"]);
    expect(calls.filter((url) => url.startsWith(`${ALPHA}/subtitles/`))).toHaveLength(1);
  });

  it("answers empty on a failed list and does not retry", async () => {
    installNet({ subtitles: [] });
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
    const tracks = await fetchAddonSubtitles(cache, async () => new Response("nope", { status: 500 }), ALPHA, "movie", "tt100", undefined);
    expect(tracks).toEqual([]);
  });
});

describe("offer store", () => {
  it("round-trips the offered tracks per owner/item/source", async () => {
    installNet();
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
    const offer = { embedded: 2, tracks: [{ url: "https://cdn.example/en.srt", lang: "eng", title: "English", ordinal: 1, format: "vtt" as const }] };
    await rememberOffered(cache, "p1", "item", "src", offer);
    expect(await recallOffered(cache, "p1", "item", "src")).toEqual(offer);
    expect(await recallOffered(cache, "p2", "item", "src")).toBeNull();
  });
});

describe("playback advertisement and delivery", () => {
  it("advertises round-robin tracks with delivery urls and serves the clicked one", async () => {
    const { app, env, token, subs } = await playbackSubs({
      subtitles: [
        { id: "ar1", url: "https://cdn.example/ar1.srt", lang: "ara" },
        { id: "en1", url: "https://cdn.example/en1.srt", lang: "eng" },
      ],
    });
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({ Index: 1, Language: "ara", Codec: "webvtt", Title: "Arabic", DisplayTitle: "Arabic (external)", DeliveryMethod: "External", IsExternal: true });
    expect(subs[1]).toMatchObject({ Index: 2, Language: "eng" });
    expect(String(subs[0]?.DeliveryUrl)).toMatch(/^\/Videos\/.+\/Subtitles\/1\/0\/Stream\.vtt\?ApiKey=/);
    expect(subs[0]?.Path).toBe(subs[0]?.DeliveryUrl);

    const click = await callApp(app, env, String(subs[0]?.DeliveryUrl));
    expect(click.status).toBe(200);
    expect(click.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(click.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(await click.text()).toContain("Hello");
    expect(token).toBeTruthy();
  });

  it("serves the exact srt bytes when the client asks for srt", async () => {
    const { app, env, subs } = await playbackSubs({
      subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }],
    });
    const url = String(subs[0]?.DeliveryUrl).replace("Stream.vtt", "Stream.srt");
    const click = await callApp(app, env, url);
    expect(click.status).toBe(200);
    expect(click.headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    expect(await click.text()).toBe(SRT);
  });

  it("keeps ass styling when the profile accepts ass", async () => {
    const { app, env, subs } = await playbackSubs(
      { subtitles: [{ id: "ar", url: "https://cdn.example/movie.ass", lang: "ara" }], subtitleBody: ASS, subtitleContentType: "text/x-ssa" },
      { body: JSON.stringify({ DeviceProfile: { SubtitleProfiles: [{ Method: "External", Format: "ssa" }] } }) },
    );
    expect(subs[0]).toMatchObject({ Codec: "ass", Language: "ara" });
    expect(String(subs[0]?.DeliveryUrl)).toContain("Stream.ass");
    const click = await callApp(app, env, String(subs[0]?.DeliveryUrl));
    expect(click.status).toBe(200);
    expect(click.headers.get("content-type")).toBe("text/x-ssa; charset=utf-8");
    expect(await click.text()).toContain("Dialogue:");
  });

  it("forces srt for kodi clients", async () => {
    const { subs } = await playbackSubs(
      { subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }] },
      { headers: { "user-agent": "Kodi/20.5" } },
    );
    expect(subs[0]).toMatchObject({ Codec: "subrip" });
    expect(String(subs[0]?.DeliveryUrl)).toContain("Stream.srt");
  });

  it("indexes external tracks after embedded ones", async () => {
    const { subs } = await playbackSubs({
      subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }],
      streamData: { parsedFile: { subtitleTracks: [{ lang: "eng", codec: "subrip" }] } },
    });
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({ Index: 1, DeliveryMethod: "Embed", IsExternal: false });
    expect(subs[1]).toMatchObject({ Index: 2, DeliveryMethod: "External" });
  });

  it("advertises stream-attached tracks alongside addon ones", async () => {
    const { subs } = await playbackSubs({
      streamSubtitles: [{ id: "attached", url: "https://cdn.example/attached.srt", lang: "eng" }],
      subtitles: [{ id: "addon", url: "https://cdn.example/addon.srt", lang: "ara" }],
    });
    expect(subs.map((s) => s.Language)).toEqual(["eng", "ara"]);
    expect(subs).toHaveLength(2);
  });

  it("serves 502 when the upstream file fails, without trying another track", async () => {
    const { app, env, calls, subs } = await playbackSubs({
      subtitles: [
        { id: "dead", url: "https://cdn.example/dead.srt", lang: "eng" },
        { id: "alive", url: "https://cdn.example/alive.srt", lang: "eng" },
      ],
      subtitleStatus: 500,
    });
    const first = String(subs[0]?.DeliveryUrl);
    const click = await callApp(app, env, first);
    expect(click.status).toBe(502);
    expect(await click.text()).toBe("");
    expect(calls.filter((url) => url.includes("dead.srt"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("alive.srt"))).toBe(false);
  });

  it("never proxies OpenSubtitles links through a third-party service", async () => {
    const { app, env, calls, subs } = await playbackSubs({
      subtitles: [
        { id: "subsense-srt-opensubtitles-eng-0", url: "https://dl.opensubtitles.org/en/download/vrf-1/file/1.srt", lang: "eng" },
      ],
      subtitleStatus: 401,
    });
    const click = await callApp(app, env, String(subs[0]?.DeliveryUrl));
    expect(click.status).toBe(502);
    expect(calls.some((url) => url.includes("subsense"))).toBe(false);
    expect(calls.some((url) => url.includes("/api/subtitle/ass/"))).toBe(false);
    expect(calls.filter((url) => url.includes("dl.opensubtitles.org"))).toHaveLength(1);
  });

  it("rebuilds the offer when the edge record expired between menu and click", async () => {
    const { app, env, store, calls, subs } = await playbackSubs({
      subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }],
    });
    store.clear();
    const click = await callApp(app, env, String(subs[0]?.DeliveryUrl));
    expect(click.status).toBe(200);
    expect(await click.text()).toContain("Hello");
    expect(calls.filter((url) => url === `${ALPHA}/stream/movie/tt100.json`).length).toBeGreaterThanOrEqual(2);
  });

  it("rebuilds when the stored offer no longer holds the requested index", async () => {
    const { app, env, id, adminId, subs, payload } = await playbackSubs({
      subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }],
    });
    const cache = (globalThis as unknown as { caches: { default: Cache } }).caches.default;
    const sourceId = String(payload.MediaSources[0]?.Id ?? "src0");
    await rememberOffered(cache, adminId, id, sourceId, { embedded: 1, tracks: [] });
    const click = await callApp(app, env, String(subs[0]?.DeliveryUrl));
    expect(click.status).toBe(200);
    expect(await click.text()).toContain("Hello");
  });

  it("404s an index that was never offered", async () => {
    const { app, env, id, token } = await playbackSubs({
      subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }],
    });
    const click = await callApp(app, env, `/Videos/${id}/src0/Subtitles/99/0/Stream.vtt?ApiKey=${token}`);
    expect(click.status).toBe(404);
  });

  it("401s an anonymous click", async () => {
    const { app, env, subs } = await playbackSubs({
      subtitles: [{ id: "en", url: "https://cdn.example/en.srt", lang: "eng" }],
    });
    const url = String(subs[0]?.DeliveryUrl).replace(/\?.*$/, "");
    const click = await callApp(app, env, url);
    expect(click.status).toBe(401);
  });

  it("no longer answers the legacy /Items subtitle route", async () => {
    const { app, env, id, token } = await playbackSubs();
    const legacy = await callApp(app, env, `/Items/${id}/Subtitles/sub0/Stream.vtt`, { headers: authHeader(token) });
    expect(legacy.headers.get("content-type") ?? "").not.toContain("text/vtt");
    expect(await legacy.text()).not.toContain("WEBVTT");
  });
});
