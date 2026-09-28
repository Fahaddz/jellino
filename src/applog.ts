import type { D1PreparedStatement } from "@cloudflare/workers-types";
import type { Hono } from "hono";
import type { Env } from "./db";
import { adminOwner } from "./session";

const APP_LOG_KEEP = 300;
const APP_LOG_FLUSH_SIZE = 20;
const APP_LOG_PRUNE_EVERY = 50;
const APP_LOG_BUFFER_MAX = 500;

let buffer: (AppLogRow & { category: string; at: number })[] = [];
let flushes = 0;
let flushing: Promise<void> | null = null;
let lastDb: D1Database | null = null;

export async function flushAppLog(db?: D1Database): Promise<void> {
  const target = db ?? lastDb;
  if (!target) return;
  if (flushing) return flushing;
  lastDb = target;
  const run = (async () => {
    await Promise.resolve();
    try {
      while (buffer.length > 0) {
        const pending = buffer;
        buffer = [];
        try {
          await target.batch(
            pending.map((row) =>
              target
                .prepare("INSERT INTO app_log (at, level, category, kind, profile_id, message, url) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
                .bind(
                  row.at,
                  row.level.slice(0, 20),
                  (row.category ?? "").slice(0, 40),
                  row.kind.slice(0, 40),
                  row.profileId.slice(0, 128),
                  row.message.slice(0, 500),
                  row.url.slice(0, 500),
                ),
            ),
          );
          flushes += 1;
        } catch {
          buffer = pending.concat(buffer).slice(-APP_LOG_BUFFER_MAX);
          break;
        }
        if (flushes % APP_LOG_PRUNE_EVERY === 0) {
          await target
            .prepare("DELETE FROM app_log WHERE id NOT IN (SELECT id FROM app_log ORDER BY id DESC LIMIT ?1)")
            .bind(APP_LOG_KEEP)
            .run()
            .catch(() => undefined);
        }
      }
    } finally {
      flushing = null;
    }
  })();
  flushing = run;
  return run;
}

export interface AppLogRow {
  at: number;
  level: string;
  category?: string;
  kind: string;
  profileId: string;
  message: string;
  url: string;
}

export async function logApp(db: D1Database, row: AppLogRow): Promise<void> {
  lastDb = db;
  buffer.push({ ...row, category: row.category ?? "" });
  if (buffer.length >= APP_LOG_FLUSH_SIZE) {
    await flushAppLog(db);
  }
}

const FAILURE_LOG_THROTTLE_SECONDS = 300;

const failureLogAt = new Map<string, number>();

export function resetFailureLogThrottle(): void {
  failureLogAt.clear();
}

export async function logFailureThrottled(db: D1Database, key: string, row: AppLogRow): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const last = failureLogAt.get(key) ?? 0;
  if (now - last < FAILURE_LOG_THROTTLE_SECONDS) return;
  failureLogAt.set(key, now);
  if (failureLogAt.size > 500) {
    const cutoff = now - FAILURE_LOG_THROTTLE_SECONDS;
    for (const [k, at] of failureLogAt) {
      if (at < cutoff) failureLogAt.delete(k);
    }
  }
  await logApp(db, row);
}

export function clientInfo(req: Request): { client: string; device: string } {
  const raw = req.headers.get("X-Emby-Authorization") ?? req.headers.get("Authorization") ?? "";
  const client = /Client="([^"]+)"/i.exec(raw)?.[1] ?? /Client=([^,; ]+)/i.exec(raw)?.[1] ?? "";
  const device = /Device="([^"]+)"/i.exec(raw)?.[1] ?? /Device=([^,; ]+)/i.exec(raw)?.[1] ?? "";
  return { client: client.slice(0, 64), device: device.slice(0, 64) };
}

function appLogQuery(
  db: D1Database,
  filter: { category: string; kind: string; level: string },
  limit: number,
): D1PreparedStatement {
  const select = "SELECT at, level, category, kind, profile_id AS profileId, message, url FROM app_log";
  if (filter.category) return db.prepare(`${select} WHERE category = ? ORDER BY id DESC LIMIT ?`).bind(filter.category.slice(0, 40), limit);
  if (filter.kind) return db.prepare(`${select} WHERE kind = ? ORDER BY id DESC LIMIT ?`).bind(filter.kind.slice(0, 40), limit);
  if (filter.level) return db.prepare(`${select} WHERE level = ? ORDER BY id DESC LIMIT ?`).bind(filter.level.slice(0, 20), limit);
  return db.prepare(`${select} ORDER BY id DESC LIMIT ?`).bind(limit);
}

export function registerAppLog(app: Hono<{ Bindings: Env }>) {
  app.get("/api/admin/app-log", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    await flushAppLog(c.env.DB);
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 100);
    const rows = await appLogQuery(
      c.env.DB,
      {
        category: c.req.query("category") ?? "",
        kind: c.req.query("kind") ?? "",
        level: c.req.query("level") ?? "",
      },
      limit,
    ).all<AppLogRow & { profileId: string }>();
    return c.json({ entries: rows.results ?? [] });
  });

  app.delete("/api/admin/app-log", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    await c.env.DB.prepare("DELETE FROM app_log").run();
    return c.json({ ok: true });
  });

  app.get("/api/admin/diagnostics", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    const [appLog, health] = await Promise.all([
      c.env.DB.prepare("SELECT at, level, category, kind, profile_id AS profileId, message, url FROM app_log ORDER BY id DESC LIMIT 50").all(),
      c.env.DB.prepare("SELECT profile_id AS profileId, addon_url AS addonUrl, fails, last_error AS lastError FROM addon_health ORDER BY updated_at DESC LIMIT 20").all(),
    ]);
    return c.json({ appLog: appLog.results ?? [], health: health.results ?? [] });
  });
}
