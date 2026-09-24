import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { authenticateByName, issueToken } from "../src/session";
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

function addPasswordlessProfile(raw: ReturnType<typeof createFakeDb>, id: string, name: string): void {
  raw.profiles.push({
    id,
    name,
    password_hash: "",
    salt: "",
    is_admin: 0,
    addon_mode: "inherit",
    disabled: 0,
    created_at: 2000,
  });
}

describe("mandatory passwords", () => {
  it("rejects empty and short password changes", async () => {
    const { raw, db, adminId } = await household();
    addPasswordlessProfile(raw, "synced-kid", "Synced Kid");
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    for (const password of ["", "short"]) {
      const res = await callApp(app, env, "/api/admin/profiles/synced-kid/password", {
        method: "POST",
        headers,
        body: JSON.stringify({ password }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("password required");
    }

    const listed = (await (await callApp(app, env, "/api/admin/profiles", { headers: authHeader(token) })).json()) as {
      Profiles: { id: string; hasPassword: boolean }[];
    };
    expect(listed.Profiles.find((p) => p.id === "synced-kid")?.hasPassword).toBe(false);
  });

  it("refuses to clear a password back to passwordless", async () => {
    const { raw, db, adminId } = await household();
    addPasswordlessProfile(raw, "synced-kid", "Synced Kid");
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const headers = { ...authHeader(token), "content-type": "application/json" };

    const set = await callApp(app, env, "/api/admin/profiles/synced-kid/password", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "kidsecret1" }),
    });
    expect(set.status).toBe(200);

    const clear = await callApp(app, env, "/api/admin/profiles/synced-kid/password", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "" }),
    });
    expect(clear.status).toBe(400);
    expect(((await clear.json()) as { error: string }).error).toBe("password required");

    const listed = (await (await callApp(app, env, "/api/admin/profiles", { headers: authHeader(token) })).json()) as {
      Profiles: { id: string; hasPassword: boolean }[];
    };
    expect(listed.Profiles.find((p) => p.id === "synced-kid")?.hasPassword).toBe(true);
  });

  it("blocks empty-password logins for credential-less profiles", async () => {
    const { raw, db, adminId } = await household();
    addPasswordlessProfile(raw, "synced-kid", "Synced Kid");
    const adminToken = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const blocked = await callApp(app, env, "/Users/AuthenticateByName", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Username: "Synced Kid", Pw: "" }),
    });
    expect(blocked.status).toBe(401);
    expect(((await blocked.json()) as { error: string }).error).toBe("password required");

    const setPass = await callApp(app, env, "/api/admin/profiles/synced-kid/password", {
      method: "POST",
      headers: { ...authHeader(adminToken), "content-type": "application/json" },
      body: JSON.stringify({ password: "syncedsecret1" }),
    });
    expect(setPass.status).toBe(200);

    const stillEmpty = await authenticateByName(db, "jellino", "Synced Kid", "", "1.2.3.4", 3000);
    expect(stillEmpty.status).toBe(401);
    const withPassword = await authenticateByName(db, "jellino", "Synced Kid", "syncedsecret1", "1.2.3.4", 3001);
    expect(withPassword.status).toBe(200);
  });

  it("still signs credential-less profiles in through a Quick Connect one-time code", async () => {
    const { raw, db, adminId } = await household();
    addPasswordlessProfile(raw, "synced-kid", "Synced Kid");
    const adminToken = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);

    const initRes = await callApp(app, env, "/QuickConnect/Initiate", { method: "POST" });
    expect(initRes.status).toBe(200);
    const initData = (await initRes.json()) as { Code: string; Secret: string };

    const authRes = await callApp(app, env, "/QuickConnect/Authorize", {
      method: "POST",
      headers: { ...authHeader(adminToken), "content-type": "application/json" },
      body: JSON.stringify({ code: initData.Code, profileId: "synced-kid" }),
    });
    expect(authRes.status).toBe(200);

    const claimRes = await callApp(app, env, "/Users/AuthenticateWithQuickConnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Secret: initData.Secret }),
    });
    expect(claimRes.status).toBe(200);
    const claim = (await claimRes.json()) as { User: { Id: string }; AccessToken: string };
    expect(claim.User.Id).toBe("synced-kid");
    expect(claim.AccessToken).toBeTruthy();
  });
});
