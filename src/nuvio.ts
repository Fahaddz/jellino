import type { D1Database } from "@cloudflare/workers-types";
import { deleteSetting, readSetting, writeSetting } from "./db";
export const NUVIO_API_URL = "https://api.nuvio.tv";
export const NUVIO_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI";

export interface NuvioSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email: string;
  };
}

export interface NuvioProfile {
  id: string;
  user_id: string;
  profile_index: number;
  name: string;
  avatar_color_hex: string;
  avatar_url?: string | null;
  avatar_id?: string | null;
  uses_primary_addons: boolean;
  uses_primary_plugins?: boolean;
  created_at?: string;
  updated_at?: string;
}

export const NUVIO_AVATAR_STORAGE_BASE = "https://api.nuvio.tv/storage/v1/object/public/avatars";

export const NUVIO_BUILTIN_AVATARS: Record<string, string> = {
  avatar_lalo: "animals/bram-v1.png",
  avatar_lara: "animals/clover-v1.png",
  avatar_levi: "animals/pip-v1.png",
  avatar_mikasa: "animals/otto-v1.png",
  avatar_naruto: "animals/milo-v1.png",
  avatar_negan: "animals/miso-v1.png",
  avatar_neo: "animals/elio-v1.png",
  avatar_rick_grimes: "animals/finn-v1.png",
  avatar_saitama: "animals/poppy-v1.png",
  avatar_saul_goodman: "animals/bao-v1.png",
  avatar_linear_woman_teal: "avatar_linear_teal_v3.png",
  avatar_linear_man_purple: "avatar_linear_purple_v3.png",
  avatar_linear_woman_red: "avatar_linear_red_v3.png",
  avatar_linear_man_navy: "avatar_linear_navy_v3.png",
  avatar_linear_woman_yellow: "avatar_linear_yellow_v3.png",
  avatar_linear_man_green: "avatar_linear_green_v3.png",
  avatar_linear_woman_pink: "avatar_linear_pink_v3.png",
  avatar_aang: "originals/nova-v1.png",
  avatar_arthur_morgan: "originals/bolt-v1.png",
  avatar_ash: "originals/marina-v1.png",
  avatar_chihiro: "originals/shadow-v1.png",
  avatar_daenerys: "originals/rook-v1.png",
  avatar_dexter: "originals/riff-v1.png",
  avatar_eleven: "originals/clue-v1.png",
  avatar_eren: "originals/cedar-v1.png",
  avatar_furiosa: "originals/ruby-v1.png",
  avatar_geralt: "originals/sage-v1.png",
  avatar_gojo: "portraits/quinn-v1.png",
  avatar_goku: "portraits/iris-v1.png",
  avatar_harry_potter: "portraits/ari-v1.png",
  avatar_jack_sparrow: "portraits/hugo-v1.png",
  avatar_jinwoo: "portraits/skye-v1.png",
  avatar_joel: "portraits/maya-v1.png",
  avatar_jon_snow: "portraits/drew-v1.png",
  avatar_katara: "portraits/leo-v1.png",
  avatar_killua: "portraits/zia-v1.png",
  avatar_kratos: "portraits/elle-v1.png",
  avatar_tommy_shelby: "sketches/rowan-v1.png",
  avatar_v: "sketches/silas-v1.png",
  avatar_walter_white: "sketches/nico-v1.png",
  avatar_wednesday: "sketches/violet-v1.png",
  avatar_moss: "sketches/moss-v1.png",
};

export const NUVIO_BUILTIN_AVATAR_BY_NAME: Record<string, string> = {
  bram: "animals/bram-v1.png",
  clover: "animals/clover-v1.png",
  pip: "animals/pip-v1.png",
  otto: "animals/otto-v1.png",
  milo: "animals/milo-v1.png",
  miso: "animals/miso-v1.png",
  elio: "animals/elio-v1.png",
  finn: "animals/finn-v1.png",
  poppy: "animals/poppy-v1.png",
  bao: "animals/bao-v1.png",
  lin: "avatar_linear_teal_v3.png",
  max: "avatar_linear_purple_v3.png",
  ava: "avatar_linear_red_v3.png",
  theo: "avatar_linear_navy_v3.png",
  zara: "avatar_linear_yellow_v3.png",
  kai: "avatar_linear_green_v3.png",
  nova: "avatar_linear_pink_v3.png",
  bolt: "originals/bolt-v1.png",
  marina: "originals/marina-v1.png",
  shadow: "originals/shadow-v1.png",
  rook: "originals/rook-v1.png",
  riff: "originals/riff-v1.png",
  clue: "originals/clue-v1.png",
  cedar: "originals/cedar-v1.png",
  ruby: "originals/ruby-v1.png",
  sage: "originals/sage-v1.png",
  quinn: "portraits/quinn-v1.png",
  iris: "portraits/iris-v1.png",
  ari: "portraits/ari-v1.png",
  hugo: "portraits/hugo-v1.png",
  skye: "portraits/skye-v1.png",
  maya: "portraits/maya-v1.png",
  drew: "portraits/drew-v1.png",
  leo: "portraits/leo-v1.png",
  zia: "portraits/zia-v1.png",
  elle: "portraits/elle-v1.png",
  rowan: "sketches/rowan-v1.png",
  silas: "sketches/silas-v1.png",
  nico: "sketches/nico-v1.png",
  violet: "sketches/violet-v1.png",
  moss: "sketches/moss-v1.png",
};

export function resolveNuvioAvatarUrl(np: { avatar_url?: string | null; avatar_id?: string | null }): string | null {
  if (np.avatar_url && /^https?:/i.test(np.avatar_url)) return np.avatar_url;
  if (!np.avatar_id) return null;
  const key = np.avatar_id.trim();
  const lower = key.toLowerCase();
  const matched = NUVIO_BUILTIN_AVATARS[key] || NUVIO_BUILTIN_AVATARS[lower] || NUVIO_BUILTIN_AVATAR_BY_NAME[lower];
  if (matched) return `${NUVIO_AVATAR_STORAGE_BASE}/${matched}`;
  if (/^https?:/i.test(key)) return key;
  if (key.includes("/")) return `${NUVIO_AVATAR_STORAGE_BASE}/${key.replace(/^\/+/, "")}`;
  return null;
}

export interface NuvioAddon {
  id?: string;
  user_id?: string;
  profile_id?: number | string | null;
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
}

export function matchesNuvioAddon(
  a: NuvioAddon,
  targetId: number,
  isPrimaryProfile: boolean,
  profileUuid?: string | null,
): boolean {
  if (!a || !a.url) return false;
  if (a.enabled === false || (a.enabled as unknown) === 0) return false;

  const raw = a.profile_id;
  if (typeof raw === "string" && profileUuid && raw === profileUuid) return true;

  const num = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(num)) {
    if (num === targetId) return true;
  }

  if (raw === null || raw === undefined || raw === "") {
    return isPrimaryProfile;
  }

  return false;
}

interface NuvioAddonTargetContext {
  selfIndex: number;
  selfUuid: string | null;
  usesPrimaryAddons: boolean;
  primaryIndex: number | null;
  primaryUuid: string | null;
  isPrimaryProfile: boolean;
  minIndex: number;
  hasZeroAddon: boolean;
}

export function nuvioAddonTarget(context: NuvioAddonTargetContext): { targetAddonId: number; targetNuvioUuid: string | null; isPrimary: boolean } {
  const effIndex = context.usesPrimaryAddons ? (context.primaryIndex ?? context.selfIndex) : context.selfIndex;
  const targetAddonId = (context.minIndex === 0 && !context.hasZeroAddon) ? effIndex + 1 : effIndex;
  const targetNuvioUuid = context.usesPrimaryAddons ? (context.primaryUuid ?? context.selfUuid) : context.selfUuid;
  return { targetAddonId, targetNuvioUuid, isPrimary: context.isPrimaryProfile };
}

export interface NuvioAccountSettings {
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  last_sync?: number | undefined;
}

export interface WatchProgressSyncEntry {
  content_id: string;
  content_type: string;
  video_id: string;
  season?: number | null;
  episode?: number | null;
  position: number;
  duration: number;
  last_watched: number;
  progress_key: string;
}

export interface WatchedSyncItem {
  content_id: string;
  content_type: string;
  title?: string;
  season?: number | null;
  episode?: number | null;
  watched_at: number;
}

export interface LibrarySyncItem {
  content_id: string;
  content_type: string;
  name?: string;
  poster?: string | null;
  added_at?: number;
}

async function resilientNuvioFetch(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit = {},
  retries = 2,
  retryDelay = 50,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, options);
      if (res.status === 429 && attempt < retries) {
        const retryAfterHeader = res.headers?.get("retry-after");
        let delayMs = retryDelay * Math.pow(2, attempt);
        if (retryAfterHeader) {
          const parsed = parseFloat(retryAfterHeader);
          if (!Number.isNaN(parsed) && parsed > 0) {
            delayMs = Math.min(parsed * 1000, 2000);
          }
        }
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelay * Math.pow(2, attempt)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelay * Math.pow(2, attempt)));
      }
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError || "Nuvio network request failed"));
}

function nuvioRestHeaders(token: string): Record<string, string> {
  return {
    "apikey": NUVIO_ANON_KEY,
    "Authorization": `Bearer ${token}`,
  };
}

type NuvioRestResult<T> = { ok: true; items: T[] } | { ok: false; error: string };

async function nuvioRestArray<T>(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  errorPrefix: string,
): Promise<NuvioRestResult<T>> {
  try {
    const res = await resilientNuvioFetch(fetchImpl, `${NUVIO_API_URL}${path}`, {
      headers: nuvioRestHeaders(token),
    });
    if (!res.ok) return { ok: false, error: `${errorPrefix} (${res.status})` };
    return { ok: true, items: (await res.json()) as T[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function nuvioAuthError(res: Response, fallback: string): Promise<string> {
  let msg = `${fallback} (${res.status})`;
  try {
    const json = JSON.parse(await res.text());
    if (json.msg || json.error_description || json.error) {
      msg = json.msg || json.error_description || json.error;
    }
  } catch {
    void 0;
  }
  return msg;
}

async function nuvioLogin(
  fetchImpl: typeof fetch,
  email: string,
  password: string,
): Promise<{ ok: boolean; session?: NuvioSession; error?: string }> {
  try {
    const res = await resilientNuvioFetch(fetchImpl, `${NUVIO_API_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "apikey": NUVIO_ANON_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      return { ok: false, error: await nuvioAuthError(res, "Nuvio login failed") };
    }

    const session = (await res.json()) as NuvioSession;
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const nuvioSignIn = nuvioLogin;

export async function nuvioSignInAndSave(
  db: D1Database,
  fetchImpl: typeof fetch,
  email: string,
  password: string,
): Promise<{ ok: true; session: NuvioSession; email: string } | { ok: false; error: string }> {
  const signInRes = await nuvioLogin(fetchImpl, email, password);
  if (!signInRes.ok || !signInRes.session) {
    return { ok: false, error: signInRes.error || "Nuvio login failed" };
  }
  const now = Math.floor(Date.now() / 1000);
  const resolvedEmail = signInRes.session.user.email || email;
  await saveNuvioAccount(db, {
    email: resolvedEmail,
    access_token: signInRes.session.access_token,
    refresh_token: signInRes.session.refresh_token,
    expires_at: now + (signInRes.session.expires_in || 3600),
    last_sync: 0,
  });
  return { ok: true, session: signInRes.session, email: resolvedEmail };
}

async function nuvioRefreshToken(
  fetchImpl: typeof fetch,
  refreshToken: string,
): Promise<{ ok: boolean; session?: NuvioSession; error?: string }> {
  try {
    const res = await resilientNuvioFetch(fetchImpl, `${NUVIO_API_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "apikey": NUVIO_ANON_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      return { ok: false, error: await nuvioAuthError(res, "Token refresh failed") };
    }

    const session = (await res.json()) as NuvioSession;
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function nuvioPullProfiles(
  fetchImpl: typeof fetch,
  token: string,
): Promise<{ ok: boolean; profiles?: NuvioProfile[]; error?: string }> {
  try {
    let res = await resilientNuvioFetch(
      fetchImpl,
      `${NUVIO_API_URL}/rest/v1/profiles?select=id,user_id,profile_index,name,avatar_color_hex,avatar_url,avatar_id,uses_primary_addons,uses_primary_plugins,created_at,updated_at&order=profile_index.asc`,
      {
        headers: nuvioRestHeaders(token),
      },
    );

    if (!res.ok) {
      res = await resilientNuvioFetch(
        fetchImpl,
        `${NUVIO_API_URL}/rest/v1/profiles?select=*&order=profile_index.asc`,
        {
          headers: nuvioRestHeaders(token),
        },
      );
    }

    if (!res.ok) {
      res = await resilientNuvioFetch(
        fetchImpl,
        `${NUVIO_API_URL}/rest/v1/profiles?select=*`,
        {
          headers: nuvioRestHeaders(token),
        },
      );
    }

    if (!res.ok) {
      return { ok: false, error: `Failed to pull profiles (${res.status})` };
    }

    const profiles = (await res.json()) as NuvioProfile[];
    return { ok: true, profiles };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function nuvioPullAddons(
  fetchImpl: typeof fetch,
  token: string,
): Promise<{ ok: boolean; addons?: NuvioAddon[]; error?: string }> {
  try {
    let res = await resilientNuvioFetch(
      fetchImpl,
      `${NUVIO_API_URL}/rest/v1/addons?select=id,user_id,profile_id,url,name,enabled,sort_order&order=sort_order.asc`,
      {
        headers: nuvioRestHeaders(token),
      },
    );

    if (!res.ok) {
      res = await resilientNuvioFetch(
        fetchImpl,
        `${NUVIO_API_URL}/rest/v1/profile_addons?select=id,user_id,profile_id,url,name,enabled,sort_order&order=sort_order.asc`,
        {
          headers: {
            "apikey": NUVIO_ANON_KEY,
            "Authorization": `Bearer ${token}`,
          },
        },
      );
    }

    if (!res.ok) {
      res = await resilientNuvioFetch(
        fetchImpl,
        `${NUVIO_API_URL}/rest/v1/addons?select=*`,
        {
          headers: {
            "apikey": NUVIO_ANON_KEY,
            "Authorization": `Bearer ${token}`,
          },
        },
      );
    }

    if (!res.ok) {
      res = await resilientNuvioFetch(
        fetchImpl,
        `${NUVIO_API_URL}/rest/v1/profile_addons?select=*`,
        {
          headers: {
            "apikey": NUVIO_ANON_KEY,
            "Authorization": `Bearer ${token}`,
          },
        },
      );
    }

    if (!res.ok) {
      return { ok: false, error: `Failed to pull addons (${res.status})` };
    }

    const addons = (await res.json()) as NuvioAddon[];
    return { ok: true, addons };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function nuvioPullWatchProgress(
  fetchImpl: typeof fetch,
  token: string,
  profileIndex: number,
): Promise<{ ok: boolean; entries?: WatchProgressSyncEntry[]; error?: string }> {
  const result = await nuvioRestArray<WatchProgressSyncEntry>(
    fetchImpl,
    token,
    `/rest/v1/profile_watch_progress?profile_id=eq.${profileIndex}&select=content_id,content_type,video_id,season,episode,position,duration,last_watched,progress_key`,
    "Failed to pull watch progress",
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, entries: result.items };
}

export async function nuvioDeleteWatchProgress(
  fetchImpl: typeof fetch,
  token: string,
  profileIndex: number,
  progressKeys: string[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (progressKeys.length === 0) return { ok: true };
    const inFilter = progressKeys.map((k) => `"${encodeURIComponent(k)}"`).join(",");
    const res = await resilientNuvioFetch(
      fetchImpl,
      `${NUVIO_API_URL}/rest/v1/profile_watch_progress?profile_id=eq.${profileIndex}&progress_key=in.(${inFilter})`,
      {
        method: "DELETE",
        headers: nuvioRestHeaders(token),
      },
    );

    if (!res.ok) {
      return { ok: false, error: `Failed to delete watch progress (${res.status})` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function nuvioPullWatchedItems(
  fetchImpl: typeof fetch,
  token: string,
  profileIndex: number,
): Promise<{ ok: boolean; items?: WatchedSyncItem[]; error?: string }> {
  const result = await nuvioRestArray<WatchedSyncItem>(
    fetchImpl,
    token,
    `/rest/v1/profile_watched?profile_id=eq.${profileIndex}&select=content_id,content_type,title,season,episode,watched_at`,
    "Failed to pull watched items",
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, items: result.items };
}

async function nuvioDeleteEach(
  fetchImpl: typeof fetch,
  token: string,
  paths: string[],
  errorPrefix: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const path of paths) {
      const res = await resilientNuvioFetch(fetchImpl, `${NUVIO_API_URL}${path}`, {
        method: "DELETE",
        headers: nuvioRestHeaders(token),
      });
      if (!res.ok) return { ok: false, error: `${errorPrefix} (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function nuvioDeleteWatchedItems(
  fetchImpl: typeof fetch,
  token: string,
  profileIndex: number,
  items: { content_id: string; season?: number | null; episode?: number | null }[],
): Promise<{ ok: boolean; error?: string }> {
  const paths = items.map((item) => {
    let path = `/rest/v1/profile_watched?profile_id=eq.${profileIndex}&content_id=eq.${encodeURIComponent(item.content_id)}`;
    if (item.season !== undefined && item.season !== null) {
      path += `&season=eq.${item.season}`;
    }
    if (item.episode !== undefined && item.episode !== null) {
      path += `&episode=eq.${item.episode}`;
    }
    return path;
  });
  return nuvioDeleteEach(fetchImpl, token, paths, "Failed to delete watched item");
}

export async function nuvioPullLibrary(
  fetchImpl: typeof fetch,
  token: string,
  profileIndex: number,
): Promise<{ ok: boolean; items?: LibrarySyncItem[]; error?: string }> {
  const result = await nuvioRestArray<LibrarySyncItem>(
    fetchImpl,
    token,
    `/rest/v1/profile_library?profile_id=eq.${profileIndex}&select=content_id,content_type,name,poster,added_at`,
    "Failed to pull library",
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, items: result.items };
}

export async function nuvioDeleteLibraryItems(
  fetchImpl: typeof fetch,
  token: string,
  profileIndex: number,
  items: { content_id: string; content_type: string }[],
): Promise<{ ok: boolean; error?: string }> {
  const paths = items.map(
    (item) =>
      `/rest/v1/profile_library?profile_id=eq.${profileIndex}&content_id=eq.${encodeURIComponent(item.content_id)}&content_type=eq.${encodeURIComponent(item.content_type)}`,
  );
  return nuvioDeleteEach(fetchImpl, token, paths, "Failed to delete library item");
}

export async function readNuvioAccount(db: D1Database): Promise<NuvioAccountSettings | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = 'nuvio_account'")
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as NuvioAccountSettings;
  } catch {
    return null;
  }
}

export async function saveNuvioAccount(db: D1Database, settings: NuvioAccountSettings): Promise<void> {
  await writeSetting(db, "nuvio_account", JSON.stringify(settings));
}

export async function removeNuvioAccount(db: D1Database): Promise<void> {
  await deleteSetting(db, "nuvio_account");
}

const nuvioTokenInflight = new WeakMap<D1Database, Promise<{ token: string; email: string } | null>>();

export async function getValidNuvioToken(
  db: D1Database,
  fetchImpl: typeof fetch,
  force = false,
): Promise<{ token: string; email: string } | null> {
  const pending = nuvioTokenInflight.get(db);
  if (pending) return pending;
  const task = refreshNuvioTokenFor(db, fetchImpl, force);
  nuvioTokenInflight.set(db, task);
  try {
    return await task;
  } finally {
    nuvioTokenInflight.delete(db);
  }
}

async function refreshNuvioTokenFor(
  db: D1Database,
  fetchImpl: typeof fetch,
  force: boolean,
): Promise<{ token: string; email: string } | null> {
  const account = await readNuvioAccount(db);
  if (!account) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!force && account.expires_at > now + 60 && account.access_token) {
    return { token: account.access_token, email: account.email };
  }

  let session: NuvioSession | undefined;
  if (account.refresh_token) {
    const refreshed = await nuvioRefreshToken(fetchImpl, account.refresh_token);
    if (refreshed.ok && refreshed.session) {
      session = refreshed.session;
    }
  }
  if (!session) {
    const current = await readNuvioAccount(db);
    if (current && current !== account && current.expires_at > now && current.access_token) {
      return { token: current.access_token, email: current.email };
    }
  }

  if (!session) {
    if (!force && account.expires_at > now && account.access_token) {
      return { token: account.access_token, email: account.email };
    }
    return null;
  }

  const updated: NuvioAccountSettings = {
    email: account.email,
    access_token: session.access_token,
    refresh_token: session.refresh_token || account.refresh_token,
    expires_at: now + (session.expires_in || 3600),
    last_sync: account.last_sync,
  };
  await saveNuvioAccount(db, updated);
  return { token: updated.access_token, email: updated.email };
}
