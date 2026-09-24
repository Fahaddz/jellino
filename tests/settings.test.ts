import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { PUBLICMETADB_API_KEY_SETTING } from "../src/segments";
import { callApp, createFakeDb, testEnv } from "./fake-db";
import { readSetting } from "../src/db";

type Db = import("@cloudflare/workers-types").D1Database;

const authHeader = (token: string) => ({ "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` });

async function adminSeeded() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const created = await registerFirstUser(db, "dad", "supersecret1", 1000);
  const token = await issueToken(db, (created.body as { id: string }).id, Math.floor(Date.now() / 1000));
  return { raw, db, token };
}

describe("server settings", () => {
  it("requires an admin token", async () => {
    const { raw } = await adminSeeded();
    const app = createApp();
    const env = testEnv(raw);
    expect((await callApp(app, env, "/api/admin/settings")).status).toBe(401);
  });

  it("stores the PublicMetaDB key and rejects bad values", async () => {
    const { raw, db, token } = await adminSeeded();
    const app = createApp();
    const env = testEnv(raw);
    const save = await callApp(app, env, "/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: JSON.stringify({ publicMetaDbKey: "pmdb-key-1" }),
    });
    expect(save.status).toBe(200);
    expect(((await save.json()) as { publicMetaDbKey: string }).publicMetaDbKey).toBe("pmdb-key-1");
    expect(await readSetting(db, PUBLICMETADB_API_KEY_SETTING)).toBe("pmdb-key-1");

    const bad = await callApp(app, env, "/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: JSON.stringify({ publicMetaDbKey: 42 }),
    });
    expect(bad.status).toBe(400);
  });
});
