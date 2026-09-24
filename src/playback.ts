import type { Context, Hono } from "hono";
import type { Env } from "./db";
import { decodeItem, decodePlaceholderMarker } from "./ids";
import { cacheKey } from "./cache";
import { queryIgnoreCase } from "./query";
import { clientInfo } from "./applog";
import { catalogBases } from "./library";
import { itemKey } from "./watch-state";
import { episodeVideoId, fetchMeta, imdbFor, runtimeTicks } from "./meta";
import { bearerToken, verifiedOwner } from "./session";
import { mediaSource, mediaSourceIdFor, orderSourcesFirst, profileStreamReport, profileStreamsForUrls, rewriteAddonUrl, streamUrl, parsedSubtitleTracks, audioTagsFor, STREAM_ADDON_USER_AGENT, type StreamSelection } from "./streams";
import {
  codeForLanguageName,
  fetchAllAddonSubtitles,
  formatOf,
  languageName,
  logSubtitleServe,
  pickSubtitles,
  profileSubtitleReport,
  recallOffered,
  rememberOffered,
  streamSubtitleTracks,
  subtitleBody,
  subtitleExtrasFromHints,
  subtitleExtensionOf,
  subtitleFormatFor,
  subtitleMenuLanguage,
  SUBTITLES_MAX,
  SUBTITLES_PER_LANGUAGE,
  type OfferedTrack,
  type SubtitleOffer,
  type SubtitleTrack,
} from "./subtitles";

function streamTarget(id: string): { streamType: string; streamId: string } | null {
  const decoded = decodeItem(id);
  if (!decoded) return null;
  if (decoded.kind === "season" || decoded.kind === "collection") return null;
  if (decoded.kind === "movie") return { streamType: "movie", streamId: decoded.stremioId };
  if (decoded.kind === "episode") {
    return { streamType: "series", streamId: `${decoded.stremioId}:${decoded.season ?? 0}:${decoded.episode ?? 0}` };
  }
  return { streamType: "series", streamId: decoded.stremioId };
}

async function playbackOwner(c: Context<{ Bindings: Env }>, userId: string | undefined): Promise<string | null> {
  return verifiedOwner(c.env.DB, c.req.raw, Math.floor(Date.now() / 1000), userId);
}

async function profileSources(
  c: Context<{ Bindings: Env }>,
  profileId: string,
  id: string,
): Promise<Record<string, unknown>[] | null> {
  const { client, device } = clientInfo(c.req.raw);
  return profileMediaSources(
    c.env.DB,
    caches.default,
    fetch,
    profileId,
    id,
    await requestSelection(c),
    bearerToken(c.req.raw),
    true,
    `${client || "unknown client"}${device ? ` on ${device}` : ""}`,
  );
}

async function playbackResponse(
  c: Context<{ Bindings: Env }>,
  profileId: string,
  id: string,
): Promise<Response> {
  const sources = await profileSources(c, profileId, id);
  if (!sources) return c.json({ error: "not found" }, 404);
  return c.json({ MediaSources: sources, PlaySessionId: crypto.randomUUID() });
}

async function mediaSourcesResponse(
  c: Context<{ Bindings: Env }>,
  profileId: string,
  id: string,
): Promise<Response> {
  const sources = await profileSources(c, profileId, id);
  return c.json(sources ?? []);
}

function selectionNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : null;
}

async function requestSelection(c: Context<{ Bindings: Env }>): Promise<StreamSelection> {
  let body: Record<string, unknown> = {};
  if (c.req.method === "POST") {
    try {
      const parsed: unknown = await c.req.json();
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  const query = (name: string): string | undefined => queryIgnoreCase(c, name);
  const rawMediaId =
    (typeof body.MediaSourceId === "string" && body.MediaSourceId.trim() ? String(body.MediaSourceId) : undefined) ??
    (typeof body.mediaSourceId === "string" && body.mediaSourceId.trim() ? String(body.mediaSourceId) : undefined) ??
    query("MediaSourceId");
  const profile = body.DeviceProfile ?? body.deviceProfile;
  return {
    audio: selectionNumber(body.AudioStreamIndex ?? body.audioStreamIndex ?? query("AudioStreamIndex")),
    subtitle: selectionNumber(body.SubtitleStreamIndex ?? body.subtitleStreamIndex ?? query("SubtitleStreamIndex")),
    mediaSourceId: rawMediaId && rawMediaId.trim() ? rawMediaId.trim() : null,
    ...(profile !== undefined && profile !== null && typeof profile === "object" ? { profile } : {}),
    ...(c.req.header("user-agent") ? { userAgent: c.req.header("user-agent") as string } : {}),
  };
}

async function streamLookupId(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  streamType: string,
  streamId: string,
): Promise<string> {
  const metaType = streamType === "series" ? "series" : "movie";
  if (streamType === "series") {
    const match = /^(.*):(\d+):(\d+)$/.exec(streamId);
    if (!match?.[1]) return streamId;
    const tt = await imdbFor(db, cache, fetchImpl, metaType, match[1]);
    return tt ? `${tt}:${match[2]}:${match[3]}` : streamId;
  }
  return (await imdbFor(db, cache, fetchImpl, metaType, streamId)) ?? streamId;
}

function mergeSubtitleTracks(streamTracks: SubtitleTrack[], addonTracks: SubtitleTrack[]): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const track of [...streamTracks, ...addonTracks]) {
    if (seen.has(track.url)) continue;
    seen.add(track.url);
    out.push(track);
  }
  return out;
}

function offeredTracks(tracks: SubtitleTrack[], selection?: StreamSelection): OfferedTrack[] {
  const withLanguage = tracks.map((track) => ({
    ...track,
    language: subtitleMenuLanguage(track.lang, codeForLanguageName),
  }));
  const picked = pickSubtitles(withLanguage, SUBTITLES_PER_LANGUAGE, SUBTITLES_MAX);
  return picked.map((track) => ({
    url: track.url,
    lang: track.language,
    title: languageName(track.language) ?? track.lang,
    ordinal: track.ordinal,
    format: subtitleFormatFor(selection?.profile, selection?.userAgent ?? undefined, subtitleExtensionOf(track.url)),
  }));
}

async function resolvePlaybackStreams(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  decoded: NonNullable<ReturnType<typeof decodeItem>>,
  target: { streamType: string; streamId: string },
): Promise<{ urls: string[]; metaType: string; resolved: Awaited<ReturnType<typeof fetchMeta>>; streamId: string; found: Awaited<ReturnType<typeof profileStreamsForUrls>> } | null> {
  const urls = await catalogBases(db, profileId);
  if (!urls) return null;
  const metaType = decoded.kind === "movie" ? "movie" : "series";
  const orderedBases = [decoded.addonUrl, ...urls.filter((b) => b !== decoded.addonUrl)];
  const resolved = await fetchMeta(cache, fetchImpl, orderedBases, decoded.addonUrl, metaType, decoded.stremioId);
  const videoId = decoded.kind === "episode" ? episodeVideoId(resolved?.meta, decoded.season, decoded.episode) : null;
  const streamId = await streamLookupId(db, cache, fetchImpl, target.streamType, videoId ?? target.streamId);
  const found = await profileStreamsForUrls(db, profileId, cache, fetchImpl, urls, target.streamType, streamId);
  return { urls, metaType, resolved, streamId, found };
}

export async function profileMediaSources(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  id: string,
  selection?: StreamSelection,
  apiKey?: string | null,
  withAddonSubtitles = false,
  menuOrigin?: string,
): Promise<Record<string, unknown>[] | null> {
  const decoded = decodeItem(id);
  if (!decoded) return null;
  const target = streamTarget(id);
  if (!target) return null;
  const streams = await resolvePlaybackStreams(db, cache, fetchImpl, profileId, decoded, target);
  if (!streams) return null;
  const { urls, metaType, resolved, streamId, found } = streams;

  const hintsStream = found?.[0]?.stream;
  const addonTracks = withAddonSubtitles
    ? await fetchAllAddonSubtitles(
        cache,
        fetchImpl,
        urls,
        metaType,
        streamId,
        subtitleExtrasFromHints(hintsStream?.behaviorHints),
        STREAM_ADDON_USER_AGENT,
      )
    : [];

  const ticks = resolved ? runtimeTicks(resolved.meta.runtime) : null;
  const key = itemKey(id);
  let savedSourceId: string | null = null;
  let savedSubtitleIndex: number | null = null;
  if (key) {
    const saved = await db
      .prepare("SELECT media_source_id AS mediaSourceId, subtitle_index AS subtitleIndex FROM watch_state WHERE profile_id = ?1 AND item_key = ?2")
      .bind(profileId, key)
      .first<{ mediaSourceId?: string | null; subtitleIndex?: number | null }>()
      .catch(() => null);
    if (saved?.mediaSourceId) savedSourceId = saved.mediaSourceId;
    if (saved?.subtitleIndex !== undefined && saved?.subtitleIndex !== null) savedSubtitleIndex = saved.subtitleIndex;
  }
  const effectiveSelection = {
    ...selection,
    subtitle: selection?.subtitle ?? savedSubtitleIndex ?? undefined,
  };
  const built: Record<string, unknown>[] = [];
  let advertisedExternal = 0;
  let embeddedCount = 0;
  for (const [i, g] of (found ?? []).entries()) {
    const embedded = parsedSubtitleTracks(g.stream);
    const streamTracks = streamSubtitleTracks(g.stream);
    const tracks = offeredTracks(mergeSubtitleTracks(streamTracks, addonTracks), selection);
    const startIndex = (audioTagsFor(g.stream, streamUrl(g.stream) ?? "").audioCodec ? 2 : 1) + embedded.length;
    const sourceId = mediaSourceIdFor(g.stream);
    await rememberOffered(cache, profileId, id, sourceId, { embedded: startIndex, tracks });
    advertisedExternal += tracks.length;
    embeddedCount += embedded.length;
    built.push(
      mediaSource(i, g.addonUrl, g.stream, ticks, { itemId: id, tracks, apiKey: apiKey ?? null, embedded }, effectiveSelection),
    );
  }
  if (selection?.profile) {
    const menuKey = cacheKey(`https://jellino.local/sub-menu/${profileId}/${id}`);
    const seen = await cache.match(menuKey).catch(() => undefined);
    if (!seen) {
      await logSubtitleServe(db, {
        at: Math.floor(Date.now() / 1000),
        profileId,
        itemId: id,
        index: -1,
        format: "",
        outcome: `menu: ${advertisedExternal} external, ${embeddedCount} embedded · ${menuOrigin ?? "unknown client"}`,
        ms: 0,
        size: 0,
        url: "",
      }).catch(() => undefined);
      await cache.put(menuKey, new Response("1", { headers: { "cache-control": "public, max-age=300" } })).catch(() => undefined);
    }
  }
  const wanted = selection?.mediaSourceId || savedSourceId;
  if (!wanted || wanted === id) return built;
  return orderSourcesFirst(built, wanted);
}

async function rebuildOffer(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  id: string,
  sourceId: string,
): Promise<SubtitleOffer | null> {
  const decoded = decodeItem(id);
  const target = streamTarget(id);
  if (!decoded || !target) return null;
  const streams = await resolvePlaybackStreams(db, cache, fetchImpl, profileId, decoded, target);
  if (!streams) return null;
  const { urls, metaType, streamId, found } = streams;
  const slot = /^src(\d+)$/.exec(sourceId);
  const picked =
    found.find((g, i) => mediaSourceIdFor(g.stream) === sourceId || `src${i}` === sourceId) ??
    (slot?.[1] !== undefined ? found[Number(slot[1])] : undefined) ??
    null;
  if (!picked) return null;
  const addonTracks = await fetchAllAddonSubtitles(
    cache,
    fetchImpl,
    urls,
    metaType,
    streamId,
    subtitleExtrasFromHints(picked.stream.behaviorHints),
    STREAM_ADDON_USER_AGENT,
  );
  const embedded = parsedSubtitleTracks(picked.stream);
  const tracks = offeredTracks(mergeSubtitleTracks(streamSubtitleTracks(picked.stream), addonTracks));
  const offer: SubtitleOffer = {
    embedded: (audioTagsFor(picked.stream, streamUrl(picked.stream) ?? "").audioCodec ? 2 : 1) + embedded.length,
    tracks,
  };
  await rememberOffered(cache, profileId, id, sourceId, offer);
  return offer;
}

export function registerPlayback(app: Hono<{ Bindings: Env }>) {
  async function playbackTarget(
    c: Context<{ Bindings: Env }>,
    userId: string | undefined,
  ): Promise<{ profileId: string; id: string } | Response> {
    const profileId = await playbackOwner(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const raw = c.req.param("id");
    const id = raw ? (decodePlaceholderMarker(raw) ?? raw) : "";
    if (!id) return c.json({ error: "not found" }, 404);
    return { profileId, id };
  }

  async function playbackInfo(c: Context<{ Bindings: Env }>, userId: string | undefined) {
    const target = await playbackTarget(c, userId);
    if (target instanceof Response) return target;
    return playbackResponse(c, target.profileId, target.id);
  }

  async function mediaSourcesFor(c: Context<{ Bindings: Env }>, userId: string | undefined) {
    const target = await playbackTarget(c, userId);
    if (target instanceof Response) return target;
    return mediaSourcesResponse(c, target.profileId, target.id);
  }

  app.post("/Items/:id/PlaybackInfo", (c) => playbackInfo(c, undefined));
  app.get("/Items/:id/PlaybackInfo", (c) => playbackInfo(c, undefined));
  app.post("/Users/:userId/Items/:id/PlaybackInfo", (c) => playbackInfo(c, c.req.param("userId")));
  app.get("/Users/:userId/Items/:id/PlaybackInfo", (c) => playbackInfo(c, c.req.param("userId")));

  app.get("/Items/:id/MediaSources", (c) => mediaSourcesFor(c, undefined));
  app.get("/Users/:userId/Items/:id/MediaSources", (c) => mediaSourcesFor(c, c.req.param("userId")));

  app.get("/Users/:userId/Items/:id/StreamReport", async (c) => {
    const profileId = await playbackOwner(c, c.req.param("userId"));
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const target = id ? streamTarget(id) : null;
    if (!id || !target) return c.json({ error: "not found" }, 404);
    const report = await profileStreamReport(c.env.DB, caches.default, fetch, profileId, target.streamType, target.streamId);
    if (!report) return c.json({ error: "not found" }, 404);
    const subId = await streamLookupId(c.env.DB, caches.default, fetch, target.streamType, target.streamId);
    const subtitles =
      (await profileSubtitleReport(c.env.DB, caches.default, fetch, profileId, target.streamType, subId)) ?? [];
    return c.json({ ItemId: id, Addons: report, Subtitles: subtitles });
  });

  async function videoRedirect(c: Context<{ Bindings: Env }>) {
    const profileId = await playbackOwner(c, c.req.query("userId") ?? c.req.query("UserId"));
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const rawId = c.req.param("id");
    const id = rawId ? (decodePlaceholderMarker(rawId) ?? rawId) : "";
    if (!id) return c.json({ error: "not found" }, 404);
    const target = streamTarget(id);
    if (!target) return c.json({ error: "not found" }, 404);
    const urls = await catalogBases(c.env.DB, profileId);
    if (!urls) return c.json({ error: "not found" }, 404);
    const streamId = await streamLookupId(c.env.DB, caches.default, fetch, target.streamType, target.streamId);
    const found = await profileStreamsForUrls(c.env.DB, profileId, caches.default, fetch, urls, target.streamType, streamId);
    if (!found || found.length === 0) return c.json({ error: "not found" }, 404);
    const wanted = c.req.query("mediaSourceId") ?? c.req.query("MediaSourceId") ?? c.req.query("mediaSourceID");
    let picked = found[0];
    if (wanted) {
      const direct = found.find((g, i) => mediaSourceIdFor(g.stream) === wanted || `src${i}` === wanted);
      if (direct) {
        picked = direct;
      } else {
        const slot = /^src(\d+)$/.exec(wanted);
        if (slot?.[1] !== undefined) {
          const candidate = found[Number(slot[1])];
          if (candidate) picked = candidate;
        }
      }
    }
    if (!picked) return c.json({ error: "not found" }, 404);
    const raw = streamUrl(picked.stream);
    if (!raw) return c.json({ error: "not found" }, 404);
    const path = rewriteAddonUrl(raw, picked.addonUrl);
    if (!path.startsWith("https://") && !path.startsWith("http://")) return c.json({ error: "not found" }, 404);
    return c.redirect(path, 302);
  }

  app.get("/Videos/:id/stream", (c) => videoRedirect(c));
  app.get("/Videos/:id/:file{stream\\..+}", (c) => videoRedirect(c));
  app.get("/Videos/:id/stream/:filename", (c) => videoRedirect(c));
  app.get("/Videos/:id/original", (c) => videoRedirect(c));
  app.get("/Videos/:id/:file{original\\..+}", (c) => videoRedirect(c));
  app.get("/Videos/:id/original/:filename", (c) => videoRedirect(c));

  async function videosSubtitle(c: Context<{ Bindings: Env }>) {
    const now = Math.floor(Date.now() / 1000);
    const profileId = await playbackOwner(c, c.req.query("userId") ?? c.req.query("UserId"));
    const id = c.req.param("id") ?? "";
    const sourceId = c.req.param("sourceId") ?? "";
    const index = Number(c.req.param("index"));
    const file = c.req.param("file") ?? "";
    const format = formatOf(file.split(".").pop() ?? "");
    const qShape = [...new URL(c.req.url).searchParams.keys()].sort().join("+").slice(0, 40) || "none";
    const fail = async (outcome: string, status: number): Promise<Response> => {
      await logSubtitleServe(c.env.DB, {
        at: now,
        profileId: profileId ?? "anonymous",
        itemId: id,
        index: Number.isInteger(index) ? index : -1,
        format: file,
        outcome: outcome.slice(0, 200),
        ms: 0,
        size: 0,
        url: "",
      }).catch(() => undefined);
      return c.json({ error: "not found" }, status as 400 | 401 | 404 | 502);
    };
    if (!profileId) return fail(`401 unauthorized q=${qShape}`, 401);
    if (!Number.isInteger(index) || index < 0) return fail(`404 bad index q=${qShape}`, 404);

    let offer = await recallOffered(caches.default, profileId, id, sourceId);
    if (!offer) offer = await rebuildOffer(c.env.DB, caches.default, fetch, profileId, id, sourceId);
    const track = offer ? offer.tracks[index - offer.embedded] : undefined;
    if (!track) return fail(`404 unknown track q=${qShape}`, 404);

    const t0 = Date.now();
    const body = await subtitleBody(caches.default, fetch, track.url, format, track.lang);
    if (!body) {
      await logSubtitleServe(c.env.DB, {
        at: now,
        profileId,
        itemId: id,
        index,
        format: file,
        outcome: `502 upstream fetch failed q=${qShape}`,
        ms: Date.now() - t0,
        size: 0,
        url: track.url,
      }).catch(() => undefined);
      return c.body(null, 502);
    }
    await logSubtitleServe(c.env.DB, {
      at: now,
      profileId,
      itemId: id,
      index,
      format: file,
      outcome: `served ${format} q=${qShape}`,
      ms: Date.now() - t0,
      size: body.body.length,
      url: track.url,
    }).catch(() => undefined);
    return c.body(body.body, 200, {
      "content-type": body.contentType,
      "cache-control": "private, max-age=3600",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
    });
  }

  app.get("/Videos/:id/:sourceId/Subtitles/:index/Stream", (c) => videosSubtitle(c));
  app.get("/Videos/:id/:sourceId/Subtitles/:index/:file{Stream\\..+}", (c) => videosSubtitle(c));
  app.get("/Videos/:id/:sourceId/Subtitles/:index/:ticks{\\d+}/Stream", (c) => videosSubtitle(c));
  app.get("/Videos/:id/:sourceId/Subtitles/:index/:ticks{\\d+}/:file{Stream\\..+}", (c) => videosSubtitle(c));
}
