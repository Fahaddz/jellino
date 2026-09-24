import type { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "./db";
import { bearerToken, issueToken, rateAllow, sessionInfoBase, verifyToken, findProfile, userDto } from "./session";

const QC_WINDOW_SECONDS = 600;
const QC_INITIATE_MAX = 10;
const QC_CONNECT_MAX = 60;
const QC_AUTHORIZE_MAX = 30;

interface QuickConnectClientInfo {
  client?: string;
  device?: string;
  deviceId?: string;
  version?: string;
}

interface QuickConnectResult {
  Code: string;
  Secret: string;
  Authenticated: boolean;
  DeviceId: string;
  DeviceName: string;
  AppName: string;
  AppVersion: string;
  DateAdded: string;
  ProfileId?: string | null;
  AuthenticationToken?: string | null;
}

interface QuickConnectRow {
  code: string;
  secret: string;
  profile_id: string | null;
  device_name: string;
  device_id: string;
  client_name: string;
  client_version: string;
  authenticated: number;
  created_at: number;
  expires_at: number;
}

const QUICK_CONNECT_TTL_SECONDS = 600;

function normalizeCode(input: unknown): string {
  return String(input ?? "").replace(/\D/g, "");
}

function randomCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const code = (array[0]! % 1000000).toString().padStart(6, "0");
  return code;
}

function parseClientInfo(req: Request): QuickConnectClientInfo {
  const header = req.headers.get("X-Emby-Authorization") ?? req.headers.get("Authorization") ?? "";
  const clientMatch = /Client="([^"]+)"|Client=([^, ]+)/i.exec(header);
  const deviceMatch = /Device="([^"]+)"|Device=([^, ]+)/i.exec(header);
  const deviceIdMatch = /DeviceId="([^"]+)"|DeviceId=([^, ]+)/i.exec(header);
  const versionMatch = /Version="([^"]+)"|Version=([^, ]+)/i.exec(header);
  const client = clientMatch?.[1] ?? clientMatch?.[2] ?? req.headers.get("User-Agent") ?? null;
  const device = deviceMatch?.[1] ?? deviceMatch?.[2] ?? null;
  const deviceId = deviceIdMatch?.[1] ?? deviceIdMatch?.[2] ?? null;
  const version = versionMatch?.[1] ?? versionMatch?.[2] ?? null;

  const info: QuickConnectClientInfo = {};
  if (client) info.client = client;
  if (device) info.device = device;
  if (deviceId) info.deviceId = deviceId;
  if (version) info.version = version;
  return info;
}

async function initiateQuickConnect(
  db: D1Database,
  client: QuickConnectClientInfo,
  now: number,
): Promise<QuickConnectResult> {
  let code = "";
  for (let i = 0; i < 5; i++) {
    const candidate = randomCode();
    const existing = await db
      .prepare("SELECT code FROM quick_connect WHERE code = ?1 AND expires_at >= ?2")
      .bind(candidate, now)
      .first<{ code: string }>();
    if (!existing) {
      code = candidate;
      break;
    }
  }
  if (!code) throw new Error("could not allocate code");

  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const deviceName = client.device ?? "";
  const deviceId = client.deviceId ?? "";
  const appName = client.client ?? "";
  const appVersion = client.version ?? "";
  const expiresAt = now + QUICK_CONNECT_TTL_SECONDS;

  await db
    .prepare(
      "INSERT INTO quick_connect (code, secret, profile_id, device_name, device_id, client_name, client_version, authenticated, created_at, expires_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
    )
    .bind(code, secret, deviceName, deviceId, appName, appVersion, now, expiresAt)
    .run();

  return {
    Code: code,
    Secret: secret,
    Authenticated: false,
    DeviceId: deviceId,
    DeviceName: deviceName,
    AppName: appName,
    AppVersion: appVersion,
    DateAdded: new Date(now * 1000).toISOString(),
    AuthenticationToken: null,
  };
}

async function readQuickConnect(
  db: D1Database,
  secret: string,
  now: number,
): Promise<QuickConnectResult | null> {
  if (!secret) return null;
  const row = await db
    .prepare("SELECT code, secret, profile_id, device_name, device_id, client_name, client_version, authenticated, created_at, expires_at FROM quick_connect WHERE secret = ?1 AND expires_at >= ?2")
    .bind(secret, now)
    .first<QuickConnectRow>();
  if (!row) return null;

  const isAuthed = Boolean(row.authenticated);
  return {
    Code: row.code,
    Secret: row.secret,
    Authenticated: isAuthed,
    DeviceId: row.device_id,
    DeviceName: row.device_name,
    AppName: row.client_name,
    AppVersion: row.client_version,
    DateAdded: new Date(row.created_at * 1000).toISOString(),
    ProfileId: row.profile_id,
    AuthenticationToken: isAuthed ? row.secret : null,
  };
}

async function authorizeQuickConnect(
  db: D1Database,
  code: string,
  profileId: string,
  now: number,
): Promise<boolean> {
  const clean = normalizeCode(code);
  if (clean.length !== 6) return false;

  const result = await db
    .prepare("UPDATE quick_connect SET authenticated = 1, profile_id = ?1 WHERE code = ?2 AND expires_at >= ?3 AND authenticated = 0")
    .bind(profileId, clean, now)
    .run();

  const changes = (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes > 0;
}

async function claimQuickConnect(
  db: D1Database,
  secret: string,
  now: number,
): Promise<string | null> {
  if (!secret) return null;
  const row = await db
    .prepare("SELECT profile_id FROM quick_connect WHERE secret = ?1 AND authenticated = 1 AND expires_at >= ?2")
    .bind(secret, now)
    .first<{ profile_id: string }>();
  if (!row || !row.profile_id) return null;

  await db.prepare("DELETE FROM quick_connect WHERE secret = ?1").bind(secret).run();
  return row.profile_id;
}

export function registerQuickConnect(
  app: Hono<{ Bindings: Env }>,
  serverId: string,
  serverName = "Jellino",
) {
  app.on(["GET", "POST"], "/QuickConnect/Enabled", (c) => c.json(true));

  app.post("/QuickConnect/Initiate", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Math.floor(Date.now() / 1000);
    if (!(await rateAllow(c.env.DB, `qc-init:${ip}`, QC_WINDOW_SECONDS, QC_INITIATE_MAX, now))) {
      return c.json({ error: "too many requests" }, 429);
    }
    const clientInfo = parseClientInfo(c.req.raw);
    const result = await initiateQuickConnect(c.env.DB, clientInfo, now);
    return c.json(result);
  });

  app.on(["GET", "POST"], "/QuickConnect/Connect", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Math.floor(Date.now() / 1000);
    if (!(await rateAllow(c.env.DB, `qc-connect:${ip}`, QC_WINDOW_SECONDS, QC_CONNECT_MAX, now))) {
      return c.json({ error: "too many requests" }, 429);
    }
    let secret = c.req.query("Secret") ?? c.req.query("secret") ?? "";
    if (!secret && c.req.method === "POST") {
      try {
        const body = (await c.req.json()) as { Secret?: unknown; secret?: unknown };
        secret = String(body.Secret ?? body.secret ?? "");
      } catch {
        void 0;
      }
    }
    if (!secret) return c.json({ error: "missing secret" }, 400);
    const result = await readQuickConnect(c.env.DB, secret, now);
    if (!result) return c.json({ error: "not found" }, 404);
    return c.json(result);
  });

  app.post("/QuickConnect/Authorize", async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const token = bearerToken(c.req.raw);
    const authedProfileId = token ? await verifyToken(c.env.DB, token, now) : null;
    if (!authedProfileId) return c.json({ error: "unauthorized" }, 401);

    if (!(await rateAllow(c.env.DB, `qc-authz:${authedProfileId}`, QC_WINDOW_SECONDS, QC_AUTHORIZE_MAX, now))) {
      return c.json({ error: "too many requests" }, 429);
    }

    let code = c.req.query("Code") ?? c.req.query("code") ?? "";
    const queryUser = c.req.query("UserId") ?? c.req.query("userId");
    let targetProfileId = typeof queryUser === "string" && queryUser ? queryUser : authedProfileId;

    try {
      const body = (await c.req.json()) as {
        Code?: unknown;
        code?: unknown;
        ProfileId?: unknown;
        profileId?: unknown;
        UserId?: unknown;
        userId?: unknown;
      };
      if (body.Code || body.code) code = String(body.Code ?? body.code);
      const chosen = body.ProfileId ?? body.profileId ?? body.UserId ?? body.userId;
      if (typeof chosen === "string" && chosen) targetProfileId = chosen;
    } catch {
      void 0;
    }

    if (!code) return c.json({ error: "missing code" }, 400);

    if (targetProfileId !== authedProfileId) {
      const caller = await findProfile(c.env.DB, authedProfileId);
      if (!caller || caller.is_admin !== 1) {
        return c.json({ error: "forbidden" }, 403);
      }
    }

    const targetProfile = await findProfile(c.env.DB, targetProfileId);
    if (!targetProfile) return c.json({ error: "target profile not found" }, 404);

    const ok = await authorizeQuickConnect(c.env.DB, code, targetProfileId, now);
    if (!ok) return c.json({ error: "invalid or expired code" }, 400);
    return c.json({ Success: true, Authenticated: true });
  });

  app.post("/Users/AuthenticateWithQuickConnect", async (c) => {
    let secret = "";
    try {
      const body = (await c.req.json()) as { Secret?: unknown; secret?: unknown };
      secret = String(body.Secret ?? body.secret ?? "");
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    if (!secret) return c.json({ error: "missing secret" }, 400);

    const now = Math.floor(Date.now() / 1000);
    const profileId = await claimQuickConnect(c.env.DB, secret, now);
    if (!profileId) return c.json({ error: "invalid or expired secret" }, 401);

    const profile = await findProfile(c.env.DB, profileId);
    if (!profile || (profile.disabled ?? 0) === 1) return c.json({ error: "profile unavailable" }, 401);

    const token = await issueToken(c.env.DB, profile.id, now);
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const nowIso = new Date(now * 1000).toISOString();

    return c.json({
      User: userDto(profile, serverId, serverName),
      SessionInfo: {
        ...sessionInfoBase(ip),
        Id: token,
        UserId: profile.id,
        UserName: profile.name,
        Client: "QuickConnect",
        LastActivityDate: nowIso,
        LastPlaybackCheckIn: nowIso,
        DeviceName: "QuickConnect",
        DeviceId: "QuickConnect",
        ApplicationVersion: "1.0.0",
        IsActive: true,
        SupportsMediaControl: false,
      },
      AccessToken: token,
      ServerId: serverId,
    });
  });
}
