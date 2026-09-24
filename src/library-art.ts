
import { b64urlDecodeText, b64urlEncodeText } from "./ids";

export type LibraryTileKind = "movie" | "series" | "custom";

const MOVIE_TYPES = new Set(["movie", "movies"]);
const SERIES_TYPES = new Set(["series", "tvshows", "show", "shows"]);

export function libraryTileKind(catalogType: string | null | undefined): LibraryTileKind {
  const t = (catalogType ?? "").trim().toLowerCase();
  if (MOVIE_TYPES.has(t)) return "movie";
  if (SERIES_TYPES.has(t)) return "series";
  return "custom";
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export function defaultLibraryTag(catalogType: string | null | undefined, name = ""): string {
  return `library2-${libraryTileKind(catalogType)}-${fnv(name || libraryTileKind(catalogType))}`;
}

const ART_TAG_PREFIX = "art_";

export function artImageTag(url: string | null | undefined): string | null {
  const clean = typeof url === "string" ? url.trim() : "";
  if (!/^https?:\/\//i.test(clean)) return null;
  return `${ART_TAG_PREFIX}${b64urlEncodeText(clean)}`;
}

export function artFromImageTag(tag: string | null | undefined): string | null {
  if (!tag || !tag.startsWith(ART_TAG_PREFIX)) return null;
  try {
    const url = b64urlDecodeText(tag.slice(ART_TAG_PREFIX.length)).trim();
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

export function artUrlAllowed(url: string | null | undefined): string | null {
  if (!url) return null;
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) return null;
  return clean;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function defaultLibraryTile(catalogType: string | null | undefined, name: string): string {
  const kind = libraryTileKind(catalogType);
  const label = esc((name || "Library").slice(0, 28).toUpperCase());
  const accent = kind === "series" ? "#7c5cff" : kind === "movie" ? "#ff5c7a" : "#38bdf8";
  const glyph =
    kind === "series"
      ? '<rect x="200" y="120" width="240" height="150" rx="14" fill="none" stroke="#fff" stroke-width="14" opacity=".92"/><path d="M200 150h240M260 120v-22m40 22v-22m40 22v-22m40 22v-22m40 22v-22" stroke="#fff" stroke-width="10" opacity=".92"/><path d="M295 175l60 37-60 37z" fill="#fff" opacity=".92"/>'
      : kind === "movie"
        ? '<rect x="205" y="110" width="230" height="160" rx="14" fill="none" stroke="#fff" stroke-width="14" opacity=".92"/><path d="M205 148h230M243 110v38m38-38v38m38-38v38m38-38v38m40-38v38" stroke="#fff" stroke-width="9" opacity=".92"/><circle cx="320" cy="212" r="10" fill="#fff" opacity=".92"/><circle cx="352" cy="212" r="10" fill="#fff" opacity=".55"/>'
        : '<path d="M320 118l28 62 68 6-51 45 15 67-60-34-60 34 15-67-51-45 68-6z" fill="none" stroke="#fff" stroke-width="14" stroke-linejoin="round" opacity=".92"/>';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#141422"/><stop offset="1" stop-color="#232338"/></linearGradient></defs>` +
    `<rect width="640" height="360" fill="url(#g)"/><circle cx="320" cy="175" r="118" fill="${accent}" opacity=".16"/>` +
    `<g transform="translate(0,10)">${glyph}</g>` +
    `<text x="320" y="322" text-anchor="middle" font-family="system-ui,sans-serif" font-size="30" font-weight="700" letter-spacing="6" fill="#fff" opacity=".92">${label}</text>` +
    `</svg>`
  );
}
