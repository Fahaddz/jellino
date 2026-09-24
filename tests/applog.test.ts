import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

describe("app log and sessions", () => {
  it("serves an empty app-log for a fresh db", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const headers = authHeader(token);
    const log = await callApp(app, env, "/api/admin/app-log", { headers });
    expect(log.status).toBe(200);
    const diag = await callApp(app, env, "/api/admin/diagnostics", { headers });
    expect(diag.status).toBe(200);
  });

  it("serves an empty Sessions list", async () => {
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const res = await callApp(app, env, "/Sessions", { headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
