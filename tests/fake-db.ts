import { ADMIN_CLIENT_JS } from "../src/ui/admin-client";
import { ADMIN_CSS } from "../src/ui/admin-css";
import { REMUX_THEME_CSS } from "../src/ui/remux-css";
import type { createApp } from "../src/index";
import type { Profile } from "../src/session";

interface ProfileRow extends Profile {
  token_epoch?: number;
}

interface RateRow {
  window_start: number;
  count: number;
}

interface AddonRow {
  profile_id: string;
  url: string;
  position: number;
  enabled: number;
}

interface FavoriteRow {
  profile_id: string;
  item_key: string;
  content_id: string;
  content_type: string;
  name: string;
  poster: string | null;
  added_at: number;
}

export function createFakeDb() {
  const profiles: ProfileRow[] = [];
  const rates = new Map<string, RateRow>();
  const settings = new Map<string, string>();
  const addons: AddonRow[] = [];
  const watch = new Map<string, { positionTicks: number; played: number; playCount: number; updatedAt: number }>();
  const quickConnect = new Map<string, { code: string; secret: string; profile_id: string | null; device_name: string; device_id: string; client_name: string; client_version: string; authenticated: number; created_at: number; expires_at: number }>();
  const health = new Map<string, { fails: number; lastError: string; updatedAt: number }>();
  const favorites = new Map<string, FavoriteRow>();
  const hidden = new Map<string, { profileId: string; itemKey: string; createdAt: number }>();
  const tombstones = new Map<string, { profileId: string; kind: string; itemKey: string; deletedAt: number }>();
  const counts = { reads: 0, writes: 0 };
  const prefs = new Map<string, string>();
  const appLog: { id: number; at: number; level: string; category: string; kind: string; profileId: string; message: string; url: string }[] = [];
  let appLogSeq = 1;

  function watchKey(profileId: unknown, itemKey: unknown): string {
    return `${String(profileId)}\n${String(itemKey)}`;
  }

  function favKey(profileId: unknown, itemKey: unknown): string {
    return `${String(profileId)}\n${String(itemKey)}`;
  }

  function healthRow(key: string, entry: { fails: number; lastError: string; updatedAt: number }) {
    const split = key.indexOf("\n");
    return {
      profileId: key.slice(0, split),
      addonUrl: key.slice(split + 1),
      fails: entry.fails,
      lastError: entry.lastError,
      updatedAt: entry.updatedAt,
    };
  }

  function profileRowArgs(params: unknown[], hasAvatar: boolean): Parameters<typeof newProfileRow>[0] {
    return {
      id: params[0] as string,
      name: params[1] as string,
      isAdmin: params[2] as number,
      createdAt: params[3] as number,
      nuvioProfileId: params[4] as string,
      nuvioProfileIndex: params[5] as number,
      avatarColorHex: params[6] as string,
      ...(hasAvatar ? { avatarUrl: params[7] as string | null } : {}),
      usesPrimaryAddons: (hasAvatar ? params[8] : params[7]) as number,
    };
  }

  function newProfileRow(args: {
    id: string;
    name: string;
    isAdmin: number;
    createdAt: number;
    nuvioProfileId: string;
    nuvioProfileIndex: number;
    avatarColorHex: string;
    usesPrimaryAddons: number;
    avatarUrl?: string | null;
  }): ProfileRow {
    const row: ProfileRow = {
      id: args.id,
      name: args.name,
      password_hash: "",
      salt: "",
      is_admin: args.isAdmin,
      addon_mode: "custom",
      disabled: 0,
      created_at: args.createdAt,
      nuvio_profile_id: args.nuvioProfileId,
      nuvio_profile_index: args.nuvioProfileIndex,
      avatar_color_hex: args.avatarColorHex,
      uses_primary_addons: args.usesPrimaryAddons,
      token_epoch: 0,
    };
    if (args.avatarUrl !== undefined) row.avatar_url = args.avatarUrl;
    return row;
  }

  function profileByName(name: unknown): ProfileRow | null {
    return profiles.find((p) => p.name === name) ?? null;
  }

  function profileById(id: unknown): ProfileRow | null {
    return profiles.find((p) => p.id === id) ?? null;
  }

  function statement(sql: string, params: unknown[]) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      async first<T>(): Promise<T | null> {
        counts.reads += 1;
        if (normalized.startsWith("SELECT COUNT(*) AS total FROM profiles")) {
          return { total: profiles.length } as T;
        }
        if (normalized.startsWith("SELECT window_start, count FROM rate_limits")) {
          return (rates.get(params[0] as string) as T | undefined) ?? null;
        }
        if (normalized.startsWith("SELECT value FROM settings")) {
          const literal = /FROM settings WHERE key = '([^']+)'/.exec(normalized);
          const value = literal ? settings.get(literal[1] as string) : settings.get(String(params[0] ?? "server_secret"));
          return (value === undefined ? null : { value }) as T | null;
        }
        if (normalized.startsWith("SELECT position_ticks AS positionTicks")) {
          const entry = watch.get(watchKey(params[0], params[1]));
          return ((entry ? { positionTicks: entry.positionTicks, played: entry.played, playCount: entry.playCount } : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT position_ticks, played, play_count FROM watch_state")) {
          const entry = watch.get(watchKey(params[0], params[1]));
          return ((entry ? { position_ticks: entry.positionTicks, played: entry.played, play_count: entry.playCount } : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT 1 FROM profile_favorites")) {
          const entry = favorites.get(favKey(params[0], params[1]));
          return (entry ? { 1: 1 } : null) as T | null;
        }
        if (normalized.startsWith("SELECT 1 AS hit FROM hidden_items")) {
          const entry = hidden.get(watchKey(params[0], params[1]));
          return (entry ? { hit: 1 } : null) as T | null;
        }
        if (normalized.startsWith("SELECT nuvio_profile_index FROM profiles")) {
          const p = profileById(params[0]);
          return (p ? { nuvio_profile_index: p.nuvio_profile_index ?? null } : null) as T | null;
        }
        if (normalized.startsWith("SELECT data FROM display_prefs WHERE user_id = ?1 AND client = ?2 AND pref_id = ?3")) {
          const entry = prefs.get(`${String(params[0])}\n${String(params[1])}\n${String(params[2])}`);
          return ((entry ? { data: entry } : null) as T | null) ?? null;
        }
        if (normalized === "SELECT id FROM profiles LIMIT 1") {
          const firstProfile = [...profiles].sort((a, b) => a.created_at - b.created_at)[0];
          return ((firstProfile ? { id: firstProfile.id } : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT nuvio_profile_index AS nuvioIndex FROM profiles WHERE id = ?")) {
          const row = profileById(params[0]);
          return (((row ? { nuvioIndex: row.nuvio_profile_index ?? null } : null) as T | null) ?? null);
        }
        if (normalized.startsWith("SELECT updated_at AS updatedAt, played, position_ticks AS positionTicks FROM watch_state WHERE profile_id = ?1 AND item_key = ?2")) {
          const entry = watch.get(watchKey(params[0], params[1]));
          return ((entry ? { updatedAt: entry.updatedAt, played: entry.played, positionTicks: entry.positionTicks } : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT updated_at AS updatedAt, played FROM watch_state WHERE profile_id = ?1 AND item_key = ?2")) {
          const entry = watch.get(watchKey(params[0], params[1]));
          return ((entry ? { updatedAt: entry.updatedAt, played: entry.played } : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT updated_at AS updatedAt FROM watch_state WHERE profile_id = ?1 AND item_key = ?2")) {
          const entry = watch.get(watchKey(params[0], params[1]));
          return ((entry ? { updatedAt: entry.updatedAt } : null) as T | null) ?? null;
        }
        if (normalized.includes("FROM profiles WHERE name = ?")) {
          return (profileByName(params[0]) as T | null) ?? null;
        }
        if (normalized.includes("FROM profiles WHERE id = ?")) {
          return (profileById(params[0]) as T | null) ?? null;
        }
        if (normalized.includes("FROM profiles WHERE nuvio_profile_id = ?")) {
          const found = [...profiles].find((p) => (p as any).nuvio_profile_id === params[0]);
          return ((found ? { id: found.id } : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT code FROM quick_connect WHERE code = ?1 AND expires_at >= ?2")) {
          const row = [...quickConnect.values()].find((q) => q.code === String(params[0]) && q.expires_at >= (params[1] as number));
          return ((row ? { code: row.code } : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT code, secret, profile_id, device_name, device_id, client_name, client_version, authenticated, created_at, expires_at FROM quick_connect WHERE secret = ?1 AND expires_at >= ?2")) {
          const row = quickConnect.get(String(params[0]));
          return ((row && row.expires_at >= (params[1] as number) ? row : null) as T | null) ?? null;
        }
        if (normalized.startsWith("SELECT profile_id FROM quick_connect WHERE secret = ?1 AND authenticated = 1 AND expires_at >= ?2")) {
          const row = quickConnect.get(String(params[0]));
          return ((row && row.authenticated === 1 && row.expires_at >= (params[1] as number) ? { profile_id: row.profile_id } : null) as T | null) ?? null;
        }
        if (normalized.includes("FROM profiles WHERE is_admin = 1")) {
          const admin = [...profiles].filter((p) => p.is_admin === 1).sort((a, b) => a.created_at - b.created_at)[0];
          return ((admin ? { ...admin, nuvio_profile_id: admin.nuvio_profile_id ?? null, nuvio_profile_index: admin.nuvio_profile_index ?? null } : null) as T | null) ?? null;
        }
        throw new Error(`unhandled first: ${normalized}`);
      },
      async run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        counts.writes += 1;
        if (/^(CREATE TABLE|CREATE INDEX|PRAGMA|ALTER TABLE)/.test(normalized)) {
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO rate_limits")) {
          rates.set(params[0] as string, { window_start: params[1] as number, count: 1 });
          return { success: true };
        }
        if (normalized.startsWith("UPDATE rate_limits SET count")) {
          const row = rates.get(params[0] as string);
          if (row) row.count += 1;
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO profiles")) {
          if (normalized.includes("password_hash, salt, is_admin, addon_mode, nuvio_profile_id")) {
            profiles.push({
              id: params[0] as string,
              name: params[1] as string,
              password_hash: params[2] as string,
              salt: params[3] as string,
              is_admin: 1,
              addon_mode: "custom",
              disabled: 0,
              nuvio_profile_id: (params[4] as string | null) ?? null,
              nuvio_profile_index: (params[5] as number) ?? 0,
              avatar_color_hex: (params[6] as string) ?? "#7c5cff",
              avatar_url: (params[7] as string | null) ?? null,
              created_at: params[8] as number,
              token_epoch: 0,
            });
            return { success: true };
          }
          if (params.length >= 9) {
            profiles.push(newProfileRow(profileRowArgs(params, true)));
            return { success: true };
          }
          if (params.length === 8) {
            profiles.push(newProfileRow(profileRowArgs(params, false)));
            return { success: true };
          }
          if (params.length === 6) {
            profiles.push({
              id: params[0] as string,
              name: params[1] as string,
              password_hash: params[2] as string,
              salt: params[3] as string,
              is_admin: 0,
              addon_mode: params[4] as string,
              disabled: 0,
              created_at: params[5] as number,
              token_epoch: 0,
            });
            return { success: true };
          }
          profiles.push({
            id: params[0] as string,
            name: params[1] as string,
            password_hash: params[2] as string,
            salt: params[3] as string,
            is_admin: 1,
            addon_mode: "custom",
            disabled: 0,
            created_at: params[4] as number,
            token_epoch: 0,
          });
          return { success: true };
        }
        if (normalized.startsWith("INSERT OR IGNORE INTO settings")) {
          const match = /VALUES \('([^']+)'/.exec(normalized);
          const key = match?.[1] ?? "server_secret";
          if (!settings.has(key)) settings.set(key, params[0] as string);
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO settings (key, value)")) {
          const match = /VALUES \('([^']+)', \?\)/.exec(normalized);
          if (match && match[1]) {
            settings.set(match[1], params[0] as string);
          } else {
            settings.set(params[0] as string, params[1] as string);
          }
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO watch_state")) {
          const key = watchKey(params[0], params[1]);
          const entry = watch.get(key) ?? { positionTicks: 0, played: 0, playCount: 0, updatedAt: 0 };
          let stamp = params[params.length - 1] as number;
          if (normalized.includes("position_ticks = CASE WHEN excluded.updated_at >= watch_state.updated_at")) {
            entry.positionTicks = params[2] as number;
            entry.played = params[3] as number;
            entry.playCount = params[4] as number;
            stamp = params[5] as number;
          } else if (normalized.includes("played = 1")) {
            entry.played = 1;
            entry.playCount = Math.max(entry.playCount, 1);
          } else if (normalized.includes("play_count = play_count + 1") || normalized.includes("watch_state.play_count + 1")) {
            entry.playCount += 1;
            stamp = params[2] as number;
          } else if (normalized.includes("SET played = excluded.played")) {
            entry.played = params[2] as number;
            stamp = params[3] as number;
          } else {
            entry.positionTicks = params[2] as number;
            if (normalized.includes("WHEN excluded.position_ticks > 0 THEN 0") && (params[2] as number) > 0) {
              entry.played = 0;
            }
            stamp = params[3] as number;
          }
          entry.updatedAt = stamp;
          watch.set(key, entry);
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO profile_favorites") || normalized.startsWith("INSERT OR REPLACE INTO profile_favorites")) {
          const key = favKey(params[0], params[1]);
          favorites.set(key, {
            profile_id: params[0] as string,
            item_key: params[1] as string,
            content_id: params[2] as string,
            content_type: params[3] as string,
            name: (params[4] as string) ?? "",
            poster: (params[5] as string) ?? null,
            added_at: (params[6] as number) ?? Date.now(),
          });
          return { success: true };
        }
        if (normalized.startsWith("DELETE FROM profile_favorites WHERE profile_id = ? AND item_key = ?")) {
          favorites.delete(favKey(params[0], params[1]));
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET name = ?, nuvio_profile_id = ?")) {
          const id = params[params.length - 1];
          const row = profileById(id);
          if (row) {
            row.name = params[0] as string;
            row.nuvio_profile_id = params[1] as string;
            row.nuvio_profile_index = params[2] as number;
            row.avatar_color_hex = params[3] as string;
            if (params.length >= 7) {
              row.avatar_url = params[4] as string | null;
              row.uses_primary_addons = params[5] as number;
            } else {
              row.uses_primary_addons = params[4] as number;
            }
            row.disabled = 0;
          }
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET name = ? WHERE id = ?")) {
          const row = profileById(params[1]);
          if (row) row.name = params[0] as string;
          return { success: true };
        }
        if ((normalized.startsWith("UPDATE profiles SET password_hash = ?, salt = ?, token_epoch = token_epoch + 1 WHERE id = ?"))) {
          const row = profileById(params[2]);
          if (row) {
            row.password_hash = params[0] as string;
            row.salt = params[1] as string;
            row.token_epoch = (row.token_epoch ?? 0) + 1;
          }
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET password_hash = ?, salt = ? WHERE id = ?")) {
          const row = profileById(params[2]);
          if (row) {
            row.password_hash = params[0] as string;
            row.salt = params[1] as string;
          }
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET token_epoch = token_epoch + 1 WHERE id = ?")) {
          const row = profileById(params[0]);
          if (row) row.token_epoch = (row.token_epoch ?? 0) + 1;
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET disabled = ?, token_epoch = token_epoch + 1 WHERE id = ?")) {
          const row = profileById(params[1]);
          if (row) {
            row.disabled = params[0] as number;
            row.token_epoch = (row.token_epoch ?? 0) + 1;
          }
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET disabled = ? WHERE id = ?")) {
          const row = profileById(params[1]);
          if (row) row.disabled = params[0] as number;
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET addon_mode = ? WHERE id = ?")) {
          const row = profileById(params[1]);
          if (row) row.addon_mode = params[0] as string;
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles SET nuvio_profile_id = ?, nuvio_profile_index = ? WHERE id = ?")) {
          const row = profileById(params[2]);
          if (row) {
            row.nuvio_profile_id = params[0] as string;
            row.nuvio_profile_index = params[1] as number;
          }
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO hidden_items")) {
          hidden.set(watchKey(params[0], params[1]), {
            profileId: String(params[0]),
            itemKey: String(params[1]),
            createdAt: params[2] as number,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (normalized.startsWith("DELETE FROM hidden_items WHERE profile_id = ?1 AND item_key = ?2")) {
          hidden.delete(watchKey(params[0], params[1]));
          return { success: true, meta: { changes: 1 } };
        }
        if (normalized.startsWith("INSERT INTO sync_tombstones")) {
          tombstones.set(`${String(params[0])}\n${String(params[1])}\n${String(params[2])}`, {
            profileId: String(params[0]),
            kind: String(params[1]),
            itemKey: String(params[2]),
            deletedAt: params[3] as number,
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (normalized.startsWith("DELETE FROM sync_tombstones WHERE profile_id = ?1 AND kind = ?2 AND item_key = ?3")) {
          tombstones.delete(`${String(params[0])}\n${String(params[1])}\n${String(params[2])}`);
          return { success: true, meta: { changes: 1 } };
        }
        if (normalized.startsWith("DELETE FROM sync_tombstones WHERE deleted_at < ?1")) {
          let changes = 0;
          for (const [key, entry] of [...tombstones.entries()]) {
            if (entry.deletedAt < (params[0] as number)) {
              tombstones.delete(key);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("DELETE FROM profile_favorites WHERE profile_id = ?1 AND item_key = ?2")) {
          favorites.delete(favKey(params[0], params[1]));
          return { success: true, meta: { changes: 1 } };
        }
        if (normalized.startsWith("DELETE FROM settings WHERE key = ?")) {
          settings.delete(params[0] as string);
          return { success: true, meta: { changes: 1 } };
        }
        if (normalized.startsWith("DELETE FROM profiles WHERE id = ?")) {
          const idx = profiles.findIndex((p) => p.id === params[0]);
          if (idx >= 0) profiles.splice(idx, 1);
          for (let i = addons.length - 1; i >= 0; i -= 1) {
            if (addons[i]?.profile_id === params[0]) addons.splice(i, 1);
          }
          for (const key of [...watch.keys()]) {
            if (key.startsWith(`${String(params[0])}\n`)) watch.delete(key);
          }
          for (const key of [...favorites.keys()]) {
            if (key.startsWith(`${String(params[0])}\n`)) favorites.delete(key);
          }
          for (const key of [...hidden.keys()]) {
            if (key.startsWith(`${String(params[0])}\n`)) hidden.delete(key);
          }
          for (const [key, entry] of [...tombstones.entries()]) {
            if (entry.profileId === String(params[0])) tombstones.delete(key);
          }
          for (const key of [...health.keys()]) {
            if (key.startsWith(`${String(params[0])}\n`)) health.delete(key);
          }
          return { success: true };
        }
        if (normalized.startsWith("DELETE FROM profile_addons WHERE profile_id = ?")) {
          for (let i = addons.length - 1; i >= 0; i -= 1) {
            if (addons[i]?.profile_id === params[0]) addons.splice(i, 1);
          }
          return { success: true };
        }
        if (normalized.startsWith("INSERT OR REPLACE INTO profiles")) {
          const existing = profileById(params[0]);
          const row: ProfileRow = {
            id: params[0] as string,
            name: params[1] as string,
            password_hash: params[2] as string,
            salt: params[3] as string,
            is_admin: params[4] as number,
            addon_mode: params[5] as string,
            disabled: params[6] as number,
            created_at: params[7] as number,
          };
          if (existing) Object.assign(existing, row);
          else profiles.push(row);
          return { success: true };
        }
        if (normalized.startsWith("INSERT OR REPLACE INTO profile_addons")) {
          const idx = addons.findIndex((a) => a.profile_id === params[0] && a.url === params[1]);
          const row = { profile_id: params[0] as string, url: params[1] as string, position: params[2] as number, enabled: params[3] as number };
          if (idx >= 0) addons[idx] = row;
          else addons.push(row);
          return { success: true };
        }
        if (normalized.startsWith("INSERT OR REPLACE INTO watch_state")) {
          watch.set(`${String(params[0])}\n${String(params[1])}`, {
            positionTicks: params[2] as number,
            played: params[3] as number,
            playCount: params[4] as number,
            updatedAt: params[5] as number,
          });
          return { success: true };
        }
        if (normalized.startsWith("INSERT OR REPLACE INTO addon_health")) {
          health.set(`${String(params[0])}\n${String(params[1])}`, {
            fails: params[2] as number,
            lastError: params[3] as string,
            updatedAt: params[4] as number,
          });
          return { success: true };
        }
        if (normalized.startsWith("INSERT OR REPLACE INTO settings")) {
          settings.set(params[0] as string, params[1] as string);
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO display_prefs")) {
          prefs.set(`${String(params[0])}\n${String(params[1])}\n${String(params[2])}`, params[3] as string);
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO addon_health")) {
          const key = `${String(params[0])}\n${String(params[1])}`;
          const entry = health.get(key) ?? { fails: 0, lastError: "", updatedAt: 0 };
          entry.fails += 1;
          entry.lastError = params[2] as string;
          entry.updatedAt = params[3] as number;
          health.set(key, entry);
          return { success: true };
        }
        if (normalized.startsWith("DELETE FROM addon_health WHERE profile_id = ?1 AND addon_url = ?2")) {
          health.delete(`${String(params[0])}\n${String(params[1])}`);
          return { success: true };
        }
        if (normalized.startsWith("INSERT INTO app_log")) {
          appLog.push({
            id: appLogSeq++,
            at: params[0] as number,
            level: String(params[1] ?? ""),
            category: String(params[2] ?? ""),
            kind: String(params[3] ?? ""),
            profileId: String(params[4] ?? ""),
            message: String(params[5] ?? ""),
            url: String(params[6] ?? ""),
          });
          return { success: true };
        }
        if (normalized.startsWith("DELETE FROM app_log WHERE id NOT IN")) {
          const keep = new Set(
            [...appLog]
              .sort((a, b) => b.id - a.id)
              .slice(0, Number(params[0] ?? 100))
              .map((row) => row.id),
          );
          let changes = 0;
          for (let i = appLog.length - 1; i >= 0; i -= 1) {
            if (!keep.has(appLog[i]?.id ?? -1)) {
              appLog.splice(i, 1);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("DELETE FROM app_log WHERE at < ?")) {
          let changes = 0;
          for (let i = appLog.length - 1; i >= 0; i -= 1) {
            if ((appLog[i]?.at ?? 0) < (params[0] as number)) {
              appLog.splice(i, 1);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (normalized === "DELETE FROM app_log") {
          const changes = appLog.length;
          appLog.length = 0;
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("INSERT INTO quick_connect")) {
          quickConnect.set(String(params[1]), {
            code: String(params[0]),
            secret: String(params[1]),
            profile_id: null,
            device_name: String(params[2] ?? ""),
            device_id: String(params[3] ?? ""),
            client_name: String(params[4] ?? ""),
            client_version: String(params[5] ?? ""),
            authenticated: 0,
            created_at: Number(params[6] ?? 0),
            expires_at: Number(params[7] ?? 0),
          });
          return { success: true };
        }
        if (normalized.startsWith("UPDATE quick_connect SET authenticated = 1, profile_id = ?1 WHERE code = ?2 AND expires_at >= ?3")) {
          let changes = 0;
          for (const row of quickConnect.values()) {
            if (row.code === String(params[1]) && row.expires_at >= (params[2] as number)) {
              row.authenticated = 1;
              row.profile_id = String(params[0]);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("DELETE FROM quick_connect WHERE secret = ?1")) {
          const changes = quickConnect.delete(String(params[0])) ? 1 : 0;
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("DELETE FROM quick_connect WHERE expires_at < ?1")) {
          let changes = 0;
          for (const [key, row] of [...quickConnect.entries()]) {
            if (row.expires_at < (params[0] as number)) {
              quickConnect.delete(key);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("DELETE FROM rate_limits WHERE window_start < ?1")) {
          let changes = 0;
          for (const [key, row] of [...rates.entries()]) {
            if (row.window_start < (params[0] as number)) {
              rates.delete(key);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("DELETE FROM addon_health WHERE updated_at < ?1")) {
          let changes = 0;
          for (const [key, row] of [...health.entries()]) {
            if (row.updatedAt < (params[0] as number)) {
              health.delete(key);
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        if (normalized.startsWith("INSERT INTO profile_addons")) {
          addons.push({
            profile_id: params[0] as string,
            url: params[1] as string,
            position: params[2] as number,
            enabled: params[3] as number,
          });
          return { success: true };
        }
        if (normalized.startsWith("UPDATE profiles")) {
          const profile = profileById(params[params.length - 1]);
          if (profile) {
            if (normalized.includes("nuvio_profile_index = 0")) profile.nuvio_profile_index = 0;
            if (normalized.includes("avatar_url = ?")) profile.avatar_url = params[0] as string;
            if (normalized.includes("avatar_color_hex = ?")) profile.avatar_color_hex = params[0] as string;
            if (normalized.includes("password_hash = ''")) {
              profile.password_hash = "";
              profile.salt = "";
            }
          }
          return { success: true };
        }
        if (normalized.startsWith("DELETE FROM settings WHERE key =")) { settings.delete(params[0] ? String(params[0]) : "nuvio_account"); return { success: true }; }
        if (normalized.startsWith("DROP TABLE IF EXISTS")) return { success: true };
        throw new Error(`unhandled run: ${normalized}`);
      },
      async all<T>(): Promise<{ results: T[] }> {
        counts.reads += 1;
        if (normalized.startsWith("SELECT key, value FROM settings WHERE key IN (")) {
          const rows = [...settings.entries()]
            .filter(([key]) => (params as unknown[]).includes(key))
            .map(([key, value]) => ({ key, value }));
          return { results: rows as T[] };
        }
        if (normalized.includes("FROM watch_state WHERE profile_id = ?1 ORDER BY updated_at DESC") || normalized.includes("FROM watch_state WHERE profile_id = ?")) {
          const rows = [...watch.entries()]
            .filter(([key]) => key.startsWith(`${String(params[0])}\n`))
            .map(([key, entry]) => ({
              itemKey: key.slice(String(params[0]).length + 1),
              item_key: key.slice(String(params[0]).length + 1),
              positionTicks: entry.positionTicks,
              position_ticks: entry.positionTicks,
              played: entry.played,
              playCount: entry.playCount,
              play_count: entry.playCount,
              updatedAt: entry.updatedAt,
              updated_at: entry.updatedAt,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return { results: rows as T[] };
        }
        if (normalized.startsWith("SELECT item_key AS itemKey FROM hidden_items WHERE profile_id = ?1")) {
          const rows = [...hidden.values()]
            .filter((entry) => entry.profileId === String(params[0]))
            .map((entry) => ({ itemKey: entry.itemKey }));
          return { results: rows as T[] };
        }
        if (normalized.startsWith("SELECT item_key AS itemKey, deleted_at AS deletedAt FROM sync_tombstones WHERE profile_id = ?1 AND kind = ?2")) {
          const rows = [...tombstones.values()]
            .filter((entry) => entry.profileId === String(params[0]) && entry.kind === String(params[1]))
            .map((entry) => ({ itemKey: entry.itemKey, deletedAt: entry.deletedAt }));
          return { results: rows as T[] };
        }
        if (normalized.startsWith("SELECT item_key AS itemKey, added_at AS addedAt FROM profile_favorites WHERE profile_id = ?1")) {
          const rows = [...favorites.values()]
            .filter((entry) => entry.profile_id === String(params[0]))
            .map((entry) => ({ itemKey: entry.item_key, addedAt: entry.added_at }));
          return { results: rows as T[] };
        }
        if (normalized.startsWith("SELECT item_key FROM profile_favorites WHERE profile_id = ?")) {
          const rows = [...favorites.values()]
            .filter((f) => f.profile_id === params[0])
            .map((f) => ({ item_key: f.item_key }));
          return { results: rows as T[] };
        }
        if (normalized.startsWith("SELECT item_key, content_id, content_type, name, poster FROM profile_favorites WHERE profile_id = ?")) {
          const rows = [...favorites.values()]
            .filter((f) => f.profile_id === params[0])
            .map((f) => ({
              item_key: f.item_key,
              content_id: f.content_id,
              content_type: f.content_type,
              name: f.name,
              poster: f.poster,
            }));
          return { results: rows as T[] };
        }
        if (normalized.startsWith("SELECT profile_id, item_key, content_id, content_type, name, poster, added_at FROM profile_favorites")) {
          const rows = [...favorites.values()].map((f) => ({
            profile_id: f.profile_id,
            item_key: f.item_key,
            content_id: f.content_id,
            content_type: f.content_type,
            name: f.name,
            poster: f.poster,
            added_at: f.added_at,
          }));
          return { results: rows as T[] };
        }
        if (normalized.includes("FROM addon_health WHERE fails >= ?")) {
          const rows = [...health.entries()]
            .filter(([, entry]) => entry.fails >= (params[0] as number))
            .map(([key, entry]) => healthRow(key, entry));
          return { results: rows as T[] };
        }
        if (normalized.includes("FROM app_log") && normalized.includes("ORDER BY id DESC LIMIT")) {
          const isCategory = normalized.includes("WHERE category = ?");
          const isKind = normalized.includes("WHERE kind = ?");
          const isLevel = normalized.includes("WHERE level = ?");
          const filtered = isCategory || isKind || isLevel;
          const filter = filtered ? String(params[0] ?? "") : "";
          const limit = Number(params[filtered ? 1 : 0] ?? 50);
          const rows = [...appLog]
            .sort((a, b) => b.id - a.id)
            .filter((row) =>
              !filter ||
              (isCategory ? row.category === filter : isKind ? row.kind === filter : row.level === filter),
            )
            .slice(0, limit)
            .map((row) => ({
              at: row.at,
              level: row.level,
              category: row.category,
              kind: row.kind,
              profileId: row.profileId,
              message: row.message,
              url: row.url,
            }));
          return { results: rows as T[] };
        }
        if (normalized.includes("FROM watch_state w LEFT JOIN profiles p")) {
          const rows = [...watch.entries()]
            .map(([key, entry]) => {
              const split = key.indexOf("\n");
              const profileId = key.slice(0, split);
              const profile = profileById(profileId);
              return {
                profileId,
                profileName: profile?.name ?? null,
                itemKey: key.slice(split + 1),
                updatedAt: entry.updatedAt,
              };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 10);
          return { results: rows as T[] };
        }
        if (normalized.includes("FROM addon_health ORDER BY updated_at DESC")) {
          const rows = [...health.entries()]
            .map(([key, entry]) => healthRow(key, entry))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return { results: rows as T[] };
        }
        if (normalized.startsWith("SELECT id, name, nuvio_profile_id, nuvio_profile_index, is_admin FROM profiles")) {
          return {
            results: profiles.map((p) => ({
              id: p.id,
              name: p.name,
              nuvio_profile_id: p.nuvio_profile_id ?? null,
              nuvio_profile_index: p.nuvio_profile_index ?? null,
              is_admin: p.is_admin,
            })) as T[],
          };
        }
        if (normalized.includes("FROM profiles ORDER BY created_at ASC")) {
          if (normalized.startsWith("SELECT id, name, password_hash")) {
            const rows = [...profiles]
              .sort((a, b) => a.created_at - b.created_at)
              .map((p) => ({
                id: p.id,
                name: p.name,
                password_hash: p.password_hash,
                salt: p.salt,
                is_admin: p.is_admin,
                addon_mode: p.addon_mode,
                disabled: p.disabled ?? 0,
                created_at: p.created_at,
                nuvio_profile_id: p.nuvio_profile_id ?? null,
                nuvio_profile_index: p.nuvio_profile_index ?? null,
                avatar_color_hex: p.avatar_color_hex ?? null,
                avatar_url: p.avatar_url ?? null,
                uses_primary_addons: p.uses_primary_addons ?? 0,
              }));
            return { results: rows as T[] };
          }
          return { results: [...profiles].sort((a, b) => a.created_at - b.created_at) as T[] };
        }
        if (normalized === "SELECT profile_id, url, position, enabled FROM profile_addons ORDER BY profile_id ASC, position ASC") {
          const rows = [...addons]
            .sort((a, b) => (a.profile_id < b.profile_id ? -1 : 1) || a.position - b.position)
            .map((a) => ({ profile_id: a.profile_id, url: a.url, position: a.position, enabled: a.enabled }));
          return { results: rows as T[] };
        }
        if (normalized === "SELECT profile_id, item_key, position_ticks, played, play_count, updated_at FROM watch_state") {
          const rows = [...watch.entries()].map(([key, entry]) => {
            const split = key.indexOf("\n");
            return {
              profile_id: key.slice(0, split),
              item_key: key.slice(split + 1),
              position_ticks: entry.positionTicks,
              played: entry.played,
              play_count: entry.playCount,
              updated_at: entry.updatedAt,
            };
          });
          return { results: rows as T[] };
        }
        if (normalized === "SELECT profile_id, addon_url, fails, last_error, updated_at FROM addon_health") {
          const rows = [...health.entries()].map(([key, entry]) => {
            const split = key.indexOf("\n");
            return {
              profile_id: key.slice(0, split),
              addon_url: key.slice(split + 1),
              fails: entry.fails,
              last_error: entry.lastError,
              updated_at: entry.updatedAt,
            };
          });
          return { results: rows as T[] };
        }
        if (normalized === "SELECT key, value FROM settings") {
          const rows = [...settings.entries()].map(([key, value]) => ({ key, value }));
          return { results: rows as T[] };
        }
        if (normalized === "SELECT nuvio_profile_index FROM profiles" && normalized.endsWith("FROM profiles")) {
          const rows = profiles.map((p) => ({ nuvio_profile_index: p.nuvio_profile_index ?? null }));
          return { results: rows as T[] };
        }
        if (normalized === "SELECT DISTINCT url FROM profile_addons") {
          const rows = [...new Set(addons.map((a) => a.url))].map((url) => ({ url }));
          return { results: rows as T[] };
        }
        if (normalized.includes("FROM profile_addons WHERE profile_id = ?")) {
          const enabledOnly = normalized.includes("AND enabled = 1");
          const rows = addons
            .filter((a) => a.profile_id === params[0] && (!enabledOnly || a.enabled === 1))
            .sort((a, b) => a.position - b.position)
            .map((a) => ({ url: a.url, position: a.position, enabled: a.enabled }));
          return { results: rows as T[] };
        }
        return { results: [] };
      },
    };
  }

  const db = {
    prepare(sql: string) {
      return {
        ...statement(sql, []),
        bind(...params: unknown[]) {
          return statement(sql, params);
        },
      };
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
    async batch(statements: { run: () => Promise<unknown> }[]) {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
    profiles,
    rates,
    addons,
    watch,
    health,
    favorites,
    counts,
    settings,
  };
  return db;
}

export type FakeDb = ReturnType<typeof createFakeDb>;

export function testEnv(db: FakeDb) {
  return {
    DB: db as unknown as import("@cloudflare/workers-types").D1Database,
    ASSETS: {
      fetch: async (req: Request | string) => {
        const url = typeof req === "string" ? req : req.url;
        const path = new URL(url).pathname;
        if (path === "/admin.js") {
          return new Response(ADMIN_CLIENT_JS, {
            headers: { "Content-Type": "application/javascript; charset=utf-8" },
          });
        }
        if (path === "/admin.css") {
          return new Response(ADMIN_CSS, {
            headers: { "Content-Type": "text/css; charset=utf-8" },
          });
        }
        if (path === "/remux-theme.css") {
          return new Response(REMUX_THEME_CSS, {
            headers: { "Content-Type": "text/css; charset=utf-8" },
          });
        }
        return new Response("asset");
      },
    } as unknown as import("@cloudflare/workers-types").Fetcher,
  };
}

export function callApp(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof testEnv>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, init), env));
}
