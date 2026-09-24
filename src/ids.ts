const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlEncodeText(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecodeText(value: string): string {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decoder.decode(bytes);
}

export const COLLECTIONS_VIEW_ID = "collections";

export function encodeView(addonUrl: string, catalogType: string, catalogId: string): string {
  return `v.${b64urlEncodeText(addonUrl)}.${b64urlEncodeText(catalogType)}.${b64urlEncodeText(catalogId)}`;
}

export function encodeLibrary(id: string): string {
  return `l.${b64urlEncodeText(id)}`;
}

export function decodeLibrary(id: string): string | null {
  const parts = id.split(".");
  if (parts.length !== 2 || parts[0] !== "l" || !parts[1]) return null;
  try {
    const decoded = b64urlDecodeText(parts[1]);
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}
export interface DecodedView {
  addonUrl: string;
  catalogType: string;
  catalogId: string;
}

export function decodeView(id: string): DecodedView | null {
  const parts = id.split(".");
  if (parts.length !== 4 || parts[0] !== "v") return null;
  const addon = parts[1];
  const kind = parts[2];
  const catalog = parts[3];
  if (!addon || !kind || !catalog) return null;
  try {
    return { addonUrl: b64urlDecodeText(addon), catalogType: b64urlDecodeText(kind), catalogId: b64urlDecodeText(catalog) };
  } catch {
    return null;
  }
}

export type ItemKind = "movie" | "series" | "collection" | "season" | "episode";

export interface ParsedItemKey {
  kind: "movie" | "series" | "episode";
  stremioId: string;
  season: number;
  episode: number;
}

export function parseItemKey(itemKey: string): ParsedItemKey | null {
  if (itemKey.startsWith("movie:")) {
    const sid = itemKey.slice("movie:".length);
    if (!isValidStremioId(sid)) return null;
    return { kind: "movie", stremioId: sid, season: 0, episode: 0 };
  }
  if (itemKey.startsWith("series:")) {
    const sid = itemKey.slice("series:".length);
    if (!isValidStremioId(sid)) return null;
    return { kind: "series", stremioId: sid, season: 0, episode: 0 };
  }
  if (itemKey.startsWith("episode:")) {
    const rest = itemKey.slice("episode:".length);
    const parts = rest.split(":");
    if (parts.length < 3 || parts.length > 4) return null;
    let sid: string;
    let seasonRaw: string | undefined;
    let episodeRaw: string | undefined;
    if (parts.length === 3) {
      const [a, b, c] = parts as [string, string, string];
      sid = a;
      seasonRaw = b;
      episodeRaw = c;
    } else {
      const [a, b, c, d] = parts as [string, string, string, string];
      sid = `${a}:${b}`;
      seasonRaw = c;
      episodeRaw = d;
    }
    if (!isValidStremioId(sid)) return null;
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
    return { kind: "episode", stremioId: sid, season, episode };
  }
  return null;
}

function isValidStremioId(sid: string): boolean {
  if (!sid || sid.length === 0 || sid.length > 64) return false;
  if (sid.includes("::") || sid.startsWith(":") || sid.endsWith(":")) return false;
  const lower = sid.toLowerCase();
  if (lower === "tmdb" || lower === "tvdb") return false;
  const parts = sid.split(":");
  if (parts.length === 1) return parts[0] !== undefined && parts[0].length > 0;
  if (parts.length === 2) return (parts[0]?.length ?? 0) > 0 && (parts[1]?.length ?? 0) > 0;
  return false;
}

export function encodeItem(addonUrl: string, kind: ItemKind, stremioId: string): string {
  return `m.${b64urlEncodeText(addonUrl)}.${b64urlEncodeText(kind)}.${b64urlEncodeText(stremioId)}`;
}

export function encodeSeason(addonUrl: string, seriesId: string, season: number): string {
  return `s.${b64urlEncodeText(addonUrl)}.${b64urlEncodeText(seriesId)}.${season}`;
}

export function encodeEpisode(addonUrl: string, seriesId: string, season: number, episode: number): string {
  return `e.${b64urlEncodeText(addonUrl)}.${b64urlEncodeText(seriesId)}.${season}.${episode}`;
}

export function encodePerson(name: string): string {
  return `p.${b64urlEncodeText(name)}`;
}

const PLACEHOLDER_MARKER_PREFIX = "ph.";

export function encodePlaceholderMarker(itemId: string): string {
  return `${PLACEHOLDER_MARKER_PREFIX}${b64urlEncodeText(itemId)}`;
}

export function decodePlaceholderMarker(id: string): string | null {
  if (!id.startsWith(PLACEHOLDER_MARKER_PREFIX)) return null;
  const raw = id.slice(PLACEHOLDER_MARKER_PREFIX.length);
  if (!raw) return null;
  try {
    const decoded = b64urlDecodeText(raw);
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

export function decodePerson(id: string): string | null {
  const parts = id.split(".");
  if (parts.length !== 2 || parts[0] !== "p" || !parts[1]) return null;
  try {
    const name = b64urlDecodeText(parts[1]);
    return name ? name : null;
  } catch {
    return null;
  }
}

export interface DecodedItem {
  kind: ItemKind;
  addonUrl: string;
  stremioId: string;
  season: number | null;
  episode: number | null;
}

function decodedNumber(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function decodeItem(id: string): DecodedItem | null {
  const parts = id.split(".");
  const prefix = parts[0];
  const addon = parts[1];
  if (!addon) return null;
  try {
    if ((prefix === "m" && parts.length === 4) || (prefix === "s" && parts.length === 4) || (prefix === "e" && parts.length === 5)) {
      const addonUrl = b64urlDecodeText(addon);
      const second = b64urlDecodeText(parts[2] ?? "");
      if (prefix === "m" && (second === "movie" || second === "series" || second === "collection")) {
        const stremioId = b64urlDecodeText(parts[3] ?? "");
        if (!stremioId) return null;
        return { kind: second, addonUrl, stremioId, season: null, episode: null };
      }
      const season = decodedNumber(parts[3]);
      if (season === null || !second) return null;
      if (prefix === "s") {
        return { kind: "season", addonUrl, stremioId: second, season, episode: null };
      }
      const episode = decodedNumber(parts[4]);
      if (episode === null || episode <= 0) return null;
      return { kind: "episode", addonUrl, stremioId: second, season, episode };
    }
    return null;
  } catch {
    return null;
  }
}
