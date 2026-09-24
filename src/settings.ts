import type { Hono } from "hono";
import type { Env } from "./db";
import { adminOwner } from "./session";
import { readSetting, writeSetting } from "./db";
import { PUBLICMETADB_API_KEY_SETTING } from "./segments";
import { TMDB_API_KEY_SETTING } from "./people";

const KEY_MAX = 256;

async function settingsBody(db: D1Database): Promise<{ publicMetaDbKey: string; tmdbApiKey: string }> {
  const [publicMetaDbKey, tmdbApiKey] = await Promise.all([
    readSetting(db, PUBLICMETADB_API_KEY_SETTING),
    readSetting(db, TMDB_API_KEY_SETTING),
  ]);
  return { publicMetaDbKey: publicMetaDbKey ?? "", tmdbApiKey: tmdbApiKey ?? "" };
}

export function registerSettings(app: Hono<{ Bindings: Env }>) {
  app.get("/api/admin/settings", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    return c.json(await settingsBody(c.env.DB));
  });

  app.put("/api/admin/settings", async (c) => {
    if (!(await adminOwner(c))) return c.json({ error: "unauthorized" }, 401);
    let body: { publicMetaDbKey?: unknown; tmdbApiKey?: unknown };
    try {
      body = (await c.req.json()) as { publicMetaDbKey?: unknown; tmdbApiKey?: unknown };
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    if (body.publicMetaDbKey !== undefined) {
      if (typeof body.publicMetaDbKey !== "string" || body.publicMetaDbKey.length > KEY_MAX) {
        return c.json({ error: "invalid PublicMetaDB key" }, 400);
      }
      await writeSetting(c.env.DB, PUBLICMETADB_API_KEY_SETTING, body.publicMetaDbKey.trim());
    }
    if (body.tmdbApiKey !== undefined) {
      if (typeof body.tmdbApiKey !== "string" || body.tmdbApiKey.length > KEY_MAX) {
        return c.json({ error: "invalid TMDB key" }, 400);
      }
      await writeSetting(c.env.DB, TMDB_API_KEY_SETTING, body.tmdbApiKey.trim());
    }
    return c.json(await settingsBody(c.env.DB));
  });
}
