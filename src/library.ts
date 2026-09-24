import type { D1Database } from "@cloudflare/workers-types";
import { readSetting, writeSetting } from "./db";
import { cacheKey, MANIFEST_TTL_SECONDS, upstreamFetch } from "./cache";
import { COLLECTIONS_VIEW_ID, decodeLibrary, encodeLibrary, encodeView } from "./ids";
import { defaultLibraryTag, libraryTileKind } from "./library-art";
import { findProfile } from "./session";

export interface StremioCatalog {
  type: string;
  id: string;
  name?: string;
  pageSize?: number;
  extra?: { name?: string }[];
}

export interface StremioManifest {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  resources?: (string | { name?: unknown })[];
  types?: string[];
  catalogs?: StremioCatalog[];
}

export interface FetchedManifest {
  url: string;
  manifest: StremioManifest;
}

const MAX_BASE_URL_LENGTH = 4096;

const DEFAULT_ADDON_URL = "https://v3-cinemeta.strem.io";

const UNSUPPORTED_CATALOG_TYPES = new Set([
  "music",
  "audio",
  "radio",
  "podcast",
  "podcasts",
  "audiobook",
  "audiobooks",
  "book",
  "books",
  "photo",
  "photos",
  "game",
  "games",
]);

export function catalogSupported(catalogType: string): boolean {
  return !UNSUPPORTED_CATALOG_TYPES.has(catalogType.trim().toLowerCase());
}

export type LibraryMediaKind = "movies" | "tvshows" | "mixed";

export function catalogMediaKind(catalogType: string): LibraryMediaKind {
  const kind = libraryTileKind(catalogType);
  return kind === "movie" ? "movies" : kind === "series" ? "tvshows" : "mixed";
}

export function normalizeAddonUrl(url: string): string {
  let cleaned = url.trim();
  if (cleaned.startsWith("stremio://")) {
    cleaned = `https://${cleaned.slice("stremio://".length)}`;
  }
  return cleaned.replace(/\/+$/, "").replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
}

export function stremioSegment(id: string): string {
  return encodeURIComponent(id).replace(/%3A/gi, ":");
}

function manifestAdvertises(manifest: StremioManifest | undefined, resource: string): boolean {
  if (!manifest) return true;
  const resources = manifest.resources;
  if (!Array.isArray(resources) || resources.length === 0) return true;
  return resources.some((entry) => {
    if (typeof entry === "string") return entry === resource;
    if (entry && typeof entry === "object") {
      return (entry as { name?: unknown }).name === resource;
    }
    return false;
  });
}

export async function capableBases(
  cache: Cache,
  fetchImpl: typeof fetch,
  bases: string[],
  resource: string,
): Promise<string[]> {
  let byUrl: Map<string, StremioManifest>;
  try {
    const fetched = await fetchManifests(cache, fetchImpl, bases);
    byUrl = new Map(fetched.map((entry) => [entry.url, entry.manifest]));
  } catch {
    return bases;
  }
  return bases.filter((base) => manifestAdvertises(byUrl.get(base), resource));
}

async function resolveProfileOwner(db: D1Database, profileId: string): Promise<string> {
  const profile = await findProfile(db, profileId);
  if (!profile) return profileId;
  const followsPrimary = profile.uses_primary_addons === 1;
  if ((profile.addon_mode !== "custom" || followsPrimary) && profile.is_admin !== 1) {
    const admin = await db
      .prepare("SELECT id FROM profiles WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1")
      .first<{ id: string }>();
    if (admin) return admin.id;
  }
  return profileId;
}

export async function resolveAddonUrls(db: D1Database, profileId: string): Promise<string[] | null> {
  const profile = await findProfile(db, profileId);
  if (!profile) return null;
  const owner = await resolveProfileOwner(db, profileId);
  const rows = await db
    .prepare("SELECT url FROM profile_addons WHERE profile_id = ? AND enabled = 1 ORDER BY position ASC")
    .bind(owner)
    .all<{ url: string }>();
  return (rows.results ?? []).map((row) => normalizeAddonUrl(row.url));
}

export async function catalogBases(db: D1Database, profileId: string): Promise<string[] | null> {
  return resolveAddonUrls(db, profileId);
}

const MANIFEST_FAILURE_TTL_SECONDS = 300;
const MANIFEST_MEMORY_TTL_SECONDS = 60;

const manifestMemory = new Map<string, { manifest: StremioManifest | null; at: number }>();

export const manifestMemoryStats = { hits: 0, misses: 0 };

export function resetManifestMemory(): void {
  manifestMemory.clear();
  manifestMemoryStats.hits = 0;
  manifestMemoryStats.misses = 0;
}

function memoryManifest(base: string): StremioManifest | null | undefined {
  const hit = manifestMemory.get(base);
  if (!hit) return undefined;
  if (Date.now() / 1000 - hit.at > MANIFEST_MEMORY_TTL_SECONDS) {
    manifestMemory.delete(base);
    return undefined;
  }
  return hit.manifest;
}

async function manifestFor(
  cache: Cache,
  fetchImpl: typeof fetch,
  url: string,
): Promise<FetchedManifest | null> {
  const base = normalizeAddonUrl(url);
  const remembered = memoryManifest(base);
  if (remembered !== undefined) {
    manifestMemoryStats.hits += 1;
    return remembered === null ? null : { url: base, manifest: remembered };
  }
  manifestMemoryStats.misses += 1;
  const target = `${base}/manifest.json`;
  const key = cacheKey(target);
  try {
    const stored = await cache.match(key);
    if (stored) {
      const data = (await stored.json()) as StremioManifest | null;
      if (data && typeof data === "object" && (data as unknown as { invalid?: unknown }).invalid !== true) {
        const clean: StremioManifest = { ...data, catalogs: Array.isArray(data.catalogs) ? data.catalogs : [] };
        manifestMemory.set(base, { manifest: clean, at: Date.now() / 1000 });
        return { url: base, manifest: clean };
      }
      manifestMemory.set(base, { manifest: null, at: Date.now() / 1000 });
      return null;
    }
  } catch {
    void 0;
  }
  try {
    const res = await upstreamFetch(fetchImpl, target, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`manifest status ${res.status}`);
    const data = (await res.json()) as StremioManifest;
    if (!data || typeof data !== "object") throw new Error("invalid manifest");
    if (data.catalogs !== undefined && !Array.isArray(data.catalogs)) throw new Error("invalid manifest catalogs");
    const clean: StremioManifest = { ...data, catalogs: Array.isArray(data.catalogs) ? data.catalogs : [] };
    manifestMemory.set(base, { manifest: clean, at: Date.now() / 1000 });
    await cache.put(
      key,
      new Response(JSON.stringify(clean), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${MANIFEST_TTL_SECONDS}` },
      }),
    );
    return { url: base, manifest: clean };
  } catch {
    manifestMemory.set(base, { manifest: null, at: Date.now() / 1000 });
    try {
      await cache.put(
        key,
        new Response(JSON.stringify({ invalid: true }), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${MANIFEST_FAILURE_TTL_SECONDS}` },
        }),
      );
    } catch {
      void 0;
    }
    return null;
  }
}

export async function fetchManifests(
  cache: Cache | null,
  fetchImpl: typeof fetch,
  urls: string[],
): Promise<FetchedManifest[]> {
  if (!cache) {
    const settled = await Promise.all(
      urls.map(async (url): Promise<FetchedManifest | null> => {
        const base = normalizeAddonUrl(url);
        try {
          const res = await fetchImpl(`${base}/manifest.json`, { headers: { accept: "application/json" } });
          if (!res.ok) return null;
          const data = (await res.json()) as StremioManifest;
          if (!data || typeof data !== "object") return null;
          const clean: StremioManifest = { ...data, catalogs: Array.isArray(data.catalogs) ? data.catalogs : [] };
          return { url: base, manifest: clean };
        } catch {
          return null;
        }
      }),
    );
    return settled.filter((entry): entry is FetchedManifest => entry !== null);
  }
  const settled = await Promise.all(urls.map((url) => manifestFor(cache, fetchImpl, url)));
  return settled.filter((entry): entry is FetchedManifest => entry !== null);
}

function viewDto(
  serverId: string,
  addonUrl: string,
  catalogType: string,
  catalogId: string,
  name: string,
  kind?: LibraryMediaKind,
): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    Name: name,
    ServerId: serverId,
    Id: encodeView(addonUrl, catalogType, catalogId),
    Type: "CollectionFolder",
    IsFolder: true,
    CanDelete: false,
    CanDownload: false,
    PrimaryImageAspectRatio: 0.6666666666666666,
    ImageTags: { Primary: defaultLibraryTag(catalogType, name) },
  };
  const resolved = kind ?? catalogMediaKind(catalogType);
  if (resolved === "movies") dto.CollectionType = "movies";
  else if (resolved === "tvshows") dto.CollectionType = "tvshows";
  return dto;
}

function boxSetDto(
  serverId: string,
  id: string,
  name: string,
  collectionType?: string,
): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    Name: name,
    ServerId: serverId,
    Id: id,
    Type: "BoxSet",
    IsFolder: true,
    CanDelete: false,
    CanDownload: false,
    PrimaryImageAspectRatio: 0.6666666666666666,
    ImageTags: { Primary: defaultLibraryTag(collectionType, name) },
  };
  if (collectionType) dto.CollectionType = collectionType;
  return dto;
}

export function collectionsFolderDto(serverId: string): Record<string, unknown> {
  return {
    Name: "Collections",
    ServerId: serverId,
    Id: COLLECTIONS_VIEW_ID,
    Type: "CollectionFolder",
    CollectionType: "boxsets",
    IsFolder: true,
    CanDelete: false,
    CanDownload: false,
    PrimaryImageAspectRatio: 0.6666666666666666,
    ImageTags: { Primary: defaultLibraryTag(null, "Collections") },
  };
}

function catalogsToViews(
  fetched: FetchedManifest[],
  serverId: string,
  disabled: Set<string> = new Set(),
): Record<string, unknown>[] {
  const catalogs: ViewCatalog[] = [];
  for (const entry of fetched) {
    for (const raw of entry.manifest.catalogs ?? []) {
      if (!raw || typeof raw.id !== "string" || typeof raw.type !== "string") continue;
      if (!catalogSupported(raw.type)) continue;
      if (disabled.has(catalogKey(entry.url, raw.type, raw.id))) continue;
      catalogs.push({
        addonUrl: entry.url,
        id: raw.id,
        type: raw.type,
        name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.id,
      });
    }
  }
  const counts = new Map<string, number>();
  for (const catalog of catalogs) {
    const key = catalog.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return catalogs.map((catalog) => {
    const duplicate = (counts.get(catalog.name.toLowerCase()) ?? 0) > 1;
    const kind = catalogMediaKind(catalog.type);
    const suffix = kind === "tvshows" ? "Shows" : kind === "movies" ? "Movies" : "Mixed";
    const name = duplicate ? `${catalog.name} ${suffix}` : catalog.name;
    return viewDto(serverId, catalog.addonUrl, catalog.type, catalog.id, name, kind);
  });
}

interface ViewCatalog {
  addonUrl: string;
  id: string;
  type: string;
  name: string;
}

export function catalogKey(base: string, type: string, id: string): string {
  return `${base}|${type}|${id}`;
}

export function firstLandscapeArt(items: { background?: string; poster?: string }[]): string | null {
  const windowed = items.slice(0, 8);
  const hit = windowed.find((m) => m.background) ?? windowed.find((m) => m.poster);
  return hit?.background ?? hit?.poster ?? null;
}

export interface DescribedAddon {
  url: string;
  name: string;
  manifestName: string;
  description: string;
  kind: string;
  resources: string[];
  types: string[];
  ok: boolean;
}

export async function describeAddons(
  cache: Cache,
  fetchImpl: typeof fetch,
  urls: string[],
): Promise<DescribedAddon[]> {
  const bases = urls.map((url) => normalizeAddonUrl(url));
  const fetched = await fetchManifests(cache, fetchImpl, bases);
  const byUrl = new Map(fetched.map((entry) => [entry.url, entry.manifest]));
  return bases.map((url, index) => {
    const raw = urls[index] ?? url;
    const manifest = byUrl.get(url);
    const resources = new Set<string>();
    const types = new Set<string>();
    if (Array.isArray(manifest?.resources)) {
      for (const resource of manifest.resources) {
        if (typeof resource === "string" && resource.length > 0) resources.add(resource);
        else if (resource && typeof resource === "object" && typeof resource.name === "string" && resource.name.length > 0) resources.add(resource.name);
      }
    }
    if (Array.isArray(manifest?.types)) {
      for (const type of manifest.types) {
        if (typeof type === "string" && type.length > 0 && catalogSupported(type)) types.add(type);
      }
    }
    for (const catalog of manifest?.catalogs ?? []) {
      if (typeof catalog?.type === "string" && catalogSupported(catalog.type)) types.add(catalog.type);
      if (Array.isArray(catalog?.extra) && catalog.extra.some((e) => e?.name === "search")) resources.add("search");
      resources.add("catalog");
    }
    let host = raw;
    try {
      host = new URL(url).host;
    } catch {
      host = url;
    }
    const manifestName = typeof manifest?.name === "string" ? manifest.name.trim() : "";
    const description = typeof manifest?.description === "string" ? manifest.description.trim() : "";
    return {
      url,
      name: manifestName || host,
      manifestName,
      description,
      kind: "stremio",
      resources: [...resources].sort(),
      types: [...types].sort(),
      ok: manifest !== undefined,
    };
  });
}

export interface NuvioSnapshotRef {
  base: string;
  type: string;
  id: string;
}

export interface NuvioSnapshotItem {
  addon_id: string;
  base: string | null;
  type: string;
  catalog_id: string;
  enabled: boolean;
  order: number;
  custom_title: string;
  is_collection: boolean;
  collection_id: string;
}

export interface NuvioSnapshotFolder {
  id: string;
  title: string;
  coverImageUrl: string | null;
  refs: NuvioSnapshotRef[];
}

export interface NuvioSnapshotCollection {
  id: string;
  title: string;
  backdropImageUrl: string | null;
  folders: NuvioSnapshotFolder[];
}

export interface NuvioHomeSnapshot {
  hide_unreleased_content: boolean;
  show_catalog_type: boolean;
  items: NuvioSnapshotItem[];
  collections: NuvioSnapshotCollection[];
}

function nuvioHomeKey(profileId: string): string {
  return `nuvio_home:${profileId}`;
}

function cleanSnapshotRef(raw: unknown): NuvioSnapshotRef | null {
  const ref = raw as Partial<NuvioSnapshotRef> | null;
  if (
    !ref ||
    typeof ref.base !== "string" ||
    typeof ref.type !== "string" ||
    typeof ref.id !== "string" ||
    ref.base.length < 1 ||
    ref.base.length > MAX_BASE_URL_LENGTH ||
    ref.type.length < 1 ||
    ref.type.length > 128 ||
    ref.id.length < 1 ||
    ref.id.length > 256 ||
    !catalogSupported(ref.type)
  ) {
    return null;
  }
  return { base: normalizeAddonUrl(ref.base), type: ref.type, id: ref.id };
}

function cleanSnapshotFolder(raw: unknown): NuvioSnapshotFolder | null {
  const folder = raw as Partial<NuvioSnapshotFolder> | null;
  if (!folder || typeof folder.id !== "string" || folder.id.length < 1 || folder.id.length > 256) return null;
  const refs: NuvioSnapshotRef[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(folder.refs) ? folder.refs : []) {
    const ref = cleanSnapshotRef(entry);
    if (!ref) continue;
    const key = catalogKey(ref.base, ref.type, ref.id);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  if (refs.length === 0) return null;
  return {
    id: folder.id,
    title: typeof folder.title === "string" ? folder.title.slice(0, 256) : "",
    coverImageUrl: typeof folder.coverImageUrl === "string" ? folder.coverImageUrl : null,
    refs,
  };
}

function parseNuvioHomeSnapshot(raw: string | null | undefined): NuvioHomeSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NuvioHomeSnapshot> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const items: NuvioSnapshotItem[] = [];
    for (const entry of Array.isArray(parsed.items) ? parsed.items : []) {
      const item = entry as Partial<NuvioSnapshotItem> | null;
      if (!item || typeof item !== "object") continue;
      const isCollection = item.is_collection === true;
      const base = typeof item.base === "string" && item.base.length > 0 ? normalizeAddonUrl(item.base) : null;
      const type = typeof item.type === "string" ? item.type : "";
      const catalogId = typeof item.catalog_id === "string" ? item.catalog_id : "";
      if (!isCollection) {
        if (base === null || base.length > MAX_BASE_URL_LENGTH || !catalogSupported(type)) continue;
        if (type.length < 1 || type.length > 128 || catalogId.length < 1 || catalogId.length > 256) continue;
      }
      items.push({
        addon_id: typeof item.addon_id === "string" ? item.addon_id : "",
        base,
        type,
        catalog_id: catalogId,
        enabled: item.enabled !== false,
        order: typeof item.order === "number" && Number.isFinite(item.order) ? item.order : items.length,
        custom_title: typeof item.custom_title === "string" ? item.custom_title.slice(0, 256) : "",
        is_collection: isCollection,
        collection_id: typeof item.collection_id === "string" ? item.collection_id : "",
      });
    }
    const collections: NuvioSnapshotCollection[] = [];
    for (const entry of Array.isArray(parsed.collections) ? parsed.collections : []) {
      const collection = entry as Partial<NuvioSnapshotCollection> | null;
      if (!collection || typeof collection.id !== "string" || collection.id.length < 1) continue;
      const folders: NuvioSnapshotFolder[] = [];
      for (const rawFolder of Array.isArray(collection.folders) ? collection.folders : []) {
        const folder = cleanSnapshotFolder(rawFolder);
        if (folder) folders.push(folder);
      }
      collections.push({
        id: collection.id,
        title: typeof collection.title === "string" ? collection.title.slice(0, 256) : "",
        backdropImageUrl: typeof collection.backdropImageUrl === "string" ? collection.backdropImageUrl : null,
        folders,
      });
    }
    return {
      hide_unreleased_content: parsed.hide_unreleased_content === true,
      show_catalog_type: parsed.show_catalog_type !== false,
      items,
      collections,
    };
  } catch {
    return null;
  }
}

export async function readNuvioHomeSnapshot(db: D1Database, profileId: string): Promise<NuvioHomeSnapshot | null> {
  try {
    const owner = await resolveProfileOwner(db, profileId);
    const raw = await readSetting(db, nuvioHomeKey(owner));
    if (raw) return parseNuvioHomeSnapshot(raw);
    if (owner !== profileId) {
      const fallback = await readSetting(db, nuvioHomeKey(profileId));
      if (fallback) return parseNuvioHomeSnapshot(fallback);
    }
    return null;
  } catch {
    return null;
  }
}

function snapshotItemKey(item: { addon_id?: string; type?: string; catalog_id?: string; is_collection?: boolean; collection_id?: string }): string {
  return item.is_collection ? `col:${item.collection_id}` : `${item.addon_id || ""}:${item.type || ""}:${item.catalog_id || ""}`;
}

export async function writeNuvioHomeSnapshot(
  db: D1Database,
  profileId: string,
  snapshot: NuvioHomeSnapshot,
): Promise<void> {
  await writeSetting(db, nuvioHomeKey(profileId), JSON.stringify(snapshot));
}

export function catalogDisplayName(
  base: string,
  kind: LibraryMediaKind,
  showCatalogType: boolean,
  duplicate: boolean,
): string {
  const suffix = kind === "movies" ? "Movies" : kind === "tvshows" ? "Shows" : "";
  if (!suffix) return base;
  if (showCatalogType) return `${base} - ${suffix}`;
  return duplicate ? `${base} ${suffix}` : base;
}

export interface ProfileLibrarySplit {
  pinned: Record<string, unknown>[];
  collections: Record<string, unknown>[];
}

function folderMediaKind(folder: NuvioSnapshotFolder): "movies" | "tvshows" | null {
  const kinds = new Set(folder.refs.map((ref) => catalogMediaKind(ref.type)).filter((kind) => kind !== "mixed"));
  if (kinds.size !== 1) return null;
  return [...kinds][0] as "movies" | "tvshows";
}

function boxsetLibraryId(collectionId: string, folderId: string): string {
  return encodeLibrary(`nvcol:${collectionId}:${folderId}`);
}

export function parseBoxsetLibraryId(id: string): { collectionId: string; folderId: string } | null {
  const decoded = decodeLibrary(id);
  if (!decoded || !decoded.startsWith("nvcol:")) return null;
  const rest = decoded.slice("nvcol:".length);
  const split = rest.indexOf(":");
  if (split <= 0 || split >= rest.length - 1) return null;
  return { collectionId: rest.slice(0, split), folderId: rest.slice(split + 1) };
}

function snapshotCollection(
  snapshot: NuvioHomeSnapshot,
  collectionId: string,
  folderId: string,
): { collection: NuvioSnapshotCollection; folder: NuvioSnapshotFolder } | null {
  const collection = snapshot.collections.find((entry) => entry.id === collectionId);
  if (!collection) return null;
  const folder = collection.folders.find((entry) => entry.id === folderId);
  if (!folder) return null;
  return { collection, folder };
}

export interface BoxsetSource {
  base: string;
  type: string;
  id: string;
}

export async function boxsetSources(
  db: D1Database,
  profileId: string,
  boxsetId: string,
): Promise<{ title: string; refs: BoxsetSource[] } | null> {
  const parsed = parseBoxsetLibraryId(boxsetId);
  if (!parsed) return null;
  const snapshot = await readNuvioHomeSnapshot(db, profileId);
  if (!snapshot) return null;
  const hit = snapshotCollection(snapshot, parsed.collectionId, parsed.folderId);
  if (!hit) return null;
  return { title: hit.folder.title || hit.collection.title, refs: hit.folder.refs };
}

export async function profileHiddenCatalogs(db: D1Database, profileId: string): Promise<Set<string>> {
  const snapshot = await readNuvioHomeSnapshot(db, profileId);
  if (!snapshot) return new Set();
  const hidden = new Set<string>();
  for (const item of snapshot.items) {
    if (item.is_collection || item.enabled || !item.base) continue;
    hidden.add(catalogKey(item.base, item.type, item.catalog_id));
  }
  return hidden;
}

export function manifestCatalogIndex(
  fetched: FetchedManifest[],
): { manifestNames: Map<string, string>; validCatalogsByBase: Map<string, Set<string>> } {
  const manifestNames = new Map<string, string>();
  const validCatalogsByBase = new Map<string, Set<string>>();
  for (const entry of fetched) {
    const base = normalizeAddonUrl(entry.url);
    const catSet = new Set<string>();
    for (const catalog of entry.manifest.catalogs ?? []) {
      if (typeof catalog?.id !== "string" || typeof catalog?.type !== "string") continue;
      catSet.add(`${catalog.type}:${catalog.id}`);
      if (typeof catalog?.name === "string" && catalog.name.length > 0) {
        manifestNames.set(catalogKey(base, catalog.type, catalog.id), catalog.name);
      }
    }
    validCatalogsByBase.set(base, catSet);
  }
  return { manifestNames, validCatalogsByBase };
}

function catalogSelectionAllowed(
  base: string,
  type: string,
  id: string,
  validAddons: Set<string> | null,
  validCatalogsByBase: Map<string, Set<string>>,
): boolean {
  if (validAddons && !validAddons.has(base)) return false;
  const cats = validCatalogsByBase.get(base);
  return !cats || cats.has(`${type}:${id}`);
}

function snapshotCatalogAllowed(
  item: NuvioSnapshotItem,
  validAddons: Set<string> | null,
  validCatalogsByBase: Map<string, Set<string>>,
): boolean {
  const base = item.base ? normalizeAddonUrl(item.base) : "";
  if (!base) return false;
  return catalogSelectionAllowed(base, item.type, item.catalog_id, validAddons, validCatalogsByBase);
}

function supportedCatalogs(fetched: FetchedManifest[]): { url: string; type: string; id: string; name: string }[] {
  const out: { url: string; type: string; id: string; name: string }[] = [];
  for (const entry of fetched) {
    for (const catalog of entry.manifest.catalogs ?? []) {
      if (typeof catalog?.id !== "string" || typeof catalog?.type !== "string") continue;
      if (!catalogSupported(catalog.type)) continue;
      out.push({
        url: entry.url,
        type: catalog.type,
        id: catalog.id,
        name: typeof catalog.name === "string" ? catalog.name : "",
      });
    }
  }
  return out;
}

export async function profileLibrarySplit(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
): Promise<ProfileLibrarySplit | null> {
  const urls = await catalogBases(db, profileId);
  if (!urls) return null;
  const hasConfiguredAddons = urls.length > 0;
  const effectiveUrls = hasConfiguredAddons ? urls : [DEFAULT_ADDON_URL];
  const [snapshot, fetched] = await Promise.all([
    readNuvioHomeSnapshot(db, profileId),
    fetchManifests(cache, fetchImpl, effectiveUrls),
  ]);
  if (!snapshot || snapshot.items.length === 0) {
    return { pinned: catalogsToViews(fetched, serverId), collections: [] };
  }
  const { manifestNames, validCatalogsByBase } = manifestCatalogIndex(fetched);
  const validAddons = hasConfiguredAddons ? new Set(effectiveUrls.map((u) => normalizeAddonUrl(u))) : null;
  const ordered = [...snapshot.items].sort((a, b) => a.order - b.order);
  const catalogItems = ordered.filter(
    (item) => item.enabled && !item.is_collection && catalogSupported(item.type) && snapshotCatalogAllowed(item, validAddons, validCatalogsByBase),
  );
  const nameCounts = new Map<string, number>();
  for (const item of catalogItems) {
    const base = item.custom_title || manifestNames.get(catalogKey(normalizeAddonUrl(item.base as string), item.type, item.catalog_id)) || item.catalog_id;
    const key = base.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const pinned: Record<string, unknown>[] = [];
  const collections: Record<string, unknown>[] = [];
  for (const item of ordered) {
    if (!item.enabled) continue;
    if (item.is_collection) {
      const collection = snapshot.collections.find((entry) => entry.id === item.collection_id);
      if (!collection) continue;
      for (const folder of collection.folders) {
        const validRefs = folder.refs.filter((r) =>
          catalogSelectionAllowed(r.base ? normalizeAddonUrl(r.base) : "", r.type, r.id, validAddons, validCatalogsByBase),
        );
        if (validRefs.length === 0) continue;
        const title = item.custom_title || folder.title || collection.title || "Collection";
        const mediaKind = folderMediaKind(folder);
        collections.push(
          boxSetDto(serverId, boxsetLibraryId(collection.id, folder.id), title, mediaKind ?? undefined),
        );
      }
      continue;
    }
    if (!item.base || !catalogSupported(item.type)) continue;
    const base = normalizeAddonUrl(item.base);
    if (!snapshotCatalogAllowed(item, validAddons, validCatalogsByBase)) continue;
    const manifestName = manifestNames.get(catalogKey(base, item.type, item.catalog_id));
    const label = item.custom_title || manifestName || item.catalog_id;
    const kind = catalogMediaKind(item.type);
    const duplicate = (nameCounts.get(label.toLowerCase()) ?? 0) > 1;
    const name = item.custom_title
      ? item.custom_title
      : catalogDisplayName(label, kind, snapshot.show_catalog_type, duplicate);
    pinned.push(viewDto(serverId, base, item.type, item.catalog_id, name, kind));
  }
  if (pinned.length === 0 && collections.length === 0) {
    return { pinned: catalogsToViews(fetched, serverId), collections: [] };
  }
  return { pinned, collections };
}

export async function profileLibraries(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
): Promise<Record<string, unknown>[] | null> {
  const split = await profileLibrarySplit(db, cache, fetchImpl, profileId, serverId);
  return split ? split.pinned : null;
}

export async function profileCollections(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
): Promise<Record<string, unknown>[] | null> {
  const split = await profileLibrarySplit(db, cache, fetchImpl, profileId, serverId);
  return split ? split.collections : null;
}

export async function profileViewItem(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string,
  serverId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (id === COLLECTIONS_VIEW_ID) return collectionsFolderDto(serverId);
  const split = await profileLibrarySplit(db, cache, fetchImpl, profileId, serverId);
  if (!split) return null;
  return split.pinned.find((view) => String(view.Id ?? "") === id)
    ?? split.collections.find((view) => String(view.Id ?? "") === id)
    ?? null;
}

export async function collectionTileInfo(
  db: D1Database,
  profileId: string | null,
  id: string,
): Promise<{ name: string; catalogType: string | null } | null> {
  if (id === COLLECTIONS_VIEW_ID) return { name: "Collections", catalogType: null };
  const parsed = parseBoxsetLibraryId(id);
  if (!parsed) return null;
  const fallback = { name: parsed.folderId || "Collection", catalogType: null };
  if (!profileId) return fallback;
  const snapshot = await readNuvioHomeSnapshot(db, profileId);
  if (!snapshot) return fallback;
  const hit = snapshotCollection(snapshot, parsed.collectionId, parsed.folderId);
  if (!hit) return fallback;
  return {
    name: hit.folder.title || hit.collection.title || "Collection",
    catalogType: folderMediaKind(hit.folder),
  };
}

export async function viewDisplayName(
  db: D1Database,
  cache: Cache,
  fetchImpl: typeof fetch,
  profileId: string | null,
  view: { addonUrl?: string; catalogType: string; catalogId: string },
): Promise<string> {
  if (profileId) {
    const snapshot = await readNuvioHomeSnapshot(db, profileId);
    if (snapshot) {
      const match = snapshot.items.find(
        (item) => !item.is_collection && item.type === view.catalogType && item.catalog_id === view.catalogId,
      );
      if (match) {
        if (match.custom_title) return match.custom_title;
        const kind = catalogMediaKind(match.type);
        const duplicate =
          snapshot.items.filter((item) => item.catalog_id === match.catalog_id).length > 1;
        return catalogDisplayName(match.catalog_id, kind, snapshot.show_catalog_type, duplicate);
      }
    }
  }
  if (view.addonUrl) {
    try {
      const fetched = await fetchManifests(cache, fetchImpl, [view.addonUrl]);
      const hit = (fetched[0]?.manifest.catalogs ?? []).find(
        (catalog) => catalog?.type === view.catalogType && catalog?.id === view.catalogId,
      );
      if (hit && typeof hit.name === "string" && hit.name.length > 0) return hit.name;
    } catch {
      void 0;
    }
  }
  return view.catalogId || "Library";
}

export interface ProfileLibraryItem {
  key: string;
  name: string;
  type: string;
  enabled: boolean;
  isCollection: boolean;
  source: string;
  order: number;
}

export interface ProfileLibrariesResult {
  profileId: string;
  profileName: string;
  isAdmin: boolean;
  followsPrimary: boolean;
  ownerId: string;
  items: ProfileLibraryItem[];
}

export async function readProfileLibraries(
  db: D1Database,
  cache: Cache | null,
  fetchImpl: typeof fetch,
  profileId: string,
): Promise<ProfileLibrariesResult | null> {
  const profile = await findProfile(db, profileId);
  if (!profile) return null;
  const ownerId = await resolveProfileOwner(db, profileId);
  const followsPrimary = ownerId !== profileId;
  let snapshot = await readNuvioHomeSnapshot(db, ownerId);
  if (!snapshot && ownerId !== profileId) {
    snapshot = await readNuvioHomeSnapshot(db, profileId);
  }

  const urls = await catalogBases(db, ownerId);
  const hasConfiguredAddons = Boolean(urls && urls.length > 0);
  const effectiveUrls = hasConfiguredAddons ? (urls as string[]) : [DEFAULT_ADDON_URL];
  const fetched = await fetchManifests(cache, fetchImpl, effectiveUrls);
  const { manifestNames, validCatalogsByBase } = manifestCatalogIndex(fetched);
  const validAddons = hasConfiguredAddons ? new Set(effectiveUrls.map((u) => normalizeAddonUrl(u))) : null;

  const items: ProfileLibraryItem[] = [];
  if (snapshot && snapshot.items.length > 0) {
    for (const item of snapshot.items) {
      if (item.is_collection) {
        const col = snapshot.collections.find((c) => c.id === item.collection_id);
        if (!col) continue;
        const validFolders = (col.folders ?? []).filter((f) =>
          (f.refs ?? []).some((r) =>
            catalogSelectionAllowed(r.base ? normalizeAddonUrl(r.base) : "", r.type, r.id, validAddons, validCatalogsByBase),
          ),
        );
        if (validFolders.length === 0) continue;
        const title = item.custom_title || col?.title || "Collection";
        items.push({
          key: snapshotItemKey(item),
          name: title,
          type: "collection",
          enabled: item.enabled !== false,
          isCollection: true,
          source: `${validFolders.length} folder${validFolders.length === 1 ? "" : "s"}`,
          order: item.order,
        });
        continue;
      }
      const base = item.base ? normalizeAddonUrl(item.base) : "";
      if (!base || !snapshotCatalogAllowed(item, validAddons, validCatalogsByBase)) continue;
      const manifestName = manifestNames.get(catalogKey(base, item.type, item.catalog_id));
      const title = item.custom_title || manifestName || item.catalog_id;
      items.push({
        key: snapshotItemKey(item),
        name: title,
        type: item.type || "catalog",
        enabled: item.enabled !== false,
        isCollection: false,
        source: manifestName ? `${item.type} · ${manifestName}` : (item.type || "catalog"),
        order: item.order,
      });
    }
  }

  if (items.length === 0) {
    let idx = 0;
    for (const catalog of supportedCatalogs(fetched)) {
      items.push({
        key: `${catalog.url}:${catalog.type}:${catalog.id}`,
        name: catalog.name || catalog.id,
        type: catalog.type,
        enabled: true,
        isCollection: false,
        source: catalog.type,
        order: idx++,
      });
    }
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    isAdmin: profile.is_admin === 1,
    followsPrimary,
    ownerId,
    items,
  };
}

export async function updateProfileLibraries(
  db: D1Database,
  profileId: string,
  updates: { key?: string; enabled?: boolean; items?: { key: string; enabled: boolean }[] },
): Promise<boolean> {
  const profile = await findProfile(db, profileId);
  if (!profile) return false;
  const ownerId = await resolveProfileOwner(db, profileId);
  let snapshot = await readNuvioHomeSnapshot(db, ownerId);
  if (!snapshot && ownerId !== profileId) {
    snapshot = await readNuvioHomeSnapshot(db, profileId);
  }
  if (!snapshot) {
    const urls = await catalogBases(db, ownerId);
    const effectiveUrls = urls && urls.length > 0 ? urls : [DEFAULT_ADDON_URL];
    const fetched = await fetchManifests(null, fetch, effectiveUrls);
    const synthesized: NuvioSnapshotItem[] = [];
    let order = 0;
    for (const catalog of supportedCatalogs(fetched)) {
      synthesized.push({
        addon_id: catalog.url,
        base: catalog.url,
        type: catalog.type,
        catalog_id: catalog.id,
        enabled: true,
        order: order++,
        custom_title: catalog.name,
        is_collection: false,
        collection_id: "",
      });
    }
    if (synthesized.length > 0) {
      snapshot = {
        hide_unreleased_content: false,
        show_catalog_type: true,
        items: synthesized,
        collections: [],
      };
    }
  }
  if (!snapshot) return false;

  const targetMap = new Map<string, boolean>();
  if (typeof updates.key === "string" && typeof updates.enabled === "boolean") {
    targetMap.set(updates.key, updates.enabled);
  }
  if (Array.isArray(updates.items)) {
    for (const u of updates.items) {
      if (typeof u?.key === "string" && typeof u?.enabled === "boolean") {
        targetMap.set(u.key, u.enabled);
      }
    }
  }

  for (const item of snapshot.items) {
    const k = snapshotItemKey(item);
    if (targetMap.has(k)) {
      item.enabled = targetMap.get(k)!;
    }
  }

  await writeNuvioHomeSnapshot(db, ownerId, snapshot);
  if (ownerId !== profileId) {
    await writeNuvioHomeSnapshot(db, profileId, snapshot);
  }
  return true;
}
