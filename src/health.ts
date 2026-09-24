import type { Hono } from "hono";
import type { Env } from "./db";
import { adminOwner } from "./session";

export type AddonNotify = (ok: boolean, error: string, latencyMs?: number) => Promise<void>;

export async function recordAddonResult(
  db: D1Database,
  profileId: string,
  addonUrl: string,
  ok: boolean,
  error: string,
  now: number,
  latencyMs = 0,
): Promise<void> {
  try {
    if (ok) {
      await db
        .prepare("DELETE FROM addon_health WHERE profile_id = ?1 AND addon_url = ?2")
        .bind(profileId, addonUrl)
        .run();
      return;
    }
    await db
      .prepare(
        "INSERT INTO addon_health (profile_id, addon_url, fails, last_error, updated_at, latency_ms) VALUES (?1, ?2, 1, ?3, ?4, ?5) ON CONFLICT (profile_id, addon_url) DO UPDATE SET fails = fails + 1, last_error = excluded.last_error, updated_at = excluded.updated_at, latency_ms = excluded.latency_ms",
      )
      .bind(profileId, addonUrl, error.slice(0, 200), now, latencyMs)
      .run();
  } catch {
    void 0;
  }
}

export function notifyFor(db: D1Database, profileId: string, addonUrl: string, now: number): AddonNotify {
  return (ok, error, latencyMs = 0) => recordAddonResult(db, profileId, addonUrl, ok, error, now, latencyMs);
}

interface HealthRow {
  profileId: string;
  addonUrl: string;
  fails: number;
  lastError: string;
  updatedAt: number;
  latencyMs?: number;
}

export function registerHealth(app: Hono<{ Bindings: Env }>) {
  app.get("/api/admin/usage", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    const health = await c.env.DB.prepare(
      "SELECT profile_id AS profileId, addon_url AS addonUrl, fails, last_error AS lastError, updated_at AS updatedAt, COALESCE(latency_ms, 0) AS latencyMs FROM addon_health ORDER BY updated_at DESC",
    ).all<HealthRow>();
    return c.json({ Health: health.results ?? [] });
  });
}
