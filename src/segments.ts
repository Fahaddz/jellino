import { md5Hex } from "./hash";
import { cacheKey, upstreamFetch } from "./cache";

const SEGMENTS_TTL_SECONDS = 7 * 24 * 60 * 60;
const SEGMENTS_NEGATIVE_TTL_SECONDS = 300;
const INTRODB_BASE_URL = "https://api.introdb.app";
const ANISKIP_BASE_URL = "https://api.aniskip.com/v2";
const PUBLICMETADB_BASE_URL = "https://publicmetadb.com";
export const PUBLICMETADB_API_KEY_SETTING = "publicmetadb_api_key";

export type SegmentType = "Intro" | "Outro" | "Recap";

export interface Segment {
  type: SegmentType;
  startMs: number;
  endMs: number;
}

export interface JellyfinSegment {
  Id: string;
  ItemId: string;
  Type: SegmentType;
  StartTicks: number;
  EndTicks: number;
}

export interface SegmentLookup {
  itemId: string;
  imdbId?: string | null;
  tmdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  malId?: number | null;
  runtimeMs?: number | null;
}

export function segmentId(itemId: string, type: SegmentType): string {
  return md5Hex(`${itemId}|${type}`);
}

function range(type: SegmentType, start: unknown, end: unknown): Segment | null {
  const startMs = Number(start);
  const endMs = Number(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { type, startMs: Math.max(0, startMs), endMs };
}

export async function fromIntroDb(
  fetchImpl: typeof fetch,
  lookup: { imdbId: string; season?: number | null; episode?: number | null },
): Promise<Segment[]> {
  try {
    const params = new URLSearchParams({
      imdb_id: lookup.imdbId,
      season: String(lookup.season ?? 0),
      episode: String(lookup.episode ?? 0),
    });
    const res = await upstreamFetch(
      fetchImpl,
      `${INTRODB_BASE_URL}/segments?${params.toString()}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as Record<string, { start_ms?: number; end_ms?: number } | undefined>;
    const out: Segment[] = [];
    const mappings: Array<[string, SegmentType]> = [
      ["intro", "Intro"],
      ["recap", "Recap"],
      ["outro", "Outro"],
      ["post_credits", "Outro"],
    ];
    for (const [key, type] of mappings) {
      if (out.some((s) => s.type === type)) continue;
      const seg = range(type, body?.[key]?.start_ms, body?.[key]?.end_ms);
      if (seg) out.push(seg);
    }
    return out;
  } catch {
    return [];
  }
}

export async function fromAniSkip(
  fetchImpl: typeof fetch,
  lookup: { malId: number; episode: number; runtimeMs?: number | null },
): Promise<Segment[]> {
  try {
    const params = new URLSearchParams({ episodeLength: "0" });
    for (const t of ["op", "ed", "mixed-op", "mixed-ed", "recap"]) {
      params.append("types", t);
    }
    const res = await upstreamFetch(
      fetchImpl,
      `${ANISKIP_BASE_URL}/skip-times/${lookup.malId}/${lookup.episode}?${params.toString()}`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      results?: Array<{
        skipType?: string;
        interval?: { startTime?: number; endTime?: number };
      }>;
    };
    const results = Array.isArray(body?.results) ? body.results : [];
    const typeOf: Record<string, SegmentType> = {
      op: "Intro",
      "mixed-op": "Intro",
      ed: "Outro",
      "mixed-ed": "Outro",
      recap: "Recap",
    };
    const out: Segment[] = [];
    for (const item of results) {
      const type = typeOf[item?.skipType ?? ""];
      if (!type || out.some((s) => s.type === type)) continue;
      const startMs = Number(item.interval?.startTime) * 1000;
      const endMs = Number(item.interval?.endTime) * 1000;
      const seg = range(type, startMs, endMs);
      if (seg) out.push(seg);
    }
    return out;
  } catch {
    return [];
  }
}

async function fromPublicMetaDb(
  fetchImpl: typeof fetch,
  lookup: { tmdbId: string; season?: number | null | undefined; episode?: number | null | undefined },
  apiKey: string,
): Promise<Segment[]> {
  try {
    const params = new URLSearchParams({ tmdb_id: lookup.tmdbId });
    const episodic = typeof lookup.season === "number" && typeof lookup.episode === "number";
    params.set("media_type", episodic ? "tv" : "movie");
    if (episodic) {
      params.set("season", String(lookup.season));
      params.set("episode", String(lookup.episode));
    }
    const res = await upstreamFetch(
      fetchImpl,
      `${PUBLICMETADB_BASE_URL}/api/external/skips?${params.toString()}`,
      { headers: { accept: "application/json", authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      items?: Array<{
        intro_start_ms?: number;
        intro_end_ms?: number;
        credits_start_ms?: number;
        credits_end_ms?: number;
        source?: string;
      }>;
    };
    const items = Array.isArray(body?.items) ? [...body.items] : [];
    items.sort((a, b) => (a?.source === "streaming" ? 0 : 1) - (b?.source === "streaming" ? 0 : 1));
    const out: Segment[] = [];
    for (const item of items) {
      const intro = range("Intro", item?.intro_start_ms, item?.intro_end_ms);
      const outro = range("Outro", item?.credits_start_ms, item?.credits_end_ms);
      if (intro && !out.some((seg) => seg.type === "Intro")) out.push(intro);
      if (outro && !out.some((seg) => seg.type === "Outro")) out.push(outro);
    }
    return out;
  } catch {
    return [];
  }
}

function mergeSegments(base: Segment[], extra: Segment[]): Segment[] {
  const out = [...base];
  for (const segment of extra) {
    if (out.some((entry) => entry.type === segment.type)) continue;
    out.push(segment);
  }
  return out;
}

export async function fetchMediaSegments(
  cache: Cache,
  fetchImpl: typeof fetch,
  lookup: SegmentLookup,
  publicMetaDbKey?: string | null,
): Promise<JellyfinSegment[]> {
  const key = cacheKey(`https://cache.jellino.internal/segments/${lookup.itemId}`);
  try {
    const stored = await cache.match(key);
    if (stored) {
      const raw = (await stored.json()) as Segment[];
      return jellyfinSegments(lookup.itemId, Array.isArray(raw) ? raw : []);
    }
  } catch {
    void 0;
  }

  let segments: Segment[] = [];
  if (publicMetaDbKey && lookup.tmdbId) {
    segments = mergeSegments(
      segments,
      await fromPublicMetaDb(
        fetchImpl,
        { tmdbId: lookup.tmdbId, season: lookup.season, episode: lookup.episode },
        publicMetaDbKey,
      ),
    );
  }
  if (lookup.malId && lookup.episode) {
    segments = mergeSegments(
      segments,
      await fromAniSkip(fetchImpl, {
        malId: lookup.malId,
        episode: lookup.episode,
        runtimeMs: lookup.runtimeMs ?? null,
      }),
    );
  }
  if (lookup.imdbId) {
    segments = mergeSegments(
      segments,
      await fromIntroDb(fetchImpl, {
        imdbId: lookup.imdbId,
        season: lookup.season ?? 0,
        episode: lookup.episode ?? 0,
      }),
    );
  }

  const ttl = segments.length > 0 ? SEGMENTS_TTL_SECONDS : SEGMENTS_NEGATIVE_TTL_SECONDS;
  try {
    await cache.put(
      key,
      new Response(JSON.stringify(segments), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
      }),
    );
  } catch {
    void 0;
  }

  return jellyfinSegments(lookup.itemId, segments);
}

function jellyfinSegments(itemId: string, segments: Segment[]): JellyfinSegment[] {
  return segments.map((s) => ({
    Id: segmentId(itemId, s.type),
    ItemId: itemId,
    Type: s.type,
    StartTicks: Math.round(s.startMs * 10000),
    EndTicks: Math.round(s.endMs * 10000),
  }));
}
