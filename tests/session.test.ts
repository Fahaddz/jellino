import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { bearerToken, issueToken, verifyToken } from "../src/session";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

async function seeded() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const created = await registerFirstUser(db, "dad", "supersecret1", 1000);
  const id = (created.body as { id: string }).id;
  return { raw, db, id };
}

function loginBody(name: string, pw: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ Username: name, Pw: pw }),
  };
}

describe("session tokens", () => {
  it("round-trips profile id inside expiry", async () => {
    const { db, id } = await seeded();
    const token = await issueToken(db, id, 2000);
    expect(await verifyToken(db, token, 2000)).toBe(id);
  });

  it("rejects tampered, foreign, and expired tokens", async () => {
    const { db, id } = await seeded();
    const token = await issueToken(db, id, 2000);
    expect(await verifyToken(db, `${token}x`, 2000)).toBeNull();
    expect(await verifyToken(db, "j1.someone.9999999999.deadbeef", 2000)).toBeNull();
    expect(await verifyToken(db, "garbage", 2000)).toBeNull();
    const year = 366 * 86400;
    expect(await verifyToken(db, token, 2000 + year)).toBeNull();
  });

  it("accepts legacy tokens signed before the epoch existed", async () => {
    const { db, id } = await seeded();
    const { hmacSign, serverSecret } = await import("../src/session");
    const secret = await serverSecret(db);
    const legacy = `j1.${id}.9999999999.${await hmacSign(secret, `${id}.9999999999`)}`;
    expect(await verifyToken(db, legacy, 2000)).toBe(id);
  });

  it("revokes outstanding tokens when the epoch is bumped", async () => {
    const { db, id } = await seeded();
    const token = await issueToken(db, id, 2000);
    expect(await verifyToken(db, token, 2000)).toBe(id);
    const { bumpTokenEpoch } = await import("../src/session");
    await bumpTokenEpoch(db, id);
    expect(await verifyToken(db, token, 2000)).toBeNull();
    const fresh = await issueToken(db, id, 2000);
    expect(await verifyToken(db, fresh, 2000)).toBe(id);
  });
});

describe("user routes", () => {
  it("authenticates with AccessToken plus user dto", async () => {
    const { raw, id } = await seeded();
    const res = await callApp(createApp(), testEnv(raw), "/Users/AuthenticateByName", loginBody("dad", "supersecret1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { AccessToken: string; ServerId: string; User: { Id: string; Name: string } };
    expect(body.User.Id).toBe(id);
    expect(body.User.Name).toBe("dad");
    expect(body.ServerId).toBe("jellino");
    expect(typeof body.AccessToken).toBe("string");
    expect(await verifyToken(raw as unknown as Db, body.AccessToken, 2000)).toBe(id);
  });

  it("rejects wrong password and unknown user without distinction", async () => {
    const { raw } = await seeded();
    const app = createApp();
    const env = testEnv(raw);
    const wrong = await callApp(app, env, "/Users/AuthenticateByName", loginBody("dad", "wrongpassword"));
    const ghost = await callApp(app, env, "/Users/AuthenticateByName", loginBody("ghost", "supersecret1"));
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(await wrong.json()).toEqual(await ghost.json());
  });

  it("throttles repeated login attempts per ip", async () => {
    const { raw } = await seeded();
    const app = createApp();
    const env = testEnv(raw);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await callApp(app, env, "/Users/AuthenticateByName", loginBody("dad", "wrongpassword"));
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("lists public users and resolves one by id behind the token", async () => {
    const { raw, id } = await seeded();
    const app = createApp();
    const env = testEnv(raw);
    const pub = (await (await callApp(app, env, "/Users/Public")).json()) as { Name: string; Id: string }[];
    expect(pub).toHaveLength(1);
    expect(pub[0]).toMatchObject({ Name: "dad", Id: id });
    expect(pub[0]).not.toHaveProperty("Policy");
    const token = await issueToken(raw as unknown as Db, id, Math.floor(Date.now() / 1000));
    const headers = { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
    const unauth = await callApp(app, env, `/Users/${id}`);
    expect(unauth.status).toBe(401);
    const one = await callApp(app, env, `/Users/${id}`, { headers });
    expect(one.status).toBe(200);
    const missing = await callApp(app, env, "/Users/nope", { headers });
    expect(missing.status).toBe(404);
  });

  it("resolves the current user plus ping behind the token", async () => {
    const { raw, id } = await seeded();
    const app = createApp();
    const env = testEnv(raw);
    const login = await callApp(app, env, "/Users/AuthenticateByName", loginBody("dad", "supersecret1"));
    const token = ((await login.json()) as { AccessToken: string }).AccessToken;
    const headers = { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
    const anon = await callApp(app, env, "/Users/Me");
    expect(anon.status).toBe(401);
    const me = await callApp(app, env, "/Users/Me", { headers });
    expect(me.status).toBe(200);
    const user = (await me.json()) as Record<string, unknown>;
    expect(user).toMatchObject({ Id: id, Name: "dad", ServerId: "jellino", ServerName: "Jellino" });
    const policy = user.Policy as Record<string, unknown>;
    expect(policy.AuthenticationProviderId).toContain("DefaultAuthenticationProvider");
    expect(policy.PasswordResetProviderId).toContain("DefaultPasswordResetProvider");
    const ping = await callApp(app, env, "/System/Ping");
    expect(ping.status).toBe(200);
    const pong = await callApp(app, env, "/System/Ping", { method: "POST" });
    expect(pong.status).toBe(200);
  });

  it("returns session info the clients can parse", async () => {
    const { raw } = await seeded();
    const res = await callApp(createApp(), testEnv(raw), "/Users/AuthenticateByName", loginBody("dad", "supersecret1"));
    const body = (await res.json()) as {
      SessionInfo: Record<string, unknown>;
      User: { Policy: Record<string, unknown>; Configuration: Record<string, unknown>; PrimaryImageAspectRatio: unknown };
    };
    expect(body.SessionInfo).toMatchObject({
      UserName: "dad",
      IsActive: true,
      PlayableMediaTypes: ["Video"],
      Capabilities: { PlayableMediaTypes: ["Video"] },
      PlayState: { CanSeek: false, IsPaused: false, IsMuted: false },
    });
    expect(body.SessionInfo.Id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.User.Configuration).toMatchObject({ SubtitleMode: "Default", GroupedFolders: [] });
    expect(body.User.PrimaryImageAspectRatio).toBeNull();
    expect(body.User.Policy.IsAdministrator).toBe(true);
  });
});

describe("bearer token sources", () => {
  const emby = (token: string) => `MediaBrowser Client="test", Token="${token}"`;

  it("accepts every header form real clients send", () => {
    expect(bearerToken(new Request("http://x/", { headers: { "X-Emby-Authorization": emby("a1") } }))).toBe("a1");
    expect(bearerToken(new Request("http://x/", { headers: { Authorization: emby("a2") } }))).toBe("a2");
    expect(bearerToken(new Request("http://x/", { headers: { "X-Emby-Token": "a3" } }))).toBe("a3");
    expect(bearerToken(new Request("http://x/", { headers: { "X-MediaBrowser-Token": "a4" } }))).toBe("a4");
    expect(bearerToken(new Request("http://x/?api_key=a5"))).toBe("a5");
    expect(bearerToken(new Request("http://x/", { headers: { Authorization: "Bearer a6" } }))).toBe("a6");
    expect(bearerToken(new Request("http://x/?ApiKey=a7"))).toBe("a7");
    expect(bearerToken(new Request("http://x/", { headers: { Authorization: "MediaBrowser Token=a8" } }))).toBe("a8");
  });

  it("prefers api_key, then emby headers, and rejects header soup without a token", () => {
    const req = new Request("http://x/?api_key=a5", { headers: { Authorization: emby("a2") } });
    expect(bearerToken(req)).toBe("a5");
    expect(bearerToken(new Request("http://x/", { headers: { Authorization: "MediaBrowser Client=test" } }))).toBeNull();
    expect(bearerToken(new Request("http://x/"))).toBeNull();
  });

  it("authorizes Moonfin-style requests end to end", async () => {
    const { raw, db, id } = await seeded();
    const store = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).caches = {
      default: {
        match: async (key: Request) => {
          const body = store.get(key.url);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (key: Request, value: Response) => {
          store.set(key.url, await value.clone().text());
        },
        delete: async (key: Request) => store.delete(key.url),
      },
    };
    const token = await issueToken(db, id, Math.floor(Date.now() / 1000));
    const res = await callApp(createApp(), testEnv(raw), `/Users/${id}/Views`, {
      headers: { Authorization: "MediaBrowser " + emby(token) },
    });
    delete (globalThis as unknown as Record<string, unknown>).caches;
    expect(res.status).toBe(200);
  });

  it("serves a cached avatar for profiles and 404 for ghosts", async () => {
    const { raw, id } = await seeded();
    const store = new Map<string, string>();
    (globalThis as unknown as Record<string, unknown>).caches = {
      default: {
        match: async (key: Request) => {
          const body = store.get(key.url);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (key: Request, value: Response) => {
          store.set(key.url, await value.clone().text());
        },
        delete: async (key: Request) => store.delete(key.url),
      },
    };
    try {
      const app = createApp();
      const env = testEnv(raw);
      const res = await callApp(app, env, `/Users/${id}/Images/Primary`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(await res.text()).toContain("<svg");
      const ghost = await callApp(app, env, "/Users/ghost/Images/Primary");
      expect(ghost.status).toBe(404);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).caches;
    }
  });
  it("authenticates admin by linked nuvio email", async () => {
    const { db, id } = await seeded();
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("nuvio_account", JSON.stringify({ email: "fahad@example.com" })).run();
    const { authenticateByName } = await import("../src/session");
    const res = await authenticateByName(db, "srv1", "fahad@example.com", "supersecret1", "127.0.0.1", 1000);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });
});
