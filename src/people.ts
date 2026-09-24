import { b64urlDecodeText, b64urlEncodeText } from "./ids";

const PHOTO_TAG_PREFIX = "ph_";

export function photoImageTag(photo: string): string {
  return `${PHOTO_TAG_PREFIX}${b64urlEncodeText(photo.trim())}`;
}

export function photoFromImageTag(tag: string | undefined): string | null {
  if (!tag || !tag.startsWith(PHOTO_TAG_PREFIX)) return null;
  try {
    return photoFrom(b64urlDecodeText(tag.slice(PHOTO_TAG_PREFIX.length))) || null;
  } catch {
    return null;
  }
}

function photoKey(name: string): Request {
  return new Request(`https://jellino.local/person-photo/${encodeURIComponent(name.trim().toLowerCase())}`, { method: "GET" });
}

function photoFrom(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  return /^https?:\/\//i.test(clean) ? clean : "";
}

export async function rememberPersonPhotos(cache: Cache, meta: unknown): Promise<void> {
  const holder = (meta ?? {}) as Record<string, unknown>;
  const lists: unknown[] = [holder.cast, holder.actors];
  const extras = holder.app_extras as Record<string, unknown> | undefined;
  if (extras) lists.push(extras.cast);
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const photo = photoFrom(record.photo) || photoFrom(record.profile_path);
      if (!name || !photo) continue;
      try {
        const key = photoKey(name);
        const existing = await cache.match(key);
        if (existing) continue;
        await cache.put(
          key,
          new Response(JSON.stringify({ u: photo }), {
            headers: { "content-type": "application/json", "cache-control": "public, max-age=604800" },
          }),
        );
      } catch {
        void 0;
      }
    }
  }
}

export async function readPersonPhoto(cache: Cache, name: string): Promise<string | null> {
  try {
    const stored = await cache.match(photoKey(name));
    if (!stored) return null;
    const parsed = (await stored.json()) as { u?: unknown };
    return photoFrom(parsed.u) || null;
  } catch {
    return null;
  }
}

export function personAvatarSvg(name: string): string {
  const clean = name.trim();
  const letter = (clean[0] ?? "?").toUpperCase().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let hue = 0;
  for (const ch of clean) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const fill = `hsl(${hue},38%,34%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${fill}"/><text x="128" y="172" font-family="sans-serif" font-size="140" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
}

export const TMDB_API_KEY_SETTING = "tmdb_api_key";
const TMDB_BASE = "https://api.themoviedb.org/3";

interface TmdbPersonInfo {
  name?: string;
  profile_path?: string | null;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
}

export interface PersonDetail {
  name: string;
  photo: string | null;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  birthplace: string | null;
}

function personDetailKey(name: string): Request {
  return new Request(`https://jellino.local/person-detail/${encodeURIComponent(name.trim().toLowerCase())}`, { method: "GET" });
}

export async function rememberPersonPhoto(cache: Cache, name: string, photo: string): Promise<void> {
  const clean = photoFrom(photo);
  if (!clean) return;
  try {
    const key = photoKey(name);
    const existing = await cache.match(key);
    if (existing) return;
    await cache.put(
      key,
      new Response(JSON.stringify({ u: clean }), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=604800" },
      }),
    );
  } catch {
    void 0;
  }
}

export async function personDetail(
  cache: Cache,
  fetchImpl: typeof fetch,
  name: string,
  apiKey: string | null | undefined,
): Promise<PersonDetail | null> {
  const cleanName = name.trim();
  const key = apiKey?.trim();
  if (!cleanName || !key) return null;
  const cacheKey = personDetailKey(cleanName);
  try {
    const stored = await cache.match(cacheKey);
    if (stored) {
      const parsed = (await stored.json()) as PersonDetail | null;
      if (parsed && typeof parsed === "object") return parsed;
      return null;
    }
  } catch {
    void 0;
  }
  let detail: PersonDetail | null = null;
  try {
    const searchRes = await fetchImpl(
      `${TMDB_BASE}/search/person?query=${encodeURIComponent(cleanName)}&language=en-US&api_key=${encodeURIComponent(key)}`,
      { headers: { accept: "application/json" } },
    );
    if (searchRes.ok) {
      const body = (await searchRes.json()) as { results?: Array<{ id?: number; name?: string; profile_path?: string | null; popularity?: number }> };
      const results = Array.isArray(body.results) ? body.results : [];
      const exact = results.filter((entry) => String(entry?.name ?? "").toLowerCase() === cleanName.toLowerCase());
      const pick = (exact.length > 0 ? exact : results).sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
      if (pick?.id) {
        let info: TmdbPersonInfo | null = null;
        try {
          const detailRes = await fetchImpl(
            `${TMDB_BASE}/person/${pick.id}?language=en-US&api_key=${encodeURIComponent(key)}`,
            { headers: { accept: "application/json" } },
          );
          if (detailRes.ok) info = (await detailRes.json()) as TmdbPersonInfo;
        } catch {
          info = null;
        }
        const photoPath = info?.profile_path || pick.profile_path || null;
        detail = {
          name: info?.name || pick.name || cleanName,
          photo: photoPath ? `https://image.tmdb.org/t/p/h632${photoPath}` : null,
          biography: info?.biography || "",
          birthday: info?.birthday || null,
          deathday: info?.deathday || null,
          birthplace: info?.place_of_birth || null,
        };
      }
    }
  } catch {
    detail = null;
  }
  try {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(detail), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${detail ? 86400 : 300}` },
      }),
    );
  } catch {
    void 0;
  }
  return detail;
}
