import type { D1Database } from "@cloudflare/workers-types";
import type { Context } from "hono";
import { burnPasswordCycle, verifyPassword } from "./auth";
import { toHex } from "./hash";
import { type Env, readSetting } from "./db";
import { queryIgnoreCase } from "./query";

export interface Profile {
  id: string;
  name: string;
  password_hash: string;
  salt: string;
  is_admin: number;
  addon_mode: string;
  disabled?: number;
  created_at: number;
  nuvio_profile_id?: string | null;
  nuvio_profile_index?: number | null;
  avatar_color_hex?: string | null;
  avatar_url?: string | null;
  uses_primary_addons?: number;
}

const TOKEN_PREFIX = "j1";
import { SERVER_VERSION } from "./version";
const TOKEN_TTL_SECONDS = 365 * 86400;
const LOGIN_WINDOW_SECONDS = 600;
const LOGIN_MAX_ATTEMPTS = 10;

const encoder = new TextEncoder();

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function hmacSign(secretHex: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromHex(secretHex), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

const secretCache = new WeakMap<D1Database, string>();
const profileDisabledCache = new WeakMap<D1Database, Map<string, { disabled: number; epoch: number; at: number }>>();

function clearSecretCache(db?: D1Database): void {
  if (db) secretCache.delete(db);
}

export function clearProfileDisabledCache(db?: D1Database, profileId?: string): void {
  if (!db) return;
  if (profileId) {
    profileDisabledCache.get(db)?.delete(profileId);
  } else {
    profileDisabledCache.delete(db);
  }
}

export async function serverSecret(db: D1Database): Promise<string> {
  const cached = secretCache.get(db);
  if (cached) return cached;
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = 'server_secret'")
    .first<{ value: string }>();
  if (row) {
    secretCache.set(db, row.value);
    return row.value;
  }
  const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('server_secret', ?)")
    .bind(fresh)
    .run();
  const again = await db
    .prepare("SELECT value FROM settings WHERE key = 'server_secret'")
    .first<{ value: string }>();
  const value = again?.value ?? fresh;
  secretCache.set(db, value);
  return value;
}

export async function issueToken(db: D1Database, profileId: string, now: number): Promise<string> {
  const secret = await serverSecret(db);
  const epoch = await tokenEpoch(db, profileId);
  const exp = now + TOKEN_TTL_SECONDS;
  const sig = await hmacSign(secret, `${profileId}.${epoch}.${exp}`);
  return `${TOKEN_PREFIX}.${profileId}.${exp}.${sig}`;
}

async function tokenEpoch(db: D1Database, profileId: string): Promise<number> {
  const row = await db
    .prepare("SELECT token_epoch FROM profiles WHERE id = ?")
    .bind(profileId)
    .first<{ token_epoch: number }>();
  return row?.token_epoch ?? 0;
}

export async function bumpTokenEpoch(db: D1Database, profileId: string): Promise<void> {
  await db
    .prepare("UPDATE profiles SET token_epoch = token_epoch + 1 WHERE id = ?")
    .bind(profileId)
    .run();
  clearProfileDisabledCache(db, profileId);
}

export async function verifiedOwner(
  db: D1Database,
  req: Request,
  now: number,
  requested?: string | null,
): Promise<string | null> {
  const token = bearerToken(req);
  const owner = token ? await verifyToken(db, token, now) : null;
  if (!owner) return null;
  if (requested && requested !== owner) return null;
  return owner;
}

export async function verifyToken(db: D1Database, token: string, now: number): Promise<string | null> {
  const parts = token.split(".");
  const prefix = parts[0];
  const profileId = parts[1];
  const expRaw = parts[2];
  const sig = parts[3];
  if (parts.length !== 4 || prefix !== TOKEN_PREFIX || !profileId || !expRaw || !sig) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= now) return null;

  let cache = profileDisabledCache.get(db);
  if (!cache) {
    cache = new Map();
    profileDisabledCache.set(db, cache);
  }
  const cachedProfile = cache.get(profileId);
  const secretPromise = serverSecret(db);
  let profilePromise: Promise<{ disabled: number; token_epoch: number } | null>;
  if (cachedProfile && now - cachedProfile.at < 60) {
    profilePromise = Promise.resolve({ disabled: cachedProfile.disabled, token_epoch: cachedProfile.epoch });
  } else {
    profilePromise = db
      .prepare("SELECT disabled, token_epoch FROM profiles WHERE id = ?")
      .bind(profileId)
      .first<{ disabled: number; token_epoch: number }>()
      .then((row) => {
        if (row) {
          cache?.set(profileId, { disabled: row.disabled ?? 0, epoch: row.token_epoch ?? 0, at: now });
        }
        return row ?? null;
      });
  }

  const [secret, profile] = await Promise.all([secretPromise, profilePromise]);
  const currentEpoch = profile?.token_epoch ?? 0;
  let expected = await hmacSign(secret, `${profileId}.${currentEpoch}.${exp}`);
  if (!timingEqual(expected, sig) && currentEpoch === 0) {
    expected = await hmacSign(secret, `${profileId}.${exp}`);
  }
  if (!timingEqual(expected, sig)) {
    clearSecretCache(db);
    const freshSecret = await serverSecret(db);
    if (freshSecret === secret) return null;
    expected = await hmacSign(freshSecret, `${profileId}.${currentEpoch}.${exp}`);
    if (!timingEqual(expected, sig) && currentEpoch === 0) {
      expected = await hmacSign(freshSecret, `${profileId}.${exp}`);
    }
    if (!timingEqual(expected, sig)) return null;
  }
  if (!profile || (profile.disabled ?? 0) === 1) return null;
  return profileId;
}

export async function rateAllow(db: D1Database, key: string, windowSeconds: number, max: number, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT window_start, count FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ window_start: number; count: number }>();
  if (!row || now - row.window_start >= windowSeconds) {
    await db
      .prepare(
        "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1",
      )
      .bind(key, now)
      .run();
    return true;
  }
  if (row.count >= max) return false;
  await db
    .prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?")
    .bind(key)
    .run();
  return true;
}

async function loginAllowed(db: D1Database, ip: string, now: number): Promise<boolean> {
  return rateAllow(db, `login:${ip}`, LOGIN_WINDOW_SECONDS, LOGIN_MAX_ATTEMPTS, now);
}

export function userDto(profile: Profile, serverId: string, serverName = "Jellino"): Record<string, unknown> {
  const hasLocalPassword = profile.password_hash !== "" && profile.salt !== "";
  const hasPassword = hasLocalPassword;
  return {
    Name: profile.name,
    ServerId: serverId,
    ServerName: serverName,
    Id: profile.id,
    HasPassword: hasPassword,
    HasConfiguredPassword: hasLocalPassword,
    EnableAutoLogin: false,
    LastLoginDate: null,
    LastActivityDate: null,
    PrimaryImageTag: (profile.avatar_url || profile.avatar_color_hex) ? `avatar-${profile.id}` : null,
    PrimaryImageAspectRatio: null,
    Configuration: {
      PlayDefaultAudioTrack: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
      AudioLanguagePreference: "",
      SubtitleLanguagePreference: "",
      SubtitleMode: "Default",
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      HidePlayedInLatest: false,
      MyMediaExcludes: [],
      LatestItemsExcludes: [],
      OrderedViews: [],
    },
    Policy: {
      IsAdministrator: profile.is_admin === 1,
      IsHidden: false,
      IsDisabled: (profile.disabled ?? 0) === 1,
      EnablePlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDownloading: false,
      EnableMediaPlayback: true,
      EnableLiveTvAccess: false,
      EnableMediaConversion: false,
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableAllFolders: true,
      EnableAllDevices: true,
      EnableAllChannels: false,
      EnabledFolders: [],
      BlockedMediaFolders: [],
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: 3,
      MaxActiveSessions: 0,
      AuthenticationProviderId: "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
      PasswordResetProviderId: "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider",
      SyncPlayAccess: "CreateAndJoinGroups",
    },
  };
}

export function publicDto(profile: Profile, serverId: string): Record<string, unknown> {
  const hasLocalPassword = profile.password_hash !== "" && profile.salt !== "";
  const hasPassword = hasLocalPassword;
  return {
    Name: profile.name,
    ServerId: serverId,
    Id: profile.id,
    HasPassword: hasPassword,
    HasConfiguredPassword: hasLocalPassword,
    PrimaryImageTag: (profile.avatar_url || profile.avatar_color_hex) ? `avatar-${profile.id}` : null,
  };
}

export function bearerToken(req: Request): string | null {
  const url = new URL(req.url);
  const raw = url.searchParams.get("api_key") ?? url.searchParams.get("ApiKey");
  if (raw) return raw.split("?")[0] as string;
  const headers = [req.headers.get("X-Emby-Authorization"), req.headers.get("Authorization")];
  for (const header of headers) {
    if (!header) continue;
    const match = /(?:Token="([^"]+)"|Token=([^, ]+)|Bearer\s+([^\s,]+))/i.exec(header);
    const token = match?.[1] ?? match?.[2] ?? match?.[3];
    if (token) return token;
  }
  return req.headers.get("X-Emby-Token") ?? req.headers.get("X-MediaBrowser-Token");
}

export async function readCredentials(
  c: Context<{ Bindings: Env }>,
): Promise<{ email: string; password: string } | Response> {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await c.req.json()) as { email?: unknown; password?: unknown };
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }
  if (typeof body.email !== "string" || typeof body.password !== "string" || !body.email || !body.password) {
    return c.json({ error: "email and password are required" }, 400);
  }
  return { email: body.email, password: body.password };
}

export function sessionInfoBase(ip: string): Record<string, unknown> {
  return {
    PlayState: {
      CanSeek: false,
      IsPaused: false,
      IsMuted: false,
      RepeatMode: "RepeatNone",
      PlaybackOrder: "Default",
    },
    AdditionalUsers: [],
    Capabilities: {
      PlayableMediaTypes: ["Video"],
      SupportedCommands: [],
      SupportsMediaControl: false,
      SupportsPersistentIdentifier: true,
    },
    RemoteEndPoint: ip,
    PlayableMediaTypes: ["Video"],
  };
}

export interface AuthResult {
  ok: boolean;
  status: 200 | 400 | 401 | 429;
  body: Record<string, unknown>;
}

export async function authenticateByName(
  db: D1Database,
  serverId: string,
  name: unknown,
  password: unknown,
  ip: string,
  now: number,
  serverName = "Jellino",
  fetcher: typeof fetch = fetch,
): Promise<AuthResult> {
  if (typeof name !== "string" || typeof password !== "string" || name.length < 1 || name.length > 64) {
    return { ok: false, status: 400, body: { error: "invalid body" } };
  }
  if (!(await loginAllowed(db, ip, now))) {
    return { ok: false, status: 429, body: { error: "too many attempts" } };
  }
  let profile = await db
    .prepare("SELECT id, name, password_hash, salt, is_admin, addon_mode, disabled, created_at, nuvio_profile_id, nuvio_profile_index, avatar_color_hex, avatar_url, uses_primary_addons FROM profiles WHERE name = ?")
    .bind(name)
    .first<Profile>();

  if (!profile && typeof name === "string" && name.includes("@")) {
    const accountStr = await readSetting(db, "nuvio_account");
    if (accountStr) {
      try {
        const parsed = JSON.parse(accountStr);
        if (parsed.email && parsed.email.trim().toLowerCase() === name.trim().toLowerCase()) {
          profile = await db
            .prepare("SELECT id, name, password_hash, salt, is_admin, addon_mode, disabled, created_at, nuvio_profile_id, nuvio_profile_index, avatar_color_hex, avatar_url, uses_primary_addons FROM profiles WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1")
            .first<Profile>();
        }
      } catch {
        void 0;
      }
    }
  }
  const hasLocalPassword = Boolean(profile && profile.password_hash !== "" && profile.salt !== "");
  if (!profile || (profile.disabled ?? 0) === 1 || !hasLocalPassword) {
    await burnPasswordCycle(password);
    if (!profile || (profile.disabled ?? 0) === 1) {
      return { ok: false, status: 401, body: { error: "invalid credentials" } };
    }
    return { ok: false, status: 401, body: { error: "password required" } };
  }

  if (!(await verifyPassword(password, profile.salt, profile.password_hash))) {
    return { ok: false, status: 401, body: { error: "invalid credentials" } };
  }

  const token = await issueToken(db, profile.id, now);
  const nowIso = new Date(now * 1000).toISOString();
  return {
    ok: true,
    status: 200,
    body: {
      User: userDto(profile, serverId, serverName),
      SessionInfo: {
        ...sessionInfoBase(ip),
        Id: crypto.randomUUID(),
        UserId: profile.id,
        UserName: profile.name,
        Client: "Jellyfin",
        LastActivityDate: nowIso,
        LastPlaybackCheckIn: nowIso,
        DeviceName: "Unknown",
        DeviceId: "unknown",
        ApplicationVersion: SERVER_VERSION,
        IsActive: true,
        SupportsMediaControl: false,
        SupportsRemoteControl: false,
        ServerId: serverId,
      },
      AccessToken: token,
      ServerId: serverId,
    },
  };
}

export async function listProfiles(db: D1Database): Promise<Profile[]> {
  const out = await db
    .prepare("SELECT id, name, password_hash, salt, is_admin, addon_mode, disabled, created_at, nuvio_profile_id, nuvio_profile_index, avatar_color_hex, avatar_url, uses_primary_addons FROM profiles ORDER BY created_at ASC")
    .all<Profile>();
  return out.results ?? [];
}

export async function findProfile(db: D1Database, id: string): Promise<Profile | null> {
  return await db
    .prepare("SELECT id, name, password_hash, salt, is_admin, addon_mode, disabled, created_at, nuvio_profile_id, nuvio_profile_index, avatar_color_hex, avatar_url, uses_primary_addons FROM profiles WHERE id = ?")
    .bind(id)
    .first<Profile>();
}

export async function ownerForRequest(c: Context<{ Bindings: Env }>, userId?: string): Promise<string | null> {
  return verifiedOwner(c.env.DB, c.req.raw, Math.floor(Date.now() / 1000), userId ?? queryIgnoreCase(c, "userId"));
}

export async function adminOwner(c: Context<{ Bindings: Env }>): Promise<Profile | null> {
  const now = Math.floor(Date.now() / 1000);
  const token = bearerToken(c.req.raw);
  const owner = token ? await verifyToken(c.env.DB, token, now) : null;
  if (!owner) return null;
  const profile = await findProfile(c.env.DB, owner);
  return profile && profile.is_admin === 1 ? profile : null;
}
