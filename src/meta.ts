import type { D1Database } from "@cloudflare/workers-types";
import { cachedJson, META_TTL_SECONDS, upstreamFetch } from "./cache";
import { encodeEpisode, encodeItem, encodePerson, encodeSeason } from "./ids";
import { catalogBases, capableBases, normalizeAddonUrl, stremioSegment } from "./library";
import { artImageTag } from "./library-art";
import { rememberPersonPhotos, photoImageTag } from "./people";

function personImageTag(name: string): string {
  return fnvTag(name).Primary ?? "person";
}

export interface StremioVideo {
  id?: string;
  title?: string;
  name?: string;
  season?: number;
  episode?: number;
  number?: number;
  released?: string;
  overview?: string;
  description?: string;
  thumbnail?: string;
  rating?: string | number;
  directors?: string[] | string;
  director?: string[] | string;
  writers?: string[] | string;
  writer?: string[] | string;
  cast?: unknown;
  tvdb_id?: number | string;
  tvdbId?: number | string;
  runtime?: string | number;
}

export interface StremioMeta {
  id: string;
  type: string;
  name?: string;
  description?: string;
  genres?: string[] | string;
  genre?: string[] | string;
  tags?: string[] | string;
  tag?: string[] | string;
  releaseInfo?: string;
  released?: string;
  runtime?: string | number;
  imdbRating?: string | number;
  imdb_rating?: string | number;
  rating?: string | number;
  communityRating?: string | number;
  criticRating?: string | number;
  tomatoRating?: string | number;
  metacritic?: string | number;
  certification?: string;
  ageRating?: string;
  rated?: string;
  parentalRating?: string;
  director?: string[] | string;
  directors?: string[] | string;
  writer?: string[] | string;
  writers?: string[] | string;
  cast?: unknown;
  actors?: unknown;
  studios?: unknown;
  productionCompanies?: unknown;
  production_companies?: unknown;
  network?: unknown;
  company?: unknown;
  country?: string | string[];
  imdb_id?: string;
  imdbId?: string;
  moviedb_id?: number | string;
  tmdb_id?: number | string;
  tmdbId?: number | string;
  tvdb_id?: number | string;
  tvdbId?: number | string;
  zap2it_id?: string;
  zap2itId?: string;
  zap2it?: string;
  poster?: string;
  thumbnail?: string;
  posterShape?: string;
  status?: string;
  taglines?: string[] | string;
  background?: string;
  logo?: string;
  landscapePoster?: string;
  trailers?: Array<{ source?: string; type?: string; name?: string; lang?: string }>;
  trailerStreams?: Array<{ title?: string; ytId?: string; url?: string }>;
  videos?: StremioVideo[];
  seasonPosters?: Record<string, string>;
  links?: Array<{ name?: string; category?: string; url?: string }>;
  app_extras?: {
    season_posters?: (string | null)[] | Record<string, string | null>;
    seasonPosters?: (string | null)[] | Record<string, string | null>;
    seasonPosterByNumber?: Record<string, string | null>;
    cast?: unknown;
    directors?: unknown;
    writers?: unknown;
    certification?: string;
    certificationLocal?: string;
    rating?: string | number;
    criticRating?: string | number;
    tomatoRating?: string | number;
    studios?: unknown;
    productionCompanies?: unknown;
    production_companies?: unknown;
    network?: unknown;
    genres?: string[] | string;
    genre?: string[] | string;
    tags?: string[] | string;
    imdb_id?: string;
    tmdb_id?: number | string;
    tvdb_id?: number | string;
    zap2it_id?: string;
  };
}

export interface ResolvedMeta {
  addonUrl: string;
  meta: StremioMeta;
}

export function videoEpisodeNumber(video: StremioVideo): number | undefined {
  if (typeof video.episode === "number") return video.episode;
  if (typeof video.number === "number") return video.number;
  return undefined;
}

export interface IndexedEpisode {
  video: StremioVideo;
  season: number;
  episode: number;
}

export function indexedEpisodes(meta: StremioMeta): IndexedEpisode[] {
  return (meta.videos ?? [])
    .map((video) => ({
      video,
      season: typeof video.season === "number" ? video.season : undefined,
      episode: videoEpisodeNumber(video),
    }))
    .filter((entry): entry is IndexedEpisode => entry.season !== undefined && entry.episode !== undefined)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

export const normalizeBase: (url: string) => string = normalizeAddonUrl;

const PER_ENTRY_ANIME = /^(kitsu|mal|anilist|anidb):/i;

export function providerIds(
  stremioId: string,
  meta?: unknown,
  extraMeta?: unknown,
): Record<string, string> {
  const result: Record<string, string> = {};
  const isAnime = PER_ENTRY_ANIME.test(stremioId);
  if (/^tt\d+$/.test(stremioId)) {
    result.Imdb = stremioId;
  } else {
    const cut = stremioId.indexOf(":");
    if (cut > 0) {
      const source = stremioId.slice(0, cut).toLowerCase();
      const rest = stremioId.slice(cut + 1);
      if (!isAnime && source === "tmdb" && rest) result.Tmdb = rest;
      else if (!isAnime && source === "tvdb" && rest) result.Tvdb = rest;
      else if (!isAnime && source === "zap2it" && rest) result.Zap2It = rest;
      else if (source === "kitsu" && rest) result.Kitsu = rest.split(":")[0] ?? rest;
      else if (source === "mal" && rest) result.MyAnimeList = rest.split(":")[0] ?? rest;
      else if (source === "anilist" && rest) result.AniList = rest.split(":")[0] ?? rest;
      else if (source === "anidb" && rest) result.AniDb = rest.split(":")[0] ?? rest;
      else if (!isAnime && source.startsWith("tt") && /^tt\d+$/.test(source)) result.Imdb = source;
    }
  }

  const extractFrom = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as Record<string, unknown>;
    if (!isAnime) {
      if (typeof rec.imdb_id === "string" && rec.imdb_id) result.Imdb = rec.imdb_id;
      if (typeof rec.imdbId === "string" && rec.imdbId) result.Imdb = rec.imdbId;
      if (rec.tvdb_id !== undefined && rec.tvdb_id !== null) result.Tvdb = String(rec.tvdb_id);
      if (rec.tvdbId !== undefined && rec.tvdbId !== null) result.Tvdb = String(rec.tvdbId);
      if (rec.moviedb_id !== undefined && rec.moviedb_id !== null) result.Tmdb = String(rec.moviedb_id);
      if (rec.tmdb_id !== undefined && rec.tmdb_id !== null) result.Tmdb = String(rec.tmdb_id);
      if (rec.tmdbId !== undefined && rec.tmdbId !== null) result.Tmdb = String(rec.tmdbId);
      if (rec.zap2it_id !== undefined && rec.zap2it_id !== null) result.Zap2It = String(rec.zap2it_id);
      if (rec.zap2itId !== undefined && rec.zap2itId !== null) result.Zap2It = String(rec.zap2itId);
      if (rec.zap2it !== undefined && rec.zap2it !== null) result.Zap2It = String(rec.zap2it);
    }
    if (rec._kitsuId !== undefined && rec._kitsuId !== null) result.Kitsu = String(rec._kitsuId);
    if (rec._malId !== undefined && rec._malId !== null) result.MyAnimeList = String(rec._malId);
    if (rec._anilistId !== undefined && rec._anilistId !== null) result.AniList = String(rec._anilistId);
    if (rec._anidbId !== undefined && rec._anidbId !== null) result.AniDb = String(rec._anidbId);

    if (!isAnime && Array.isArray(rec.links)) {
      for (const link of rec.links) {
        if (!link || typeof link !== "object") continue;
        const cat = String(link.category ?? "").toLowerCase();
        const url = String(link.url ?? "");
        if (cat === "imdb" || url.includes("imdb.com/title/")) {
          const m = /tt\d+/.exec(url);
          if (m?.[0] && !result.Imdb) result.Imdb = m[0];
        } else if (cat === "tmdb" || url.includes("themoviedb.org/")) {
          const m = /\/(movie|tv)\/(\d+)/.exec(url);
          if (m?.[2] && !result.Tmdb) result.Tmdb = m[2];
        } else if (cat === "tvdb" || url.includes("thetvdb.com/")) {
          const m = /\/series\/([^/?#]+)/.exec(url);
          if (m?.[1] && !result.Tvdb) result.Tvdb = m[1];
        }
      }
    }

    if (rec.app_extras && typeof rec.app_extras === "object") {
      extractFrom(rec.app_extras);
    }
  };

  if (extraMeta) extractFrom(extraMeta);
  if (meta) extractFrom(meta);

  return result;
}

export function productionYear(released: string | undefined): number | null {
  if (!released) return null;
  const match = /^(\d{4})/.exec(released);
  return match?.[1] ? Number(match[1]) : null;
}

export function runtimeTicks(runtime: string | number | undefined): number | null {
  if (runtime === undefined || runtime === null) return null;
  if (typeof runtime === "number" && Number.isFinite(runtime) && runtime > 0) {
    return Math.round(runtime * 600000000);
  }
  const str = String(runtime).trim();
  const hrMinMatch = /(\d+)\s*h(?:our)?s?\s*(\d+)?/i.exec(str);
  if (hrMinMatch?.[1]) {
    const hours = Number(hrMinMatch[1]);
    const mins = hrMinMatch[2] ? Number(hrMinMatch[2]) : 0;
    return (hours * 60 + mins) * 600000000;
  }
  const minMatch = /(\d+)\s*min/i.exec(str);
  if (minMatch?.[1]) return Number(minMatch[1]) * 600000000;
  const num = parseFloat(str);
  if (Number.isFinite(num) && num > 0) {
    return Math.round(num * 600000000);
  }
  return null;
}

export function communityRating(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 10) / 10;
  const parsed = parseFloat(String(value).trim());
  return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : null;
}

function ratingSources(meta?: unknown, extraMeta?: unknown): {
  m: Record<string, unknown> | undefined;
  em: Record<string, unknown> | undefined;
  mExtras: Record<string, unknown> | undefined;
  emExtras: Record<string, unknown> | undefined;
} {
  const m = meta as Record<string, unknown> | undefined;
  const em = extraMeta as Record<string, unknown> | undefined;
  return {
    m,
    em,
    mExtras: m?.app_extras as Record<string, unknown> | undefined,
    emExtras: em?.app_extras as Record<string, unknown> | undefined,
  };
}

export function criticRating(meta?: unknown, extraMeta?: unknown): number | null {
  const { m, em, mExtras, emExtras } = ratingSources(meta, extraMeta);
  const candidates = [
    m?.criticRating,
    m?.tomatoRating,
    m?.metacritic,
    mExtras?.tomatoRating,
    mExtras?.criticRating,
    em?.criticRating,
    em?.tomatoRating,
    em?.metacritic,
    emExtras?.tomatoRating,
    emExtras?.criticRating,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === "number" && Number.isFinite(c)) return Math.round(c * 10) / 10;
    if (typeof c === "string") {
      const parsed = parseFloat(c.replace("%", "").trim());
      if (Number.isFinite(parsed)) return Math.round(parsed * 10) / 10;
    }
  }
  return null;
}

export function officialRating(meta?: unknown, extraMeta?: unknown): string | undefined {
  const { m, em, mExtras, emExtras } = ratingSources(meta, extraMeta);
  const candidates = [
    m?.certification,
    mExtras?.certification,
    mExtras?.certificationLocal,
    m?.ageRating,
    m?.rated,
    m?.parentalRating,
    em?.certification,
    emExtras?.certification,
    emExtras?.certificationLocal,
    em?.ageRating,
    em?.rated,
    em?.parentalRating,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

export function extractGenresAndTags(meta?: unknown, extraMeta?: unknown): {
  genres: string[];
  tags: string[];
  genreItems: Array<{ Name: string; Id: string }>;
} {
  const seenGenres = new Set<string>();
  const genres: string[] = [];
  const seenTags = new Set<string>();
  const tags: string[] = [];

  const addGenre = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const name = raw.trim();
    if (!name || seenGenres.has(name.toLowerCase())) return;
    seenGenres.add(name.toLowerCase());
    genres.push(name);
  };

  const addTag = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const name = raw.trim();
    if (!name || seenTags.has(name.toLowerCase())) return;
    seenTags.add(name.toLowerCase());
    tags.push(name);
  };

  const process = (val: unknown, adder: (s: unknown) => void) => {
    if (!val) return;
    if (typeof val === "string") {
      val.split(",").forEach(adder);
    } else if (Array.isArray(val)) {
      val.forEach((item) => {
        if (typeof item === "string") adder(item);
        else if (item && typeof item === "object" && "name" in item) adder((item as Record<string, unknown>).name);
      });
    }
  };

  const collect = (m: unknown) => {
    if (!m || typeof m !== "object") return;
    const rec = m as Record<string, unknown>;
    process(rec.genres, addGenre);
    process(rec.genre, addGenre);
    process(rec.tags, addTag);
    process(rec.tag, addTag);
    if (rec.app_extras && typeof rec.app_extras === "object") {
      const ext = rec.app_extras as Record<string, unknown>;
      process(ext.genres, addGenre);
      process(ext.genre, addGenre);
      process(ext.tags, addTag);
    }
  };

  collect(meta);
  if (extraMeta) collect(extraMeta);

  if (tags.length === 0) {
    genres.forEach(addTag);
  }

  const genreItems = genres.map((name) => ({
    Name: name,
    Id: `genre-${fnvTag(name).Primary ?? name}`,
  }));

  return { genres, tags, genreItems };
}

export function extractStudios(meta?: unknown, extraMeta?: unknown): Array<{ Id: string; Name: string }> {
  const seen = new Set<string>();
  const out: Array<{ Id: string; Name: string }> = [];

  const add = (rawName: unknown) => {
    if (typeof rawName !== "string") return;
    const name = rawName.trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push({
      Id: `studio-${fnvTag(name).Primary ?? name}`,
      Name: name,
    });
  };

  const processField = (val: unknown) => {
    if (!val) return;
    if (typeof val === "string") {
      if (val.includes(",")) {
        val.split(",").forEach(add);
      } else {
        add(val);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") add(item);
        else if (item && typeof item === "object" && "name" in item) add((item as Record<string, unknown>).name);
      }
    } else if (typeof val === "object" && "name" in val) {
      add((val as Record<string, unknown>).name);
    }
  };

  const collect = (m: unknown) => {
    if (!m || typeof m !== "object") return;
    const rec = m as Record<string, unknown>;
    processField(rec.studios);
    processField(rec.productionCompanies);
    processField(rec.production_companies);
    processField(rec.network);
    processField(rec.company);
    if (rec.app_extras && typeof rec.app_extras === "object") {
      const ext = rec.app_extras as Record<string, unknown>;
      processField(ext.productionCompanies);
      processField(ext.production_companies);
      processField(ext.studios);
      processField(ext.network);
    }
  };

  collect(meta);
  if (extraMeta) collect(extraMeta);

  return out;
}

export function extractPeople(meta?: unknown, video?: unknown): Record<string, unknown>[] {
  const people: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  const addPerson = (
    nameRaw: unknown,
    type: "Actor" | "Director" | "Writer" | "GuestStar",
    roleRaw?: unknown,
    photoRaw?: unknown,
  ) => {
    if (typeof nameRaw !== "string") return;
    const name = nameRaw.trim();
    if (!name) return;
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    const role = typeof roleRaw === "string" && roleRaw.trim() ? roleRaw.trim() : type;
    const photo = typeof photoRaw === "string" && photoRaw.trim() ? photoRaw.trim() : undefined;
    const tag = photo ? photoImageTag(photo) : personImageTag(name);

    people.push({
      Id: encodePerson(name),
      Name: name,
      Role: role,
      Type: type,
      PrimaryImageTag: tag,
    });
  };

  const processList = (val: unknown, type: "Actor" | "Director" | "Writer" | "GuestStar", defaultRole?: string) => {
    if (!val) return;
    if (typeof val === "string") {
      val.split(",").forEach((n) => addPerson(n, type, defaultRole));
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") {
          addPerson(item, type, defaultRole);
        } else if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          const name = rec.name;
          const character = rec.character ?? rec.role ?? defaultRole;
          const photo = rec.photo ?? rec.profile_path;
          addPerson(name, type, character, photo);
        }
      }
    }
  };

  if (video && typeof video === "object") {
    const vRec = video as Record<string, unknown>;
    processList(vRec.directors ?? vRec.director, "Director");
    processList(vRec.writers ?? vRec.writer, "Writer");
    processList(vRec.cast, "GuestStar");
  }

  if (meta && typeof meta === "object") {
    const mRec = meta as Record<string, unknown>;
    processList(mRec.director ?? mRec.directors, "Director");
    processList(mRec.writer ?? mRec.writers, "Writer");
    processList(mRec.cast ?? mRec.actors, video ? "GuestStar" : "Actor");

    if (mRec.app_extras && typeof mRec.app_extras === "object") {
      const ext = mRec.app_extras as Record<string, unknown>;
      processList(ext.directors, "Director");
      processList(ext.writers, "Writer");
      processList(ext.cast, video ? "GuestStar" : "Actor");
    }

    if (Array.isArray(mRec.links)) {
      for (const link of mRec.links) {
        if (!link || typeof link !== "object") continue;
        const cat = String(link.category ?? "").toLowerCase();
        const name = link.name;
        if (cat === "director" || cat === "directors") addPerson(name, "Director");
        else if (cat === "writer" || cat === "writers" || cat === "screenplay") addPerson(name, "Writer");
        else if (cat === "cast" || cat === "actor" || cat === "actors") addPerson(name, video ? "GuestStar" : "Actor");
      }
    }
  }

  return people;
}

function fnvTag(url: string | undefined): Record<string, string> {
  if (!url) return {};
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return { Primary: (hash >>> 0).toString(16) };
}

interface DtoBase {
  Name: string;
  SortName: string;
  ServerId: string;
  Id: string;
  Etag: string;
  Type: string;
  MediaType: string;
  IsFolder: boolean;
  LocationType: string;
  CanDelete: boolean;
  LockedFields: string[];
  LockData: boolean;
  ImageBlurHashes: Record<string, never>;
}

export function sortNameFor(name: string | undefined): string {
  return String(name ?? "").trim().toLowerCase().replace(/^(the|a|an)\s+/, "");
}

function baseDto(serverId: string, id: string, kind: string, name: string, folder: boolean): DtoBase {
  return {
    Name: name,
    SortName: sortNameFor(name),
    ServerId: serverId,
    Id: id,
    Etag: id,
    Type: kind,
    MediaType: folder ? "Unknown" : "Video",
    IsFolder: folder,
    LocationType: "FileSystem",
    CanDelete: false,
    LockedFields: [],
    LockData: false,
    ImageBlurHashes: {},
  };
}

function remoteTrailers(meta: StremioMeta): Array<{ Name: string; Url: string }> {
  const out: Array<{ Name: string; Url: string }> = [];
  const seen = new Set<string>();
  const add = (name: unknown, url: unknown) => {
    if (typeof url !== "string") return;
    const clean = url.trim();
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    out.push({ Name: typeof name === "string" && name.trim() ? name.trim() : "Trailer", Url: clean });
  };
  for (const entry of meta.trailerStreams ?? []) {
    if (!entry) continue;
    const ytId = typeof entry.ytId === "string" ? entry.ytId.trim() : "";
    if (ytId) add(entry.title, `https://www.youtube.com/watch?v=${ytId}`);
    else add(entry.title, entry.url);
  }
  for (const entry of meta.trailers ?? []) {
    if (!entry || typeof entry.source !== "string") continue;
    const source = entry.source.trim();
    if (!source) continue;
    add(entry.name, /^https?:\/\//i.test(source) ? source : `https://www.youtube.com/watch?v=${source}`);
  }
  return out;
}

function externalUrls(meta: StremioMeta): Array<{ Name: string; Url: string }> {
  const out: Array<{ Name: string; Url: string }> = [];
  const seen = new Set<string>();
  for (const link of meta.links ?? []) {
    if (!link) continue;
    const url = typeof link.url === "string" ? link.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const name =
      typeof link.name === "string" && link.name.trim()
        ? link.name.trim()
        : typeof link.category === "string" && link.category.trim()
          ? link.category.trim()
          : "Link";
    out.push({ Name: name, Url: url });
    if (out.length >= 8) break;
  }
  return out;
}

function derivedStatus(meta: StremioMeta): string {
  const explicit = typeof meta.status === "string" ? meta.status.trim() : "";
  if (explicit) return explicit;
  const info = typeof meta.releaseInfo === "string" ? meta.releaseInfo.trim() : "";
  if (!info) return "";
  if (/^\d{4}\s*-\s*\d{4}$/.test(info)) return "Ended";
  if (/^\d{4}\s*-\s*$/.test(info)) return "Continuing";
  return "";
}

function posterAspectRatio(meta: StremioMeta): number {
  if (meta.posterShape === "landscape") return 1.7777777777777777;
  if (meta.posterShape === "square") return 1;
  return 0.6666666666666666;
}

function taglineList(meta: StremioMeta): string[] {
  const raw = meta.taglines;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
  }
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

function genreAndRatingFields(
  genres: string[],
  tags: string[],
  genreItems: Array<{ Name: string; Id: string }>,
  studios: Array<{ Id: string; Name: string }>,
  official: string | undefined,
  commRating: number | null,
  critRating: number | null,
  provIds: Record<string, string>,
): Record<string, unknown> {
  return {
    Genres: genres,
    Tags: tags,
    GenreItems: genreItems,
    ...(studios.length > 0 ? { Studios: studios, ProductionCompanies: studios } : {}),
    ...(official ? { OfficialRating: official, CustomRating: official } : {}),
    ...(commRating !== null ? { CommunityRating: commRating } : {}),
    ...(critRating !== null ? { CriticRating: critRating } : {}),
    ProviderIds: provIds,
  };
}

function sharedFields(meta: StremioMeta): Record<string, unknown> {
  const { genres, tags, genreItems } = extractGenresAndTags(meta);
  const studios = extractStudios(meta);
  const official = officialRating(meta);
  const commRating = communityRating(meta.imdbRating ?? meta.imdb_rating ?? meta.rating ?? meta.communityRating);
  const critRating = criticRating(meta);
  const provIds = providerIds(meta.id, meta);
  const imageTags: Record<string, string> = {};
  const primary = artImageTag(meta.poster ?? meta.thumbnail);
  const logo = artImageTag(meta.logo);
  const thumb = artImageTag(meta.landscapePoster ?? meta.background);
  if (primary) imageTags.Primary = primary;
  if (logo) imageTags.Logo = logo;
  if (thumb) imageTags.Thumb = thumb;
  const premiered = premiereDate(meta.released) ?? premiereDateFromYear(meta.releaseInfo);
  const trailers = remoteTrailers(meta);
  const locations = Array.isArray(meta.country) ? meta.country.filter((value): value is string => typeof value === "string") : typeof meta.country === "string" && meta.country.trim() ? [meta.country.trim()] : [];
  const taglines = taglineList(meta);
  const status = derivedStatus(meta);
  const links = externalUrls(meta);

  return {
    OriginalTitle: meta.name,
    Overview: meta.description,
    ProductionYear: productionYear(meta.released ?? meta.releaseInfo),
    PrimaryImageAspectRatio: posterAspectRatio(meta),
    Genres: genres,
    Tags: tags,
    GenreItems: genreItems,
    ...(locations.length > 0 ? { ProductionLocations: locations } : {}),
    ...(status ? { Status: status } : {}),
    ...(taglines.length > 0 ? { Taglines: taglines } : {}),
    ...(studios.length > 0 ? { Studios: studios, ProductionCompanies: studios } : {}),
    ...(official ? { OfficialRating: official, CustomRating: official } : {}),
    ...(commRating !== null ? { CommunityRating: commRating } : {}),
    ...(critRating !== null ? { CriticRating: critRating } : {}),
    ...(premiered ? { PremiereDate: premiered, DateCreated: premiered } : {}),
    ...(trailers.length > 0 ? { RemoteTrailers: trailers } : {}),
    ...(links.length > 0 ? { ExternalUrls: links } : {}),
    ProviderIds: provIds,
    ImageTags: imageTags,
    BackdropImageTags: meta.background ? [artImageTag(meta.background) ?? ""] : [],
  };
}

export function movieDto(
  serverId: string,
  addonUrl: string,
  meta: StremioMeta,
  people?: Record<string, unknown>[],
): Record<string, unknown> {
  const combinedPeople = people && people.length > 0 ? people : extractPeople(meta);
  return {
    ...baseDto(serverId, encodeItem(addonUrl, "movie", meta.id), "Movie", cleanDisplayName(meta.name, meta.id) ?? meta.id, false),
    MediaType: "Video",
    CanDownload: true,
    RunTimeTicks: runtimeTicks(meta.runtime),
    ...sharedFields(meta),
    ...(combinedPeople.length > 0 ? { People: combinedPeople } : {}),
  };
}

export function seriesDto(
  serverId: string,
  addonUrl: string,
  meta: StremioMeta,
  people?: Record<string, unknown>[],
): Record<string, unknown> {
  const episodes = (meta.videos ?? []).filter((v) => typeof v.season === "number" && (typeof v.episode === "number" || typeof v.number === "number"));
  const combinedPeople = people && people.length > 0 ? people : extractPeople(meta);
  const displayName = cleanDisplayName(meta.name, meta.id) ?? meta.id;
  return {
    ...baseDto(serverId, encodeItem(addonUrl, "series", meta.id), "Series", displayName, true),
    ChildCount: seasonNumbers(meta).length,
    RecursiveItemCount: episodes.length,
    ...sharedFields(meta),
    ...(combinedPeople.length > 0 ? { People: combinedPeople } : {}),
  };
}

export function seasonPoster(meta: StremioMeta, season: number): string | null {
  const byNumber = meta.app_extras?.seasonPosterByNumber;
  if (byNumber && typeof byNumber === "object") {
    const hit = (byNumber as Record<string, unknown>)[String(season)];
    if (typeof hit === "string" && hit.length > 0) return hit;
  }
  const direct = meta.seasonPosters?.[String(season)];
  if (direct) return direct;
  const wired = meta.app_extras?.seasonPosters ?? meta.app_extras?.season_posters;
  return seasonPosterFrom(wired, season);
}

function seasonPosterFrom(value: unknown, season: number): string | null {
  if (Array.isArray(value)) {
    const hit = value[season];
    return typeof hit === "string" && hit.length > 0 ? hit : null;
  }
  if (value && typeof value === "object") {
    const hit = (value as Record<string, unknown>)[String(season)];
    return typeof hit === "string" && hit.length > 0 ? hit : null;
  }
  return null;
}

export function seasonDto(
  serverId: string,
  addonUrl: string,
  series: StremioMeta,
  season: number,
): Record<string, unknown> {
  const seriesId = encodeItem(addonUrl, "series", series.id);
  const poster = seasonPoster(series, season) ?? series.poster ?? null;
  const { genres, tags, genreItems } = extractGenresAndTags(series);
  const studios = extractStudios(series);
  const official = officialRating(series);
  const commRating = communityRating(series.imdbRating ?? series.imdb_rating ?? series.rating ?? series.communityRating);
  const critRating = criticRating(series);
  const provIds = providerIds(series.id, series);
  const episodes = seasonEpisodes(series, season);
  const seriesPrimary = artImageTag(series.poster);
  const seasonLogo = artImageTag(series.logo);
  const seasonThumb = artImageTag(series.landscapePoster ?? series.background ?? poster);
  const seasonTags: Record<string, string> = {};
  const seasonPrimary = artImageTag(poster);
  if (seasonPrimary) seasonTags.Primary = seasonPrimary;
  if (seasonLogo) seasonTags.Logo = seasonLogo;
  if (seasonThumb) seasonTags.Thumb = seasonThumb;

  const seriesDisplay = cleanDisplayName(series.name, series.id);
  return {
    ...baseDto(serverId, encodeSeason(addonUrl, series.id, season), "Season", `Season ${season}`, true),
    ...(seriesDisplay ? { SeriesName: seriesDisplay } : {}),
    SeriesId: seriesId,
    ParentId: seriesId,
    IndexNumber: season,
    ChildCount: episodes.length,
    RecursiveItemCount: episodes.length,
    CanDownload: true,
    PrimaryImageAspectRatio: posterAspectRatio(series),
    ProductionYear: productionYear(series.released ?? series.releaseInfo),
    ...genreAndRatingFields(genres, tags, genreItems, studios, official, commRating, critRating, provIds),
    ...(seriesPrimary ? { SeriesPrimaryImageTag: seriesPrimary, ParentPrimaryImageTag: seriesPrimary, ParentPrimaryImageItemId: seriesId } : {}),
    ...(seasonThumb ? { SeriesThumbImageTag: seasonThumb } : {}),
    ImageTags: seasonTags,
    BackdropImageTags: series.background ? [artImageTag(series.background) ?? ""] : [],
  };
}

export function premiereDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  return undefined;
}

function premiereDateFromYear(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /(\d{4})/.exec(value);
  return match?.[1] ? `${match[1]}-01-01T00:00:00.000Z` : undefined;
}

export function episodeDto(
  serverId: string,
  addonUrl: string,
  series: StremioMeta,
  video: StremioVideo,
  people?: Record<string, unknown>[],
): Record<string, unknown> | null {
  const seasonNum = typeof video.season === "number" ? video.season : undefined;
  const episodeNum = videoEpisodeNumber(video);
  if (seasonNum === undefined || episodeNum === undefined) return null;

  const seriesId = encodeItem(addonUrl, "series", series.id);
  const seasonId = encodeSeason(addonUrl, series.id, seasonNum);
  const premiered = premiereDate(video.released);
  const combinedPeople = people && people.length > 0 ? people : extractPeople(series, video);
  const { genres, tags, genreItems } = extractGenresAndTags(series);
  const studios = extractStudios(series);
  const official = officialRating(video, series);
  const commRating = communityRating(video.rating ?? series.imdbRating ?? series.imdb_rating ?? series.rating);
  const critRating = criticRating(video, series);
  const provIds = providerIds(video.id ?? series.id, video, series);
  const epTitle = video.title ?? video.name ?? `Episode ${episodeNum}`;
  const epOverview = video.overview ?? video.description;
  const epRuntime = runtimeTicks(video.runtime ?? series.runtime);
  const epYear = productionYear(video.released ?? series.released ?? series.releaseInfo);
  const episodePrimary = artImageTag(video.thumbnail ?? series.poster);
  const episodeThumb = artImageTag(video.thumbnail ?? series.landscapePoster ?? series.background);
  const seriesPrimary = artImageTag(series.poster);
  const seriesThumb = artImageTag(series.landscapePoster ?? series.background ?? series.poster);
  const seriesBackdrop = artImageTag(series.background);
  const seriesLogo = artImageTag(series.logo);
  const links = externalUrls(series);
  const episodeTags: Record<string, string> = {};
  if (episodePrimary) episodeTags.Primary = episodePrimary;
  if (episodeThumb) episodeTags.Thumb = episodeThumb;
  if (seriesLogo) episodeTags.Logo = seriesLogo;
  const backdropTags = seriesBackdrop ? [seriesBackdrop] : [];

  return {
    ...baseDto(
      serverId,
      encodeEpisode(addonUrl, series.id, seasonNum, episodeNum),
      "Episode",
      epTitle,
      false,
    ),
    SortName: `${String(episodeNum).padStart(4, "0")} - ${sortNameFor(epTitle)}`,
    MediaType: "Video",
    CanDownload: true,
    SeriesName: cleanDisplayName(series.name, series.id) ?? epTitle,
    SeriesId: seriesId,
    SeasonName: `Season ${seasonNum}`,
    SeasonId: seasonId,
    ParentId: seasonId,
    IndexNumber: episodeNum,
    ParentIndexNumber: seasonNum,
    Overview: epOverview,
    RunTimeTicks: epRuntime,
    ProductionYear: epYear,
    ...(premiered ? { DateCreated: premiered } : {}),
    PrimaryImageAspectRatio: 1.7777777777777777,
    ...genreAndRatingFields(genres, tags, genreItems, studios, official, commRating, critRating, provIds),
    ...(premiered ? { PremiereDate: premiered, DateCreated: premiered } : {}),
    ...(links.length > 0 ? { ExternalUrls: links } : {}),
    ...(combinedPeople.length > 0 ? { People: combinedPeople } : {}),
    ...(seriesPrimary ? { SeriesPrimaryImageTag: seriesPrimary, ParentPrimaryImageTag: seriesPrimary, ParentPrimaryImageItemId: seriesId } : {}),
    ...(seriesThumb ? { SeriesThumbImageTag: seriesThumb, ParentThumbImageTag: seriesThumb, ParentThumbItemId: seriesId } : {}),
    ...(seriesBackdrop ? { ParentBackdropImageTags: [seriesBackdrop], ParentBackdropItemId: seriesId } : {}),
    ...(seriesLogo ? { ParentLogoImageTag: seriesLogo, ParentLogoItemId: seriesId } : {}),
    ImageTags: episodeTags,
    BackdropImageTags: backdropTags,
  };
}

export function seasonNumbers(meta: StremioMeta): number[] {
  const seen = new Set<number>();
  for (const video of meta.videos ?? []) {
    if (typeof video.season === "number") seen.add(video.season);
  }
  return [...seen].sort((a, b) => a - b);
}

export function seasonEpisodes(meta: StremioMeta, season: number): StremioVideo[] {
  return (meta.videos ?? [])
    .filter((v) => v.season === season && videoEpisodeNumber(v) !== undefined)
    .sort((a, b) => (videoEpisodeNumber(a) ?? 0) - (videoEpisodeNumber(b) ?? 0));
}

export function episodeVideoId(meta: StremioMeta | null | undefined, season: number | null, episode: number | null): string | null {
  if (!meta || season === null || episode === null) return null;
  const video = seasonEpisodes(meta, season).find((entry) => videoEpisodeNumber(entry) === episode);
  const id = typeof video?.id === "string" ? video.id.trim() : "";
  return id.length > 0 ? id : null;
}

export async function fetchMetaJson(fetchImpl: typeof fetch, target: string): Promise<{ meta?: StremioMeta }> {
  const res = await upstreamFetch(fetchImpl, target, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`meta status ${res.status}`);
  return (await res.json()) as { meta?: StremioMeta };
}

async function addonMeta(
  cache: Cache,
  fetchImpl: typeof fetch,
  base: string,
  metaType: string,
  stremioId: string,
): Promise<StremioMeta | null> {
  const target = `${base}/meta/${metaType}/${stremioSegment(stremioId)}.json`;
  try {
    const outcome = await cachedJson<{ meta?: StremioMeta }>(cache, target, META_TTL_SECONDS, () => fetchMetaJson(fetchImpl, target));
    const meta = outcome.data?.meta;
    if (!meta || typeof meta.id !== "string") return null;
    await rememberPersonPhotos(cache, meta);
    return meta;
  } catch {
        return null;
  }
}

export async function imdbFor(
  _db: D1Database,
  _cache: Cache,
  _fetchImpl: typeof fetch,
  _metaType: string,
  stremioId: string,
): Promise<string | null> {
  if (/^tt\d+$/.test(stremioId)) return stremioId;
  return null;
}

const META_MERGE_FIELDS = ["name", "status", "taglines", "videos", "cast", "seasonPosters"] as const;

function cleanDisplayName(name: string | undefined, id: string): string | undefined {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) return undefined;
  if (clean === id) return undefined;
  if (/^(tt\d+|tmdb:|tvdb:|kitsu:|mal:|anilist:|anidb:)/i.test(clean)) return undefined;
  return clean;
}
const META_MERGE_SERIES_ONLY = new Set<(typeof META_MERGE_FIELDS)[number]>(["videos", "seasonPosters"]);
const MAX_META_ATTEMPTS = 3;

function fieldMissing(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

function nameMissing(meta: StremioMeta): boolean {
  return fieldMissing(meta.name) || cleanDisplayName(meta.name, meta.id) === undefined;
}

function metaField(meta: StremioMeta, field: (typeof META_MERGE_FIELDS)[number]): unknown {
  if (field === "cast") return meta.cast ?? meta.actors ?? meta.app_extras?.cast;
  if (field === "seasonPosters") return meta.seasonPosters ?? meta.app_extras?.seasonPosters ?? meta.app_extras?.season_posters;
  return meta[field];
}

function needsMetaMerge(meta: StremioMeta, metaType: string): boolean {
  return META_MERGE_FIELDS.some((field) => {
    if (metaType !== "series" && META_MERGE_SERIES_ONLY.has(field)) return false;
    if (field === "name") return nameMissing(meta);
    return fieldMissing(metaField(meta, field));
  });
}

function mergeMissingMeta(target: StremioMeta, source: StremioMeta, metaType: string): void {
  for (const field of META_MERGE_FIELDS) {
    if (metaType !== "series" && META_MERGE_SERIES_ONLY.has(field)) continue;
    if (field === "name") {
      if (!nameMissing(target)) continue;
      const incomingName = cleanDisplayName(source.name, source.id);
      if (!incomingName) continue;
      target.name = incomingName;
      continue;
    }
    if (!fieldMissing(metaField(target, field))) continue;
    const incoming = metaField(source, field);
    if (fieldMissing(incoming)) continue;
    if (field === "cast") {
      target.cast = incoming as StremioMeta["cast"];
      continue;
    }
    if (field === "seasonPosters") {
      target.app_extras = { ...(target.app_extras ?? {}), seasonPosters: incoming as (string | null)[] | Record<string, string | null> };
      continue;
    }
    if (field === "videos") {
      if (Array.isArray(incoming)) target.videos = incoming as StremioVideo[];
      continue;
    }
    if (field === "taglines") {
      if (Array.isArray(incoming) || typeof incoming === "string") target.taglines = incoming as string[] | string;
      continue;
    }
    if (typeof incoming === "string") (target as unknown as Record<string, unknown>)[field] = incoming;
  }
}

export interface FetchMetaOptions {
  merge?: boolean;
}

export async function fetchMeta(
  cache: Cache,
  fetchImpl: typeof fetch,
  addonBases: string[],
  firstBase: string,
  metaType: string,
  stremioId: string,
  opts?: FetchMetaOptions,
): Promise<ResolvedMeta | null> {
  const ordered = [normalizeBase(firstBase), ...addonBases.map(normalizeBase).filter((b) => b !== normalizeBase(firstBase))].filter(
    (b) => b.length > 0,
  );
  let resolved: ResolvedMeta | null = null;
  for (const base of ordered) {
    const meta = await addonMeta(cache, fetchImpl, base, metaType, stremioId);
    if (meta) {
      resolved = { addonUrl: base, meta };
      break;
    }
  }
  if (opts?.merge === false) return resolved;
  if (!resolved || !needsMetaMerge(resolved.meta, metaType)) return resolved;
  const capable = await capableBases(cache, fetchImpl, ordered, "meta");
  let attempts = 1;
  const attemptCap = nameMissing(resolved.meta) ? Math.max(MAX_META_ATTEMPTS, capable.length) : MAX_META_ATTEMPTS;
  for (const base of capable) {
    if (attempts >= attemptCap || !needsMetaMerge(resolved.meta, metaType)) break;
    if (base === resolved.addonUrl) continue;
    attempts += 1;
    const meta = await addonMeta(cache, fetchImpl, base, metaType, stremioId);
    if (meta) mergeMissingMeta(resolved.meta, meta, metaType);
  }
  return resolved;
}

export async function profileMeta(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  firstBase: string,
  metaType: string,
  stremioId: string,
): Promise<ResolvedMeta | null> {
  const urls = await catalogBases(db, profileId);
  if (!urls) return null;
  return fetchMeta(cache, fetchImpl, urls, firstBase, metaType, stremioId);
}
