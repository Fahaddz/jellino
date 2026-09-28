import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import {
  hashPassword,
  newSalt,
  registerAllowed,
  registerFirstUser,
  verifyPassword,
} from "../src/auth";
import { callApp, createFakeDb, testEnv } from "./fake-db";
import { verifyToken } from "../src/session";

type Db = import("@cloudflare/workers-types").D1Database;

describe("passwords", () => {
  it("hashes and verifies roundtrip", async () => {
    const salt = newSalt();
    const hash = await hashPassword("correct horse battery", salt);
    expect(await verifyPassword("correct horse battery", salt, hash)).toBe(true);
    expect(await verifyPassword("wrong password here", salt, hash)).toBe(false);
  });

  it("rejects mismatched hash length", async () => {
    expect(await verifyPassword("some password", newSalt(), "short")).toBe(false);
  });
});

describe("profile bootstrap", () => {
  it("makes the first user admin", async () => {
    const db = createFakeDb() as unknown as Db;
    const res = await registerFirstUser(db, "dad", "supersecret1", 1000);
    expect(res.status).toBe(201);
    expect(res.body["admin"]).toBe(true);
    expect(res.body["name"]).toBe("dad");
  });

  it("closes registration after the first user", async () => {
    const db = createFakeDb() as unknown as Db;
    await registerFirstUser(db, "dad", "supersecret1", 1000);
    const res = await registerFirstUser(db, "mom", "supersecret2", 1001);
    expect(res.status).toBe(403);
  });

  it("validates name and password", async () => {
    const db = createFakeDb() as unknown as Db;
    expect((await registerFirstUser(db, "  ", "supersecret1", 0)).status).toBe(400);
    expect((await registerFirstUser(db, "dad", "short", 0)).status).toBe(400);
  });

  it("rate limits repeated attempts", async () => {
    const db = createFakeDb() as unknown as Db;
    for (let i = 0; i < 5; i++) {
      expect(await registerAllowed(db, "9.9.9.9", 1000)).toBe(true);
    }
    expect(await registerAllowed(db, "9.9.9.9", 1000)).toBe(false);
    expect(await registerAllowed(db, "9.9.9.9", 1000 + 601)).toBe(true);
  });

  it("reports setup status", async () => {
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const app = createApp();
    const env = testEnv(raw);
    const empty = (await (await callApp(app, env, "/api/setup/status")).json()) as Record<
      string,
      unknown
    >;
    expect(empty).toEqual({ users: 0, adminExists: false });
    await registerFirstUser(db, "dad", "supersecret1", 1000);
    const filled = (await (await callApp(app, env, "/api/setup/status")).json()) as Record<
      string,
      unknown
    >;
    expect(filled).toEqual({ users: 1, adminExists: true });
  });
  it("handles admin nuvio login endpoint", async () => {
    const raw = createFakeDb();
    const app = createApp();
    const env = testEnv(raw);

    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/auth/v1/token")) {
        return new Response(JSON.stringify({
          access_token: "tok-123",
          refresh_token: "ref-123",
          expires_in: 3600,
          user: { id: "u-123", email: "dad@nuvio.tv" }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const res = await callApp(app, env, "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "dad@nuvio.tv", password: "mypassword123" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; token: string; user: { is_admin: boolean } };
      expect(data.ok).toBe(true);
      expect(data.user.is_admin).toBe(true);
      expect(typeof data.token).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects admin login with different email once admin is established", async () => {
    const raw = createFakeDb();
    const app = createApp();
    const env = testEnv(raw);

    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/auth/v1/token")) {
        return new Response(JSON.stringify({
          access_token: "tok-123",
          refresh_token: "ref-123",
          expires_in: 3600,
          user: { id: "u-123", email: "dad@nuvio.tv" }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const first = await callApp(app, env, "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
        body: JSON.stringify({ email: "dad@nuvio.tv", password: "mypassword123" }),
      });
      expect(first.status).toBe(200);

      const attacker = await callApp(app, env, "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.6.7.8" },
        body: JSON.stringify({ email: "attacker@nuvio.tv", password: "attackerpass" }),
      });
      expect(attacker.status).toBe(401);
      const err = await attacker.json() as { error: string };
      expect(err.error).toBe("invalid credentials");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bumps the token epoch when the nuvio login rewrites the admin password", async () => {
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const app = createApp();
    const env = testEnv(raw);

    const mockFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/auth/v1/token")) {
        return new Response(JSON.stringify({
          access_token: "tok-123",
          refresh_token: "ref-123",
          expires_in: 3600,
          user: { id: "u-123", email: "dad@nuvio.tv" }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const first = await callApp(app, env, "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
        body: JSON.stringify({ email: "dad@nuvio.tv", password: "mypassword123" }),
      });
      expect(first.status).toBe(200);
      const firstToken = ((await first.json()) as { token: string }).token;
      const now = Math.floor(Date.now() / 1000);
      expect(await verifyToken(db, firstToken, now)).toBeTruthy();

      const second = await callApp(app, env, "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.6.7.8" },
        body: JSON.stringify({ email: "dad@nuvio.tv", password: "mypassword123" }),
      });
      expect(second.status).toBe(200);
      expect(await verifyToken(db, firstToken, now)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throttles repeated nuvio admin login attempts per ip", async () => {
    const raw = createFakeDb();
    const app = createApp();
    const env = testEnv(raw);

    for (let i = 0; i < 10; i++) {
      const res = await callApp(app, env, "/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
        body: JSON.stringify({ email: "wrong@nuvio.tv", password: "wrong" }),
      });
      expect([400, 401]).toContain(res.status);
    }

    const throttled = await callApp(app, env, "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
      body: JSON.stringify({ email: "wrong@nuvio.tv", password: "wrong" }),
    });
    expect(throttled.status).toBe(429);
  });
});
