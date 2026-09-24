import type { Context, Hono } from "hono";
import type { Env } from "./db";
import { readSetting, writeSetting } from "./db";
import { hashPassword, newSalt } from "./auth";
import { describeAddons, normalizeAddonUrl, readProfileLibraries, updateProfileLibraries } from "./library";
import { adminOwner, clearProfileDisabledCache, findProfile, listProfiles, readCredentials, type Profile } from "./session";
import { logApp } from "./applog";
import { syncFromNuvio, syncHomeLibraries, syncProfileFromNuvio } from "./nuvio-home";
import {
  getValidNuvioToken,
  readNuvioAccount,
  removeNuvioAccount,
  saveNuvioAccount,
  nuvioSignInAndSave,
} from "./nuvio";

interface ProfileResult {
  ok: boolean;
  status: 200 | 201 | 400 | 403 | 404 | 409;
  body: Record<string, unknown>;
}

function adminDto(profile: Profile): Record<string, unknown> {
  const hasPassword = Boolean(profile.password_hash !== '' && profile.salt !== '');
  return {
    id: profile.id,
    name: profile.name,
    admin: profile.is_admin === 1,
    disabled: (profile.disabled ?? 0) === 1,
    addonMode: profile.addon_mode,
    createdAt: profile.created_at,
    hasPassword,
    nuvioProfileId: profile.nuvio_profile_id ?? null,
    nuvioProfileIndex: profile.nuvio_profile_index ?? null,
    avatarColorHex: profile.avatar_color_hex ?? null,
    avatarUrl: profile.avatar_url ?? null,
    usesPrimaryAddons: (profile.uses_primary_addons ?? 0) === 1,
  };
}

function cleanPassword(password: unknown): string | null {
  if (typeof password !== "string") return null;
  return password.length >= 8 && password.length <= 256 ? password : null;
}

async function setProfilePassword(
  db: D1Database,
  id: string,
  password: unknown,
): Promise<ProfileResult> {
  const profile = await findProfile(db, id);
  if (!profile) return { ok: false, status: 404, body: { error: "not found" } };
  const validPassword = cleanPassword(password);
  if (!validPassword) return { ok: false, status: 400, body: { error: "password required" } };
  const salt = newSalt();
  const passwordHash = await hashPassword(validPassword, salt);
  await db
    .prepare("UPDATE profiles SET password_hash = ?, salt = ?, token_epoch = token_epoch + 1 WHERE id = ?")
    .bind(passwordHash, salt, id)
    .run();
  clearProfileDisabledCache(db, id);
  const next = await findProfile(db, id);
  if (!next) return { ok: false, status: 404, body: { error: "not found" } };
  return { ok: true, status: 200, body: adminDto(next) };
}

async function readAddonLabels(db: D1Database): Promise<Record<string, string>> {
  try {
    const raw = await readSetting(db, "addon_labels");
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function labelKey(profileId: string, url: string): string {
  return `${profileId}|${url}`;
}

interface BuiltinEntry {
  id: string;
  name: string;
  kind: string;
  system: boolean;
  enabled: boolean;
  description: string;
}

async function builtinEntries(_db: D1Database): Promise<BuiltinEntry[]> {
  return [];
}

async function readAddons(
  db: D1Database,
  cache: Cache | null,
  fetchImpl: typeof fetch | null,
  id: string,
): Promise<Record<string, unknown> | null> {
  const profile = await findProfile(db, id);
  if (!profile) return null;
  const rows = await db
    .prepare("SELECT url, position, enabled FROM profile_addons WHERE profile_id = ? ORDER BY position ASC")
    .bind(id)
    .all<{ url: string; position: number; enabled: number }>();
  const urls = (rows.results ?? []).map((r) => r.url);
  const enabledByUrl = new Map((rows.results ?? []).map((r) => [r.url, r.enabled === 1]));
  const labels = await readAddonLabels(db);
  let addons: Record<string, unknown>[] = urls.map((url, index) => ({
    url,
    enabled: enabledByUrl.get(url) !== false,
    position: index,
    name: labels[labelKey(id, url)] ?? "",
  }));
  if (cache && fetchImpl) {
    const described = await describeAddons(cache, fetchImpl, urls);
    const byUrl = new Map(described.map((d) => [normalizeAddonUrl(d.url), d]));
    addons = addons.map((addon) => {
      const meta = byUrl.get(normalizeAddonUrl(String(addon.url))) ?? {};
      const label = String(addon.name ?? "");
      const manifestName = typeof (meta as { manifestName?: unknown }).manifestName === "string" ? (meta as { manifestName: string }).manifestName : "";
      return { ...meta, ...addon, manifestName, name: label || manifestName };
    });
  }
  return {
    id,
    addonMode: profile.addon_mode,
    builtins: await builtinEntries(db),
    addons,
  };
}

function runtimeCache(): Cache | null {
  try {
    const stores = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
    return stores?.default ?? null;
  } catch {
    return null;
  }
}

function runtimeFetch(): typeof fetch | null {
  try {
    return typeof fetch === "function" ? fetch : null;
  } catch {
    return null;
  }
}

export function registerProfiles(app: Hono<{ Bindings: Env }>) {
  async function adminProfileId(c: Context<{ Bindings: Env }>): Promise<string | Response> {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "not found" }, 404);
    return id;
  }

  async function runNuvioSync(c: Context<{ Bindings: Env }>): Promise<{ ok: boolean; message: string }> {
    const syncRes = await syncFromNuvio(c.env.DB, runtimeFetch() ?? fetch, { force: true });
    await logApp(c.env.DB, { at: Math.floor(Date.now() / 1000), level: syncRes.ok ? "info" : "error", category: "sync",
      kind: "nuvio", profileId: "", message: syncRes.message, url: "" });
    if (syncRes.ok) {
      try {
        await syncHomeLibraries(c.env.DB, runtimeFetch() ?? fetch, runtimeCache());
      } catch {
        void 0;
      }
    }
    return syncRes;
  }

  app.get("/api/admin/profiles", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    let profiles = await listProfiles(c.env.DB);
    const missingAvatar = profiles.some((p) => p.nuvio_profile_id && !p.avatar_url);
    if (missingAvatar) {
      try {
        await syncFromNuvio(c.env.DB, runtimeFetch() ?? fetch);
        profiles = await listProfiles(c.env.DB);
      } catch {
        void 0;
      }
    }
    return c.json({ Profiles: profiles.map(adminDto) });
  });

  app.get("/api/admin/profiles/:id/addons", async (c) => {
    const id = await adminProfileId(c);
    if (id instanceof Response) return id;
    const body = await readAddons(c.env.DB, runtimeCache(), runtimeFetch(), id);
    if (!body) return c.json({ error: "not found" }, 404);
    return c.json(body);
  });

  app.get("/api/admin/profiles/:id/libraries", async (c) => {
    const id = await adminProfileId(c);
    if (id instanceof Response) return id;
    const body = await readProfileLibraries(c.env.DB, runtimeCache(), runtimeFetch() ?? fetch, id);
    if (!body) return c.json({ error: "not found" }, 404);
    return c.json(body);
  });

  app.put("/api/admin/profiles/:id/libraries", async (c) => {
    const id = await adminProfileId(c);
    if (id instanceof Response) return id;
    let body: { key?: string; enabled?: boolean; items?: { key: string; enabled: boolean }[] };
    try {
      body = (await c.req.json()) as { key?: string; enabled?: boolean; items?: { key: string; enabled: boolean }[] };
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const ok = await updateProfileLibraries(c.env.DB, id, body);
    if (!ok) return c.json({ error: "not found or update failed" }, 400);
    return c.json({ ok: true });
  });

  app.post("/api/admin/profiles/:id/password", async (c) => {
    const id = await adminProfileId(c);
    if (id instanceof Response) return id;
    let body: { password?: unknown };
    try {
      body = (await c.req.json()) as { password?: unknown };
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const result = await setProfilePassword(c.env.DB, id, body.password);
    return c.json(result.body, result.status);
  });

  app.get("/api/admin/nuvio/status", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    const account = await readNuvioAccount(c.env.DB);
    if (!account) return c.json({ connected: false });
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      connected: true,
      email: account.email,
      lastSync: account.last_sync,
      tokenStatus: account.expires_at && account.expires_at > now ? "valid" : "expired",
      expiresAt: account.expires_at,
    });
  });

  app.post("/api/admin/nuvio/login", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    const credentials = await readCredentials(c);
    if (credentials instanceof Response) return credentials;

    const signIn = await nuvioSignInAndSave(c.env.DB, runtimeFetch() ?? fetch, credentials.email, credentials.password);
    if (!signIn.ok) {
      await logApp(c.env.DB, { at: Math.floor(Date.now() / 1000), level: "error", category: "sync",
      kind: "nuvio", profileId: "", message: `login failed: ${signIn.error}`, url: "" });
      return c.json({ error: signIn.error }, 400);
    }

    const syncRes = await runNuvioSync(c);
    await writeSetting(c.env.DB, "admin_email", signIn.email.trim().toLowerCase());
    return c.json({ ok: true, email: signIn.email, sync: syncRes });
  });

  app.post("/api/admin/nuvio/sync", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    let profileId = c.req.query("profileId");
    try {
      const body = (await c.req.json()) as { profileId?: string };
      if (body?.profileId) profileId = body.profileId;
    } catch {
    }
    if (profileId) {
      const syncRes = await syncProfileFromNuvio(c.env.DB, runtimeFetch() ?? fetch, profileId);
      await logApp(c.env.DB, { at: Math.floor(Date.now() / 1000), level: syncRes.ok ? "info" : "error", category: "sync",
      kind: "nuvio", profileId: profileId ?? "", message: syncRes.message ?? "", url: "" });
      if (!syncRes.ok) {
        return c.json({ error: syncRes.message ?? "sync failed" }, 400);
      }
      return c.json(syncRes);
    }
    const syncRes = await runNuvioSync(c);
    if (!syncRes.ok) {
      return c.json({ error: syncRes.message }, 400);
    }
    return c.json(syncRes);
  });

  app.post("/api/admin/nuvio/disconnect", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    await removeNuvioAccount(c.env.DB);
    return c.json({ ok: true });
  });

}
