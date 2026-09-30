import type { D1Database, DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SCHEDULER?: DurableObjectNamespace;
  SELF?: Fetcher;
}

const SETTINGS_CACHE_TTL_SECONDS = 300;

const settingsCache = new WeakMap<D1Database, Map<string, { value: string | null; at: number }>>();

export async function profileCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM profiles").first<{ total: number }>();
  return row?.total ?? 0;
}

export async function readSetting(db: D1Database, key: string): Promise<string | null> {
  let cache = settingsCache.get(db);
  if (!cache) {
    cache = new Map<string, { value: string | null; at: number }>();
    settingsCache.set(db, cache);
  }
  const now = Date.now() / 1000;
  const cached = cache.get(key);
  if (cached && now - cached.at < SETTINGS_CACHE_TTL_SECONDS) {
    return cached.value ?? null;
  }
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  const val = row?.value ?? null;
  cache.set(key, { value: val, at: now });
  return val;
}

export async function writeSetting(db: D1Database, key: string, value: string): Promise<void> {
  let cache = settingsCache.get(db);
  if (!cache) {
    cache = new Map<string, { value: string | null; at: number }>();
    settingsCache.set(db, cache);
  }
  cache.set(key, { value, at: Date.now() / 1000 });
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  const cache = settingsCache.get(db);
  if (cache) cache.delete(key);
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}
