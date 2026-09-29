import { md5Hex } from "./hash";
import { encodePlaceholderMarker } from "./ids";
import { cachedJson, upstreamFetch } from "./cache";
import { notifyFor } from "./health";
import { capableBases, resolveAddonUrls, stremioSegment } from "./library";
import { episodeVideoId, fetchMeta } from "./meta";
import { embeddedSubtitleStream, subtitleLanguage, subtitleStream, type EmbeddedSubtitleTrack, type OfferedTrack, type StremioSubtitle } from "./subtitles";
import { logFailureThrottled } from "./applog";

export const STREAM_TTL_SECONDS = 1800;
export const STREAM_ADDON_USER_AGENT = "AIOStreams/jellino";

export interface StreamBehaviorHints {
  filename?: string;
  videoSize?: number;
  videoHash?: string;
  bingeGroup?: string;
  proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
}

export interface StremioStream {
  url?: string;
  externalUrl?: string;
  title?: string;
  name?: string;
  description?: string;
  infoHash?: string;
  size?: number;
  subtitles?: StremioSubtitle[];
  behaviorHints?: StreamBehaviorHints;
  streamData?: StreamData;
}

interface ParsedMediaTrack {
  lang?: unknown;
  language?: unknown;
  codec?: unknown;
  format?: unknown;
  title?: unknown;
  name?: unknown;
  tag?: unknown;
  channels?: unknown;
  channelLayout?: unknown;
  default?: unknown;
  isDefault?: unknown;
  atmos?: unknown;
  forced?: unknown;
  isForced?: unknown;
  hearingImpaired?: unknown;
  sdh?: unknown;
  commentary?: unknown;
}

export interface ParsedFile {
  subtitleTracks?: unknown;
  subtitles?: unknown;
  audioTracks?: unknown;
  audioTags?: unknown;
  audioChannels?: unknown;
  languages?: unknown;
}

export interface StreamData {
  parsedFile?: ParsedFile;
  duration?: unknown;
  bitrate?: unknown;
}

function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean === "" ? null : clean;
}

export function parsedSubtitleTracks(stream: StremioStream): EmbeddedSubtitleTrack[] {
  const parsed = stream.streamData?.parsedFile;
  const rawTracks = parsed?.subtitleTracks;
  if (Array.isArray(rawTracks)) {
    const out: EmbeddedSubtitleTrack[] = [];
    for (const item of rawTracks) {
      if (!item || typeof item !== "object") continue;
      const track = item as ParsedMediaTrack;
      const language = textOf(track.lang ?? track.language);
      const codec = textOf(track.codec ?? track.format);
      const title = textOf(track.title ?? track.name);
      if (!language && !codec && !title) continue;
      out.push({
        codec,
        language,
        title,
        is_default: track.default === true || track.isDefault === true,
        is_forced: track.forced === true || track.isForced === true,
        is_hearing_impaired: track.hearingImpaired === true || track.sdh === true,
      });
    }
    if (out.length > 0) return out;
  }
  const rawLangs = parsed?.subtitles;
  if (!Array.isArray(rawLangs)) return [];
  const out: EmbeddedSubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const item of rawLangs) {
    const title = textOf(item);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out.push({ codec: null, language: title, title, is_default: false, is_forced: false, is_hearing_impaired: false });
  }
  return out;
}

const PARSED_AUDIO_CODECS: Record<string, string> = {
  "dd+": "eac3",
  dd: "ac3",
  truehd: "truehd",
  "dts-hd ma": "dts",
  "dts-hd": "dts",
  "dts-es": "dts",
  dts: "dts",
  opus: "opus",
  flac: "flac",
  aac: "aac",
};

const JELLINO_AUDIO_CODECS = new Set(["truehd", "eac3", "ac3", "dts", "aac", "flac", "opus", "mp3"]);

function parsedAudioCodec(track: ParsedMediaTrack): string | undefined {
  const tag = textOf(track.tag)?.toLowerCase();
  if (tag && PARSED_AUDIO_CODECS[tag]) return PARSED_AUDIO_CODECS[tag];
  const codec = textOf(track.codec ?? track.format)?.toLowerCase();
  if (codec && JELLINO_AUDIO_CODECS.has(codec)) return codec;
  return undefined;
}

function parsedAudioChannels(track: ParsedMediaTrack): { audioChannels?: string; channelLayout?: number } {
  const raw = textOf(track.channels ?? track.channelLayout)?.toLowerCase();
  if (!raw) return {};
  if (raw.includes("7.1")) return { audioChannels: "7.1", channelLayout: 8 };
  if (raw.includes("6.1")) return { audioChannels: "6.1", channelLayout: 7 };
  if (raw.includes("5.1")) return { audioChannels: "5.1", channelLayout: 6 };
  if (raw.includes("2.0") || raw.includes("stereo")) return { audioChannels: "2.0", channelLayout: 2 };
  return {};
}

export interface StreamAudioTags {
  audioCodec?: string;
  audioChannels?: string;
  channelLayout?: number;
  language?: string;
  profile?: string;
}

function audioProfileFor(
  codec: string | undefined,
  atmosSignalled: boolean,
  track: ParsedMediaTrack | null,
  label: string,
): string | undefined {
  const trackText = `${textOf(track?.codec) ?? ""} ${textOf(track?.title) ?? ""}`;
  const atmos =
    track?.atmos === true ||
    /atmos/i.test(trackText) ||
    (atmosSignalled && (codec === "truehd" || codec === "eac3"));
  if (atmos) return codec === "truehd" ? "Dolby TrueHD + Dolby Atmos" : "Dolby Digital Plus + Dolby Atmos";
  if (codec === "dts" && /dts:?x/i.test(`${trackText} ${label}`)) return "DTS:X";
  if (codec === "dts" && /dts-?hd ?ma/i.test(`${trackText} ${label}`)) return "DTS-HD MA";
  return undefined;
}

function streamLabelText(stream: StremioStream): string {
  return [textOf(stream.name), textOf(stream.title), textOf(stream.description)].filter(Boolean).join(" ");
}

function parsedAudioTagList(parsed: ParsedFile): string[] {
  const raw = Array.isArray(parsed.audioTags) ? parsed.audioTags : [];
  return raw.map((item) => textOf(item) ?? "").filter((item) => item.length > 0);
}

function firstText(value: unknown): string | null {
  if (typeof value === "string") return textOf(value);
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const text = textOf(item);
    if (text) return text;
  }
  return null;
}

export function parsedAudioTags(stream: StremioStream): StreamAudioTags | null {
  const parsed = stream.streamData?.parsedFile;
  if (!parsed || typeof parsed !== "object") return null;
  const rawTracks = parsed.audioTracks;
  if (Array.isArray(rawTracks)) {
    const tracks = rawTracks.filter((item): item is ParsedMediaTrack => !!item && typeof item === "object");
    const picked =
      tracks.find((track) => track.default === true || track.isDefault === true) ??
      tracks.find((track) => track.commentary !== true) ??
      tracks[0];
    if (picked) {
      const audioCodec = parsedAudioCodec(picked);
      if (audioCodec) {
        const out: StreamAudioTags = { audioCodec, ...parsedAudioChannels(picked) };
        const language = textOf(picked.lang ?? picked.language);
        if (language !== null) out.language = language;
        const label = foldLabel(streamLabelText(stream));
        const tags = parsedAudioTagList(parsed);
        const profile = audioProfileFor(audioCodec, tags.some((tag) => /atmos/i.test(tag)) || /atmos/i.test(label), picked, label);
        if (profile) out.profile = profile;
        return out;
      }
    }
  }
  const tagCodec = parsedAudioTagCodec(firstText(parsed.audioTags));
  if (!tagCodec) return null;
  const channels = parsedAudioChannels({ channels: firstText(parsed.audioChannels) ?? undefined });
  const language = firstText(parsed.languages);
  const out: StreamAudioTags = { audioCodec: tagCodec, ...channels };
  if (language !== null) out.language = language;
  const label = streamLabelText(stream);
  const tags = parsedAudioTagList(parsed);
  const profile = audioProfileFor(tagCodec, tags.some((tag) => /atmos/i.test(tag)) || /atmos/i.test(label), null, label);
  if (profile) out.profile = profile;
  return out;
}

function parsedAudioTagCodec(tag: string | null): string | undefined {
  if (!tag) return undefined;
  return PARSED_AUDIO_CODECS[tag.toLowerCase()];
}

export function audioTagsFor(stream: StremioStream, url: string): StreamAudioTags {
  const parsed = parsedAudioTags(stream);
  if (parsed) return parsed;
  const tags = parseTags(tagSource(stream, url));
  const out: StreamAudioTags = {};
  if (tags.audioCodec !== undefined) out.audioCodec = tags.audioCodec;
  if (tags.audioChannels !== undefined) out.audioChannels = tags.audioChannels;
  if (tags.channelLayout !== undefined) out.channelLayout = tags.channelLayout;
  return out;
}

export interface OrderedStream {
  addonUrl: string;
  stream: StremioStream;
}

export function isHttpUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://");
}

export function streamUrl(stream: StremioStream): string | null {
  if (typeof stream.url === "string" && isHttpUrl(stream.url)) return stream.url;
  return null;
}

export function sourceLabel(stream: StremioStream, addonUrl: string): string {
  let host = addonUrl;
  try {
    host = new URL(addonUrl).host;
  } catch {
    host = addonUrl;
  }
  const parts: string[] = [];
  if (stream.name) parts.push(stream.name);
  if (stream.title && !parts.includes(stream.title)) parts.push(stream.title);
  if (stream.description && !parts.includes(stream.description)) parts.push(stream.description);
  if (parts.length === 0) parts.push(host);
  return parts.join("\n");
}

export function streamSize(stream: StremioStream): number | null {
  const raw = stream.behaviorHints?.videoSize ?? stream.size;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

const INTERNAL_SUFFIXES = ["local", "internal", "lan", "home", "docker", "test", "invalid", "localdomain", "localhost"];

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return false;
  const a = nums[0] ?? 0;
  const b = nums[1] ?? 0;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isInternalHost(host: string): boolean {
  const clean = host.trim().replace(/\.+$/, "").toLowerCase();
  if (!clean || clean === "localhost") return true;
  if (clean.includes("::") || /^\[?[0-9a-f:]+]?$/i.test(clean)) return true;
  if (/^0x[0-9a-f]+$/i.test(clean)) return true;
  if (/^\d+$/.test(clean)) return true;
  if (!clean.includes(".")) return true;
  const tail = clean.split(".").pop() ?? "";
  if (INTERNAL_SUFFIXES.includes(tail)) return true;
  if (/^0x[0-9a-f]+$/i.test(tail)) return true;
  if (/^[0-9.]+$/.test(clean)) {
    const parts = clean.split(".");
    if (parts.length === 4) return isPrivateIPv4(clean);
    return true;
  }
  return false;
}

export function rewriteAddonUrl(url: string, manifestUrl: string): string {
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(manifestUrl);
  } catch {
    return url;
  }
  if (!isInternalHost(parsed.hostname)) return url;
  parsed.protocol = origin.protocol;
  parsed.hostname = origin.hostname;
  parsed.port = origin.port;
  return parsed.toString();
}

export interface StreamBreakdown {
  playable: StremioStream[];
  withHeaders: StremioStream[];
  nonHttpFiltered: StremioStream[];
}

export function classifyStreams(streams: StremioStream[]): StreamBreakdown {
  const playable: StremioStream[] = [];
  const withHeaders: StremioStream[] = [];
  const nonHttpFiltered: StremioStream[] = [];
  for (const stream of streams) {
    if (!streamUrl(stream)) {
      nonHttpFiltered.push(stream);
      continue;
    }
    playable.push(stream);
    if (stream.behaviorHints?.proxyHeaders?.request) withHeaders.push(stream);
  }
  return { playable, withHeaders, nonHttpFiltered };
}

export function playableStreams(streams: StremioStream[]): StremioStream[] {
  return classifyStreams(streams).playable;
}

const SMALL_CAPS: Record<string, string> = {
  "\u1D00": "a", "\u0299": "b", "\u1D04": "c", "\u1D05": "d", "\u1D07": "e",
  "\u0493": "f", "\uA730": "f", "\u0262": "g", "\u029C": "h", "\u026A": "i",
  "\u1D0A": "j", "\u1D0B": "k", "\u029F": "l", "\u1D0D": "m", "\u0274": "n",
  "\u1D0F": "o", "\u1D18": "p", "\u01EB": "q", "\u0280": "r", "\uA731": "s",
  "\u1D1B": "t", "\u1D1C": "u", "\u1D20": "v", "\u1D21": "w", "\u028F": "y",
  "\u1D22": "z",
};

const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\uFEFF]/g;

function foldLabel(value: string): string {
  let out = "";
  for (const ch of String(value || "").replace(ZERO_WIDTH, "")) {
    out += SMALL_CAPS[ch] ?? ch;
  }
  return out;
}

export interface ParsedTags {
  width?: number;
  height?: number;
  codec?: string;
  audioCodec?: string;
  audioChannels?: string;
  channelLayout?: number;
  hdr?: string;
}

export function parseTags(text: string): ParsedTags {
  const lower = foldLabel(text).toLowerCase();
  const out: ParsedTags = {};
  const resolution: [RegExp, number, number][] = [
    [/(2160\s?p|4\s?k|uhd)\b/, 3840, 2160],
    [/(1080\s?p|fhd|full\s?hd)\b/, 1920, 1080],
    [/720\s?p\b/, 1280, 720],
    [/480\s?p\b/, 854, 480],
  ];
  for (const [pattern, width, height] of resolution) {
    if (pattern.test(lower)) {
      out.width = width;
      out.height = height;
      break;
    }
  }
  if (/\bhd\b/.test(lower) && !out.height) {
    out.width = 1280;
    out.height = 720;
  }
  const codecs: [RegExp, string][] = [
    [/\bav1\b/, "av1"],
    [/\bvp9\b/, "vp9"],
    [/\b(hevc|x265|h\.265)\b/, "hevc"],
    [/\b(x264|h\.264|avc)\b/, "h264"],
    [/\bmpeg2\b/, "mpeg2"],
    [/\b(xvid|divx|mpeg-?4)\b/, "mpeg4"],
  ];
  for (const [pattern, codec] of codecs) {
    if (pattern.test(lower)) {
      out.codec = codec;
      break;
    }
  }
  const audio: [RegExp, string][] = [
    [/\batmos\b/, "atmos"],
    [/\btruehd\b|\btrue-hd\b/, "truehd"],
    [/\beac3\b|e-ac-3|\bdd\+|ddp|dolby digital plus/, "eac3"],
    [/\bac3\b|ac-3|\bdd\b|dd[ .]?\d|dolby digital(?! plus)/, "ac3"],
    [/\bdts[\s-]*hd(?:[\s-]*ma)?\b|\bdts hd\b|\bdts\b/, "dts"],
    [/\baac\b/, "aac"],
    [/\bflac\b/, "flac"],
    [/\bopus\b/, "opus"],
    [/\bmp3\b/, "mp3"],
  ];
  for (const [pattern, codec] of audio) {
    if (pattern.test(lower)) {
      out.audioCodec = codec;
      break;
    }
  }
  if (/7\.1/.test(lower)) {
    out.audioChannels = "7.1";
    out.channelLayout = 8;
  } else if (/5\.1/.test(lower)) {
    out.audioChannels = "5.1";
    out.channelLayout = 6;
  } else if (/2\.0/.test(lower) || /\bstereo\b/.test(lower)) {
    out.audioChannels = "2.0";
    out.channelLayout = 2;
  }
  if (/dolby.?vision|\bdovi?\b|\bdv\b/.test(lower)) out.hdr = "Dolby Vision";
  else if (/hdr10\+/.test(lower)) out.hdr = "HDR10+";
  else if (/\bhdr10\b|\bhdr\b/.test(lower)) out.hdr = "HDR";
  else if (/\bhlg\b/.test(lower)) out.hdr = "HLG";
  return out;
}

function tagSource(stream: StremioStream, url: string): string {
  return [stream.behaviorHints?.filename ?? "", url, stream.title ?? "", stream.name ?? "", stream.description ?? ""].join(" ");
}

export function bitrateFor(size: number | null, runTimeTicks: number | null): number | null {
  if (size === null || runTimeTicks === null || size <= 0 || runTimeTicks <= 0) return null;
  return Math.round((size * 8) / (runTimeTicks / 10000000));
}

function extOf(value: string): string {
  const head = value.split("?")[0] ?? "";
  const tail = head.split("/").pop() ?? "";
  const dot = tail.lastIndexOf(".");
  return dot < 0 ? "" : tail.slice(dot + 1).toLowerCase();
}

const KNOWN_CONTAINERS = new Set(["mkv", "mp4", "webm", "avi", "mov", "ts", "m2ts", "flv", "wmv", "m3u8", "hls", "mpg", "mpeg"]);

export function containerFor(url: string, filename?: string): string {
  const fromUrl = extOf(url);
  if (KNOWN_CONTAINERS.has(fromUrl)) return fromUrl;
  if (filename) {
    const fromName = extOf(filename);
    if (KNOWN_CONTAINERS.has(fromName)) return fromName;
  }
  return "mp4";
}

async function watchedAddonStreams(
  db: D1Database,
  profileId: string,
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  streamType: string,
  streamId: string,
  now: number,
): Promise<StremioStream[]> {
  try {
    const target = `${base}/stream/${streamType}/${stremioSegment(streamId)}.json`;
    const outcome = await cachedJson<{ streams?: StremioStream[] }>(cache, target, STREAM_TTL_SECONDS, async () => {
      const res = await upstreamFetch(
        fetchImpl,
        target,
        {
          headers: { accept: "application/json", "user-agent": STREAM_ADDON_USER_AGENT },
        },
      );
      if (!res.ok) throw new Error(`stream status ${res.status}`);
      return (await res.json()) as { streams?: StremioStream[] };
    });
    const list = outcome.data?.streams;
    if (!outcome.hit) await notifyFor(db, profileId, base, now)(true, "");
    return Array.isArray(list) ? list : [];
  } catch (error) {
    await notifyFor(db, profileId, base, now)(false, error instanceof Error ? error.message : "fetch failed");
    return [];
  }
}

export interface AddonStreamReport {
  addonUrl: string;
  total: number;
  playable: number;
  withHeaders: number;
  filteredNonHttp: number;
}

async function streamCapableBases(
  cache: Cache,
  fetchImpl: typeof fetch,
  bases: string[],
): Promise<string[]> {
  return capableBases(cache, fetchImpl, bases, "stream");
}

export async function profileStreamReport(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  streamType: string,
  streamId: string,
): Promise<AddonStreamReport[] | null> {
  const resolved = await resolveAddonUrls(db, profileId);
  if (!resolved) return null;
  const urls = await streamCapableBases(cache, fetchImpl, resolved);
  const now = Math.floor(Date.now() / 1000);
  const perAddon = await Promise.all(
    urls.map((base) => watchedAddonStreams(db, profileId, cache, fetchImpl, base, streamType, streamId, now)),
  );
  return perAddon.map((list, i) => {
    const breakdown = classifyStreams(list);
    return {
      addonUrl: urls[i] ?? "",
      total: list.length,
      playable: breakdown.playable.length,
      withHeaders: breakdown.withHeaders.length,
      filteredNonHttp: breakdown.nonHttpFiltered.length,
    };
  });
}

export async function profileStreamsForUrls(
  db: D1Database,
  profileId: string,
  cache: Cache,
  fetchImpl: typeof fetch,
  urls: string[],
  streamType: string,
  streamId: string,
): Promise<OrderedStream[]> {
  const capable = await streamCapableBases(cache, fetchImpl, urls);
  const now = Math.floor(Date.now() / 1000);
  const perAddon = await Promise.all(
    capable.map((base) => watchedAddonStreams(db, profileId, cache, fetchImpl, base, streamType, streamId, now)),
  );
  const ordered: OrderedStream[] = [];
  perAddon.forEach((list, i) => {
    const base = capable[i];
    if (!base) return;
    for (const stream of playableStreams(list)) {
      ordered.push({ addonUrl: base, stream });
    }
  });
  if (ordered.length === 0) {
    await logFailureThrottled(db, `stream:${profileId}:${streamType}:${streamId}`, {
      at: now,
      level: "error",
      category: "stream",
      kind: "zero-streams",
      profileId,
      message: `${streamType}/${streamId}: no playable streams from ${capable.length} capable addon(s)`,
      url: capable[0] ?? "",
    });
  }
  return ordered;
}

export async function warmPlaybackFor(
  db: D1Database,
  profileId: string,
  cache: Cache,
  fetchImpl: typeof fetch,
  streamType: string,
  stremioId: string,
  season?: number | null,
  episode?: number | null,
): Promise<void> {
  void db;
  void profileId;
  void cache;
  void fetchImpl;
  void streamType;
  void stremioId;
  void season;
  void episode;
}

export interface SourceSubtitles {
  itemId: string;
  tracks: OfferedTrack[];
  apiKey?: string | null;
  embedded?: EmbeddedSubtitleTrack[];
}

export interface StreamSelection {
  audio?: number | null | undefined;
  subtitle?: number | null | undefined;
  mediaSourceId?: string | null | undefined;
  profile?: unknown;
  userAgent?: string | null | undefined;
}

export function mediaSourceIdFor(stream: StremioStream): string {
  const data = (stream?.streamData && typeof stream.streamData === "object" ? stream.streamData : {}) as {
    torrent?: { infoHash?: string; fileIdx?: number };
    nzbUrl?: string;
    releaseKey?: string;
    service?: { id?: string };
  };
  const infoHash = data?.torrent?.infoHash || stream?.infoHash;
  const fileIdx = data?.torrent?.fileIdx;
  const identity = infoHash
    ? `${infoHash}:${fileIdx ?? ""}`
    : typeof data?.nzbUrl === "string" && data.nzbUrl
      ? data.nzbUrl
      : typeof data?.releaseKey === "string" && data.releaseKey
        ? data.releaseKey
        : "";

  if (identity) {
    const raw = md5Hex([String(data?.service?.id ?? ""), identity].join("\u0000"));
    return `s_${raw.slice(0, 16)}`;
  }

  const size = Number(stream?.behaviorHints?.videoSize ?? stream?.size);
  const filename = String(stream?.behaviorHints?.filename || "").trim();
  const parts = [filename, Number.isFinite(size) && size > 0 ? String(size) : ""];

  if (!filename) {
    parts.push(
      foldLabel(String(stream?.name || "")).trim().toLowerCase(),
      foldLabel(String(stream?.title || stream?.description || "")).trim().toLowerCase(),
      String(stream?.url || stream?.externalUrl || "").trim()
    );
  }

  const raw = md5Hex(parts.join("\u0000"));
  return `s_${raw.slice(0, 16)}`;
}

export function orderSourcesFirst(
  sources: Record<string, unknown>[],
  requestedId: string | null | undefined,
): Record<string, unknown>[] {
  if (!requestedId) return sources;
  let pos = sources.findIndex((s) => String(s.Id ?? "") === requestedId);
  if (pos < 0) {
    const match = /^src(\d+)$/.exec(requestedId);
    if (match) {
      const idx = Number(match[1]);
      if (idx >= 0 && idx < sources.length) {
        pos = idx;
      }
    }
  }
  if (pos <= 0) return sources;
  const picked = sources[pos];
  if (!picked) return sources;
  return [picked, ...sources.slice(0, pos), ...sources.slice(pos + 1)];
}

export function mediaSource(
  index: number,
  addonUrl: string,
  stream: StremioStream,
  runTimeTicks: number | null,
  subtitles?: SourceSubtitles,
  selection?: StreamSelection,
): Record<string, unknown> {
  const sourceId = mediaSourceIdFor(stream);
  const url = rewriteAddonUrl(streamUrl(stream) as string, addonUrl);
  const label = sourceLabel(stream, addonUrl);
  const tags = parseTags(tagSource(stream, url));
  const size = streamSize(stream);
  const bitrate = bitrateFor(size, runTimeTicks);
  const resLabel = tags.height ? (tags.height >= 2160 ? "4K" : tags.height >= 1080 ? "1080p" : tags.height >= 720 ? "720p" : "480p") : "";
  const codecLabel = tags.codec ? tags.codec.toUpperCase() : "";
  const hdrLabel = tags.hdr ?? "";
  const videoTitle = [resLabel, codecLabel, hdrLabel].filter(Boolean).join(" ") || label;
  const video: Record<string, unknown> = {
    Codec: tags.codec ?? null,
    Type: "Video",
    Index: 0,
    IsDefault: true,
    DisplayTitle: videoTitle,
    AspectRatio: "16:9",
  };
  if (tags.width !== undefined) video.Width = tags.width;
  if (tags.height !== undefined) video.Height = tags.height;
  if (tags.hdr === "Dolby Vision") {
    video.VideoRange = "HDR";
    video.VideoRangeType = "DOVI";
    video.VideoDoViTitle = "Dolby Vision";
  } else if (tags.hdr === "HDR10+") {
    video.VideoRange = "HDR";
    video.VideoRangeType = "HDR10Plus";
  } else if (tags.hdr === "HDR") {
    video.VideoRange = "HDR";
    video.VideoRangeType = "HDR10";
  } else if (tags.hdr === "HLG") {
    video.VideoRange = "HDR";
    video.VideoRangeType = "HLG";
  }
  const tracks: Record<string, unknown>[] = [video];
  const audio = audioTagsFor(stream, url);
  if (audio.audioCodec) {
    const title = audio.audioChannels ? `${audio.audioCodec.toUpperCase()} ${audio.audioChannels}` : audio.audioCodec.toUpperCase();
    const audioStream: Record<string, unknown> = {
      Codec: audio.audioCodec,
      Type: "Audio",
      Index: 1,
      IsDefault: true,
      DisplayTitle: title,
    };
    if (audio.language !== undefined) audioStream.Language = subtitleLanguage(audio.language);
    if (audio.channelLayout !== undefined) audioStream.Channels = audio.channelLayout;
    if (audio.audioChannels !== undefined) audioStream.ChannelLayout = audio.audioChannels;
    if (audio.profile !== undefined) audioStream.Profile = audio.profile;
    tracks.push(audioStream);
  }
  if (subtitles) {
    const baseIndex = audio.audioCodec ? 2 : 1;
    const embedded = Array.isArray(subtitles.embedded) ? subtitles.embedded : [];
    embedded.forEach((track, i) => tracks.push(embeddedSubtitleStream(track, baseIndex + i)));
    const subStart = baseIndex + embedded.length;
    for (let n = 0; n < subtitles.tracks.length; n += 1) {
      const track = subtitles.tracks[n];
      if (track) tracks.push(subtitleStream(subtitles.itemId, sourceId, track, subStart + n, subtitles.apiKey));
    }
  }
  const dto: Record<string, unknown> = {
    Id: sourceId,
    ETag: sourceId,
    Protocol: "Http",
    Type: "Default",
    Name: label,
    Path: url,
    IsRemote: true,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: false,
    RequiredHttpHeaders:
      stream.behaviorHints?.proxyHeaders?.request ??
      (stream.behaviorHints?.proxyHeaders as { Request?: Record<string, string> } | undefined)?.Request ??
      (stream.behaviorHints as { headers?: Record<string, string> } | undefined)?.headers ??
      {},
    Container: containerFor(url, stream.behaviorHints?.filename),
    MediaStreams: tracks,
    DirectStreamUrl: url,
    VideoType: "VideoFile",
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: false,
    TranscodingSubProtocol: "http",
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    HasSegments: false,
  };
  if (size !== null) dto.Size = size;
  if (bitrate !== null) dto.Bitrate = bitrate;
  if (audio.audioCodec) {
    const wantedAudio = selection?.audio;
    dto.DefaultAudioStreamIndex =
      wantedAudio !== null && wantedAudio !== undefined && tracks.some((t) => t.Type === "Audio" && t.Index === wantedAudio)
        ? wantedAudio
        : 1;
  }
  const wantedSubtitle = selection?.subtitle;
  dto.DefaultSubtitleStreamIndex =
    wantedSubtitle !== null && wantedSubtitle !== undefined && tracks.some((t) => t.Type === "Subtitle" && t.Index === wantedSubtitle)
      ? wantedSubtitle
      : null;
  if (runTimeTicks !== null) dto.RunTimeTicks = runTimeTicks;
  return dto;
}

function placeholderMediaSource(id: string, name: string, path: string): Record<string, unknown> {
  return {
    Protocol: "Http",
    Id: id,
    Path: path,
    Type: "Placeholder",
    Container: "mp4",
    Name: name,
    IsRemote: true,
    ETag: id,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    HasSegments: false,
    IsInfiniteStream: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    SupportsProbing: true,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    TranscodingSubProtocol: "http",
    VideoType: "VideoFile",
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    MediaStreams: [
      {
        Type: "Video",
        Index: 0,
        Codec: "h264",
        IsDefault: true,
        IsForced: false,
        IsHearingImpaired: false,
        IsOriginal: false,
        IsExternal: false,
        IsInterlaced: false,
        IsTextSubtitleStream: false,
        SupportsExternalStream: false,
        DisplayTitle: name,
      },
    ],
  };
}

export function placeholderMediaSources(itemId: string): Record<string, unknown>[] {
  const path = `/Videos/${itemId}/stream`;
  return [
    placeholderMediaSource(itemId, "Streams load when played", path),
    placeholderMediaSource(encodePlaceholderMarker(itemId), "Load the stream list", path),
  ];
}
