import type { D1Database } from "@cloudflare/workers-types";
import { cacheKey, upstreamFetch, upstreamTimeoutMs } from "./cache";
import { capableBases, resolveAddonUrls, stremioSegment } from "./library";
import { logApp } from "./applog";


const SUBTITLE_FETCH_TIMEOUT_MS = 15000;
const MAX_SUBTITLE_FILE_BYTES = 5 * 1024 * 1024;
export const SUBTITLES_PER_LANGUAGE = 8;
export const SUBTITLES_MAX = 40;
export const SUBTITLE_LIST_TTL_SECONDS = 3600;
const SUBTITLE_BODY_TTL_SECONDS = 3600;
const SUBTITLE_OFFER_TTL_SECONDS = 3600;

const VTT_TYPE = "text/vtt; charset=utf-8";
const SRT_TYPE = "application/x-subrip; charset=utf-8";
const ASS_TYPE = "text/x-ssa; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

const SUBTITLE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export type SubtitleFormat = "vtt" | "srt" | "ass" | "json";

export interface StremioSubtitle {
  id?: string;
  url: unknown;
  lang?: string;
  format?: string;
  subType?: string;
  title?: string;
  fileName?: string;
  subtitleFileName?: string;
  movieReleaseName?: string;
  season?: number;
  episode?: number;
}

export interface SubtitleTrack {
  id: string;
  url: string;
  lang: string;
  source: "stream" | "addon";
}

export interface OfferedTrack {
  url: string;
  lang: string;
  title: string;
  ordinal: number;
  format: SubtitleFormat;
}

export interface SubtitleOffer {
  embedded: number;
  tracks: OfferedTrack[];
}


const TWO_LETTER: Record<string, string> = {
  en: "eng", ja: "jpn", fr: "fre", de: "ger", es: "spa", it: "ita", pt: "por", ru: "rus", ko: "kor", zh: "chi",
  hi: "hin", ar: "ara", nl: "dut", pl: "pol", sv: "swe", da: "dan", fi: "fin", no: "nor", tr: "tur", cs: "cze",
  hu: "hun", el: "gre", he: "heb", th: "tha", vi: "vie", id: "ind", uk: "ukr", ro: "rum", bg: "bul", hr: "hrv",
  sr: "srp", sk: "slo", sl: "slv", ms: "may", fa: "per", ta: "tam", te: "tel", bn: "ben", ca: "cat", eu: "baq",
  gl: "glg", et: "est", lv: "lav", lt: "lit", is: "ice", ga: "gle", mk: "mac", sq: "alb", bs: "bos", tl: "tgl",
};

const TO_BIBLIOGRAPHIC: Record<string, string> = {
  deu: "ger", fra: "fre", nld: "dut", ell: "gre", ron: "rum", ces: "cze", slk: "slo", zho: "chi", fas: "per",
  msa: "may", mya: "bur", isl: "ice", eus: "baq", sqi: "alb", hye: "arm", kat: "geo", mkd: "mac", bod: "tib",
  cym: "wel", pob: "por", pb: "por",
};

const ISO1_TO_ISO3: Record<string, string> = {
  en: "eng", es: "spa", fr: "fra", de: "deu", it: "ita", pt: "por", nl: "nld", ru: "rus", ja: "jpn",
  zh: "zho", ar: "ara", hi: "hin", ko: "kor", tr: "tur", pl: "pol", cs: "ces", sk: "slk", ro: "ron",
  hu: "hun", el: "ell", he: "heb", th: "tha", vi: "vie", id: "ind", ms: "msa", uk: "ukr", bg: "bul",
  hr: "hrv", sr: "srp", da: "dan", fi: "fin", no: "nor", nb: "nob", sv: "swe", ca: "cat", fa: "fas",
};

const LANGUAGE_NAMES: Record<string, string> = {
  eng: "English", spa: "Spanish", fra: "French", fre: "French", deu: "German", ger: "German", ita: "Italian",
  por: "Portuguese", nld: "Dutch", dut: "Dutch", rus: "Russian", jpn: "Japanese", zho: "Chinese", chi: "Chinese",
  ara: "Arabic", hin: "Hindi", kor: "Korean", tur: "Turkish", pol: "Polish", ces: "Czech", cze: "Czech",
  slk: "Slovak", slo: "Slovak", ron: "Romanian", rum: "Romanian", hun: "Hungarian", ell: "Greek", gre: "Greek",
  heb: "Hebrew", tha: "Thai", vie: "Vietnamese", ind: "Indonesian", msa: "Malay", may: "Malay", ukr: "Ukrainian",
  bul: "Bulgarian", hrv: "Croatian", srp: "Serbian", dan: "Danish", fin: "Finnish", nor: "Norwegian",
  nob: "Norwegian", swe: "Swedish", cat: "Catalan", fas: "Persian", per: "Persian",
};

const FULLNAME_TO_ISO3: Record<string, string> = {
  english: "eng", spanish: "spa", french: "fra", german: "deu", italian: "ita", portuguese: "por",
  dutch: "nld", russian: "rus", japanese: "jpn", chinese: "zho", arabic: "ara", hindi: "hin",
  korean: "kor", turkish: "tur", polish: "pol", czech: "ces", slovak: "slk", romanian: "ron",
  hungarian: "hun", greek: "ell", hebrew: "heb", thai: "tha", vietnamese: "vie", indonesian: "ind",
  malay: "msa", ukrainian: "ukr", bulgarian: "bul", croatian: "hrv", serbian: "srp", danish: "dan",
  finnish: "fin", norwegian: "nor", swedish: "swe", catalan: "cat", persian: "fas",
};

export function subtitleMenuLanguage(lang: string, byName: (name: unknown) => string | undefined): string {
  const raw = String(lang || "").trim();
  const key = raw.toLowerCase().replace(/[-_].*$/, "");
  const bibliographic = TO_BIBLIOGRAPHIC[key];
  if (bibliographic) return bibliographic;
  if (/^[a-z]{3}$/.test(key)) return key;
  const two = TWO_LETTER[key];
  if (two) return two;
  return byName(raw) ?? key;
}

export function codeForLanguageName(name: unknown): string | undefined {
  return FULLNAME_TO_ISO3[String(name ?? "").trim().toLowerCase()];
}

export function subtitleLanguage(lang: string | undefined): string {
  if (!lang) return "und";
  const clean = lang.trim().toLowerCase().replace(/[_-].*$/, "");
  if (/^[a-z]{3}$/.test(clean)) return clean;
  if (ISO1_TO_ISO3[clean]) return ISO1_TO_ISO3[clean] as string;
  return FULLNAME_TO_ISO3[clean] ?? "und";
}

function subtitleDisplayName(code: string, fallback: string): string {
  return LANGUAGE_NAMES[code] ?? fallback;
}

export function languageName(code: string): string | undefined {
  return LANGUAGE_NAMES[code];
}


export function subtitleExtensionOf(url: string): string {
  const ext = ((url.split("?")[0] ?? "").split("#")[0] ?? "").split(".").pop() ?? "";
  const lower = ext.toLowerCase();
  return /^(srt|vtt|ass|ssa|sub|sup)$/.test(lower) ? lower : "srt";
}

export function subtitleCodecFor(format: SubtitleFormat | string): string {
  switch (format) {
    case "vtt":
    case "webvtt":
      return "webvtt";
    case "ass":
    case "ssa":
      return "ass";
    default:
      return "subrip";
  }
}

export function formatOf(raw: string): SubtitleFormat {
  const f = String(raw || "").toLowerCase();
  if (f === "js" || f === "json") return "json";
  if (f === "srt" || f === "subrip") return "srt";
  if (f === "ass" || f === "ssa") return "ass";
  return "vtt";
}

export function subtitleFormatFor(profile: unknown, clientName: string | undefined, sourceExtension: string): SubtitleFormat {
  const holder = (profile ?? {}) as { SubtitleProfiles?: unknown };
  const formats = new Set<string>();
  for (const p of Array.isArray(holder.SubtitleProfiles) ? holder.SubtitleProfiles : []) {
    const rec = (p ?? {}) as Record<string, unknown>;
    if (String(rec.Method ?? "").toLowerCase() !== "external") continue;
    const f = String(rec.Format ?? "").toLowerCase();
    if (f) formats.add(f === "subrip" ? "srt" : f === "webvtt" ? "vtt" : f);
  }
  const ext = sourceExtension.toLowerCase();
  if ((ext === "ass" || ext === "ssa") && (formats.has("ass") || formats.has("ssa"))) return "ass";
  if (/kodi/i.test(clientName ?? "")) return "srt";
  if (formats.has("vtt")) return "vtt";
  if (formats.has("srt")) return "srt";
  if (formats.has("ass") || formats.has("ssa")) return "ass";
  return "vtt";
}

export function pickSubtitles<T extends { language: string }>(
  tracks: T[],
  perLanguage: number,
  total: number,
): Array<T & { ordinal: number }> {
  const byLanguage = new Map<string, T[]>();
  for (const track of tracks) {
    const list = byLanguage.get(track.language) ?? [];
    if (list.length < perLanguage) list.push(track);
    byLanguage.set(track.language, list);
  }
  const out: Array<T & { ordinal: number }> = [];
  for (let round = 0; round < perLanguage && out.length < total; round++) {
    for (const list of byLanguage.values()) {
      if (out.length >= total) break;
      const entry = list[round];
      if (entry) out.push({ ...entry, ordinal: round + 1 });
    }
  }
  return out;
}


interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

function normaliseText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function timeToMs(text: string): number | null {
  const m = TIME.exec(text.trim());
  if (!m) return null;
  if (m[1] !== undefined) {
    return (
      Number(m[1]) * 3_600_000 +
      Number(m[2] ?? 0) * 60_000 +
      Number(m[3] ?? 0) * 1000 +
      Number((m[4] ?? "").padEnd(3, "0"))
    );
  }
  return Number(m[5] ?? 0) * 60_000 + Number(m[6] ?? 0) * 1000 + Number((m[7] ?? "").padEnd(3, "0"));
}

function parseCues(input: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of normaliseText(input).split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)/.test(lines[0] ?? "")) continue;
    const arrow = lines.findIndex((l) => l.includes("-->"));
    if (arrow === -1) continue;
    const [start, end] = (lines[arrow] ?? "").split("-->");
    const startMs = timeToMs(start ?? "");
    const endMs = timeToMs((end ?? "").trim());
    if (startMs === null || endMs === null) continue;
    cues.push({ startMs, endMs, text: lines.slice(arrow + 1).join("\n") });
  }
  return cues;
}

function parseAssCues(input: string): Cue[] {
  const cues: Cue[] = [];
  let textIndex = 9;
  for (const line of normaliseText(input).split("\n")) {
    const format = /^\s*Format:\s*(.+)$/i.exec(line);
    if (format) {
      const at = (format[1] ?? "").split(",").map((f) => f.trim().toLowerCase()).indexOf("text");
      if (at >= 0) textIndex = at;
      continue;
    }
    const dialogue = /^\s*Dialogue:\s*(.+)$/i.exec(line);
    if (!dialogue) continue;
    const parts = (dialogue[1] ?? "").split(",");
    if (parts.length <= textIndex) continue;
    const startMs = timeToMs(parts[1] ?? "");
    const endMs = timeToMs(parts[2] ?? "");
    if (startMs === null || endMs === null) continue;
    const text = parts.slice(textIndex).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nnh]/g, "\n").trim();
    if (text) cues.push({ startMs, endMs, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function stamp(ms: number, separator: "." | ","): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

function cuesToVtt(cues: Cue[]): string {
  const body = cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${c.text}`).join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

function cuesToSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, ",")} --> ${stamp(c.endMs, ",")}\n${c.text}`).join("\n\n") + "\n";
}

function cuesToJellyfinJson(cues: Cue[]): string {
  return JSON.stringify({
    TrackEvents: cues.map((c, i) => ({
      Id: String(i + 1),
      Text: c.text,
      StartPositionTicks: Math.round(c.startMs * 10_000),
      EndPositionTicks: Math.round(c.endMs * 10_000),
    })),
  });
}

export function convertSubtitle(body: string, fromExtension: string, to: SubtitleFormat): { body: string; contentType: string } {
  const from = fromExtension.toLowerCase();
  const styled = from === "ass" || from === "ssa";
  const textual = from === "srt" || from === "vtt" || from === "sub";
  const cuesOf = () => (styled ? parseAssCues(body) : textual ? parseCues(body) : []);

  if (to === "json") return { body: cuesToJellyfinJson(cuesOf()), contentType: JSON_TYPE };
  if (to === "ass") {
    if (styled) return { body: normaliseText(body), contentType: ASS_TYPE };
    return { body: cuesToSrt(cuesOf()), contentType: SRT_TYPE };
  }
  if (to === "vtt") {
    if (from === "vtt") return { body: normaliseText(body), contentType: VTT_TYPE };
    const cues = cuesOf();
    if (cues.length) return { body: cuesToVtt(cues), contentType: VTT_TYPE };
    return { body: normaliseText(body), contentType: "text/plain; charset=utf-8" };
  }
  if (from === "srt") return { body: normaliseText(body), contentType: SRT_TYPE };
  const cues = cuesOf();
  if (cues.length) return { body: cuesToSrt(cues), contentType: SRT_TYPE };
  return { body: normaliseText(body), contentType: "text/plain; charset=utf-8" };
}


function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const WIN1256_TABLE = "\u20AC\u067E\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0679\u2039\u0152\u0686\u0698\u0688\u06AF\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u06A9\u2122\u0691\u203A\u0153\u200C\u200D\u06BA\u00A0\u060C\u00A2\u00A3\u00A4\u00A5\u00A6\u00A7\u00A8\u00A9\u0640\u00AB\u00AC\u00AD\u00AE\u00AF\u00B0\u00B1\u00B2\u00B3\u00B4\u00B5\u00B6\u00B7\u00B8\u00B9\u061B\u00BB\u00BC\u00BD\u00BE\u061F\u06C1\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062A\u062B\u062C\u062D\u062E\u062F\u0630\u0631\u0632\u0633\u0634\u0635\u0636\u00D7\u0637\u0638\u0639\u063A\u0640\u0641\u0642\u0643\u00E0\u0644\u00E2\u0645\u0646\u0647\u0648\u00E7\u00E8\u00E9\u00EA\u00EB\u0649\u064A\u00EE\u00EF\u064B\u064C\u064D\u064E\u00F4\u064F\u0650\u00F7\u0651\u00F9\u0652\u00FB\u00FC\u200E\u200F\u06D2";

function decodeWindows1256(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b === undefined) continue;
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else {
      out += WIN1256_TABLE[b - 0x80] ?? "";
    }
  }
  return out;
}

const SUBTITLE_LEGACY_ENCODING: Record<string, string> = {
  ara: "windows-1256", fas: "windows-1256", urd: "windows-1256",
  heb: "windows-1255",
  ell: "windows-1253",
  tur: "windows-1254", aze: "windows-1254",
  ces: "windows-1250", slk: "windows-1250", pol: "windows-1250", hun: "windows-1250",
  ron: "windows-1250", hrv: "windows-1250", srp: "windows-1250", slv: "windows-1250",
  bos: "windows-1250",
  rus: "windows-1251", ukr: "windows-1251", bul: "windows-1251", bel: "windows-1251", mkd: "windows-1251",
  lav: "windows-1257", lit: "windows-1257", est: "windows-1257",
  vie: "windows-1258",
  tha: "windows-874",
  zho: "gbk", jpn: "shift_jis", kor: "euc-kr",
};

async function decompressIfNeeded(input: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(input);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      if (typeof DecompressionStream !== "undefined") {
        const stream = new Response(input).body?.pipeThrough(new DecompressionStream("gzip"));
        if (stream) {
          return await new Response(stream).arrayBuffer();
        }
      }
    } catch {
      void 0;
    }
  }
  return input;
}

export function decodeSubtitleBytes(input: ArrayBuffer, lang?: string): string {
  const bytes = new Uint8Array(input);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3)).replace(/^\uFEFF/, "");
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.slice(2)).replace(/^\uFEFF/, "");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.slice(2)).replace(/^\uFEFF/, "");
  }
  let evenNul = 0;
  let oddNul = 0;
  const sample = Math.min(bytes.length, 4096);
  for (let i = 0; i < sample; i += 1) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) evenNul += 1;
      else oddNul += 1;
    }
  }
  if (evenNul + oddNul > 0) {
    try {
      return new TextDecoder(evenNul > oddNul ? "utf-16be" : "utf-16le").decode(bytes).replace(/^\uFEFF/, "");
    } catch {
      void 0;
    }
  }
  if (isValidUtf8(bytes)) return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const hint = typeof lang === "string" ? subtitleLanguage(lang) : "und";
  const label = SUBTITLE_LEGACY_ENCODING[hint] ?? "windows-1252";
  if (label === "windows-1256") {
    return decodeWindows1256(bytes).replace(/^\uFEFF/, "");
  }
  try {
    return new TextDecoder(label).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  }
}


export function subtitleExtrasFromHints(
  hints: { videoHash?: string; videoSize?: number; filename?: string } | undefined,
): Record<string, string> | undefined {
  const hash = typeof hints?.videoHash === "string" ? hints.videoHash.trim() : "";
  const filename = typeof hints?.filename === "string" ? hints.filename.trim() : "";
  if (hash === "" && filename === "") return undefined;
  const out: Record<string, string> = {};
  if (hash !== "") out.videoHash = hash;
  if (typeof hints?.videoSize === "number" && hints.videoSize > 0) out.videoSize = String(Math.floor(hints.videoSize));
  if (filename !== "") out.filename = filename;
  return out;
}

function subtitleListUrl(base: string, subType: string, subId: string, extras?: Record<string, string>): string {
  const parts = extras
    ? Object.entries(extras).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    : [];
  const segment = parts.length > 0 ? `/${parts.join("&")}` : "";
  return `${base}/subtitles/${subType}/${stremioSegment(subId)}${segment}.json`;
}

function isErrorSubtitleEntry(entry: StremioSubtitle | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id === "string" && entry.id.startsWith("error.")) return true;
  return typeof entry.lang === "string" && entry.lang.includes("❌");
}

function splitSubtitleEntries(list: StremioSubtitle[]): { tracks: StremioSubtitle[]; errorNotes: string[] } {
  const tracks: StremioSubtitle[] = [];
  const errorNotes: string[] = [];
  for (const entry of list) {
    if (!entry) continue;
    if (isErrorSubtitleEntry(entry)) {
      const note = (typeof entry.lang === "string" && entry.lang.length > 0 ? entry.lang : (entry.id ?? ""))
        .replace(/\[❌\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (note && !errorNotes.includes(note)) errorNotes.push(note.slice(0, 200));
      continue;
    }
    tracks.push(entry);
  }
  return { tracks, errorNotes };
}

function isHttpSubUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function isSupportedSubtitleUrl(value: unknown): boolean {
  if (!isHttpSubUrl(value)) return false;
  const bare = value.trim().split(/[?#]/)[0] ?? "";
  return !bare.toLowerCase().endsWith(".sub");
}

function listCacheKey(target: string): Request {
  return cacheKey(`https://jellino.local/sub-list?u=${encodeURIComponent(target)}`);
}

export async function fetchAddonSubtitles(
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  subType: string,
  videoId: string,
  hints: Record<string, string> | undefined,
  userAgent: string = SUBTITLE_USER_AGENT,
): Promise<SubtitleTrack[]> {
  const target = subtitleListUrl(base, subType, videoId, hints);
  const key = listCacheKey(target);
  try {
    const stored = await cache.match(key);
    if (stored) {
      const parsed = (await stored.json()) as { tracks?: SubtitleTrack[] };
      if (Array.isArray(parsed?.tracks)) return parsed.tracks;
    }
  } catch {
    void 0;
  }
  let res: Response;
  try {
    res = await upstreamFetch(
      fetchImpl,
      target,
      { headers: { accept: "application/json", "user-agent": userAgent } },
      Math.min(upstreamTimeoutMs(), SUBTITLE_FETCH_TIMEOUT_MS),
    );
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let body: { subtitles?: StremioSubtitle[] };
  try {
    body = (await res.json()) as { subtitles?: StremioSubtitle[] };
  } catch {
    return [];
  }
  const { tracks } = splitSubtitleEntries(Array.isArray(body?.subtitles) ? body.subtitles : []);
  const out = collectSubtitleTracks(tracks, "addon");
  try {
    await cache.put(
      key,
      new Response(JSON.stringify({ tracks: out }), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${SUBTITLE_LIST_TTL_SECONDS}` },
      }),
    );
  } catch {
    void 0;
  }
  return out;
}

export async function fetchAllAddonSubtitles(
  cache: Cache,
  fetchImpl: typeof fetch,
  urls: string[],
  subType: string,
  videoId: string,
  hints: Record<string, string> | undefined,
  userAgent: string = SUBTITLE_USER_AGENT,
): Promise<SubtitleTrack[]> {
  if (!videoId) return [];
  const bases = await capableBases(cache, fetchImpl, urls, "subtitles");
  const lists = await Promise.all(
    bases.map((base) => fetchAddonSubtitles(cache, fetchImpl, base, subType, videoId, hints, userAgent)),
  );
  const out: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const track of list) {
      if (seen.has(track.url)) continue;
      seen.add(track.url);
      out.push(track);
    }
  }
  return out;
}

export function streamSubtitleTracks(stream: { subtitles?: StremioSubtitle[] } | undefined): SubtitleTrack[] {
  return collectSubtitleTracks(Array.isArray(stream?.subtitles) ? stream.subtitles : [], "stream");
}

function collectSubtitleTracks(entries: StremioSubtitle[], source: "stream" | "addon"): SubtitleTrack[] {
  const out: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const url = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (!url || seen.has(url) || !isSupportedSubtitleUrl(url)) continue;
    seen.add(url);
    out.push({ id: String(entry.id ?? url), url, lang: String(entry.lang ?? "und"), source });
  }
  return out;
}


function offerKey(owner: string, itemId: string, sourceId: string): Request {
  return cacheKey(
    `https://jellino.local/sub-offer?o=${encodeURIComponent(owner)}&i=${encodeURIComponent(itemId)}&s=${encodeURIComponent(sourceId)}`,
  );
}

export async function rememberOffered(
  cache: Cache,
  owner: string,
  itemId: string,
  sourceId: string,
  offer: SubtitleOffer,
): Promise<void> {
  try {
    await cache.put(
      offerKey(owner, itemId, sourceId),
      new Response(JSON.stringify(offer), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${SUBTITLE_OFFER_TTL_SECONDS}` },
      }),
    );
  } catch {
    void 0;
  }
}

export async function recallOffered(
  cache: Cache,
  owner: string,
  itemId: string,
  sourceId: string,
): Promise<SubtitleOffer | null> {
  try {
    const stored = await cache.match(offerKey(owner, itemId, sourceId));
    if (!stored) return null;
    const parsed = (await stored.json()) as SubtitleOffer;
    if (!Array.isArray(parsed?.tracks)) return null;
    return { embedded: typeof parsed.embedded === "number" ? parsed.embedded : 0, tracks: parsed.tracks };
  } catch {
    return null;
  }
}


export function subtitleStream(
  itemId: string,
  sourceId: string,
  track: OfferedTrack,
  index: number,
  apiKey?: string | null,
): Record<string, unknown> {
  const query = apiKey ? `?${new URLSearchParams({ ApiKey: apiKey }).toString()}` : "";
  const path = `/Videos/${itemId}/${sourceId}/Subtitles/${index}/0/Stream.${track.format}`.replace(/\/{2,}/g, "/");
  const suggested = track.ordinal > 1 ? `${track.title} ${track.ordinal}` : track.title;
  return {
    Type: "Subtitle",
    Index: index,
    Codec: subtitleCodecFor(track.format),
    Language: track.lang,
    Title: suggested,
    DisplayTitle: `${suggested} (external)`,
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
    DeliveryUrl: `${path}${query}`,
    Path: `${path}${query}`,
  };
}


function bodyCacheKey(url: string, to: SubtitleFormat): Request {
  return cacheKey(`https://jellino.local/sub-body?to=${to}&u=${encodeURIComponent(url)}`);
}

export async function subtitleBody(
  cache: Cache,
  fetchImpl: typeof fetch,
  url: string,
  to: SubtitleFormat,
  lang?: string,
): Promise<{ body: string; contentType: string } | null> {
  const key = bodyCacheKey(url, to);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const parsed = (await hit.json()) as { body?: unknown; contentType?: unknown };
      if (typeof parsed?.body === "string" && typeof parsed?.contentType === "string") {
        return { body: parsed.body, contentType: parsed.contentType };
      }
    }
  } catch {
    void 0;
  }

  let res: Response;
  try {
    res = await upstreamFetch(
      fetchImpl,
      url,
      { redirect: "follow", headers: { "user-agent": SUBTITLE_USER_AGENT } },
      Math.min(upstreamTimeoutMs(), SUBTITLE_FETCH_TIMEOUT_MS),
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_SUBTITLE_FILE_BYTES) return null;
  let raw: ArrayBuffer;
  try {
    raw = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (raw.byteLength > MAX_SUBTITLE_FILE_BYTES) return null;
  const decoded = decodeSubtitleBytes(await decompressIfNeeded(raw), lang);
  const converted = convertSubtitle(decoded, subtitleExtensionOf(url), to);
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(converted), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${SUBTITLE_BODY_TTL_SECONDS}` },
      }),
    );
  } catch {
    void 0;
  }
  return converted;
}


const EMBEDDED_CODEC_ALIASES: Record<string, string> = {
  srt: "subrip",
  subrip: "subrip",
  sub: "subrip",
  ass: "ass",
  ssa: "ass",
  ass_subtitle: "ass",
  pgs: "pgssub",
  pgssub: "pgssub",
  hdmv_pgs_subtitle: "pgssub",
  hdmv_pgs: "pgssub",
  sup: "pgssub",
  vtt: "webvtt",
  webvtt: "webvtt",
  wvtt: "webvtt",
  dvd_subtitle: "dvdsub",
  dvdsub: "dvdsub",
  mov_text: "mov_text",
  tx3g: "mov_text",
};

const EMBEDDED_IMAGE_CODECS = new Set(["pgssub", "dvdsub"]);

function normalizeEmbeddedCodec(raw: unknown): string {
  const clean = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return EMBEDDED_CODEC_ALIASES[clean] ?? (clean !== "" ? clean : "subrip");
}

export interface EmbeddedSubtitleTrack {
  codec?: string | null;
  language?: string | null;
  title?: string | null;
  is_default?: boolean;
  is_forced?: boolean;
  is_hearing_impaired?: boolean;
}

export function embeddedSubtitleStream(track: EmbeddedSubtitleTrack, index: number): Record<string, unknown> {
  const rawCodec = typeof track.codec === "string" ? track.codec.trim() : "";
  const codec = rawCodec === "" ? undefined : normalizeEmbeddedCodec(rawCodec);
  const isText = codec === undefined || !EMBEDDED_IMAGE_CODECS.has(codec);
  const code = subtitleLanguage(track.language ?? undefined);
  const rawTitle = typeof track.title === "string" ? track.title.trim() : "";
  const name = subtitleDisplayName(code, rawTitle !== "" ? rawTitle : "Embedded");
  const flags = [
    ...(track.is_default === true ? ["Default"] : []),
    ...(track.is_forced === true ? ["Forced"] : []),
    ...(track.is_hearing_impaired === true ? ["Hearing Impaired"] : []),
  ];
  const suffix = flags.length > 0 ? ` - ${flags.join(" - ")}` : "";
  return {
    Codec: codec,
    Type: "Subtitle",
    Index: index,
    IsDefault: track.is_default === true,
    IsForced: track.is_forced === true,
    IsExternal: false,
    IsExternalUrl: false,
    IsTextSubtitleStream: isText,
    SupportsExternalStream: isText,
    DeliveryMethod: "Embed",
    Language: code,
    DisplayTitle: codec === undefined ? `${name}${suffix}` : `${name} - ${codec.toUpperCase()}${suffix}`,
  };
}


export interface AddonSubtitleReport {
  addonUrl: string;
  subtitles: number;
  notes: string[];
}

export async function profileSubtitleReport(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  subType: string,
  subId: string,
): Promise<AddonSubtitleReport[] | null> {
  const resolved = await resolveAddonUrls(db, profileId);
  if (!resolved) return null;
  const bases = await capableBases(cache, fetchImpl, resolved, "subtitles");
  return Promise.all(
    bases.map(async (base) => {
      const tracks = await fetchAddonSubtitles(cache, fetchImpl, base, subType, subId, undefined);
      return { addonUrl: base, subtitles: tracks.length, notes: [] as string[] };
    }),
  );
}


export interface SubtitleLogRow {
  at: number;
  profileId: string;
  itemId: string;
  index: number;
  format: string;
  outcome: string;
  ms: number;
  size: number;
  url: string;
}

export async function logSubtitleServe(db: D1Database, row: SubtitleLogRow): Promise<void> {
  const outcome = row.outcome.slice(0, 120);
  const level = /fail|error|404|502|reject/i.test(outcome) ? "error" : "info";
  await logApp(db, {
    at: row.at,
    level,
    category: "subtitle",
    kind: outcome.slice(0, 40),
    profileId: row.profileId,
    message: `${row.itemId} idx=${row.index} fmt=${row.format} ${outcome} ms=${row.ms} size=${row.size}`,
    url: row.url,
  });
}
