import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { ADMIN_CLIENT_JS } from "../src/ui/admin-client";
import { callApp, createFakeDb, testEnv } from "./fake-db";

describe("system endpoints", () => {
  it("answers health with zero state", async () => {
    const app = createApp();
    const res = await callApp(app, testEnv(createFakeDb()), "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", schema: "ready" });
  });

  it("reports the package version so the dashboard and the release agree", async () => {
    const app = createApp();
    const res = await callApp(app, testEnv(createFakeDb()), "/api/version");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["build"]).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("exposes Jellyfin-compatible public info", async () => {
    const app = createApp();
    const res = await callApp(app, testEnv(createFakeDb()), "/System/Info/Public");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ProductName"]).toBe("Jellyfin Server");
    expect(body["StartupWizardCompleted"]).toBe(true);
    expect(typeof body["Version"]).toBe("string");
    expect(typeof body["Id"]).toBe("string");
  });

  it("exposes extended system info", async () => {
    const app = createApp();
    const res = await callApp(app, testEnv(createFakeDb()), "/System/Info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ProductName"]).toBe("Jellyfin Server");
  });

  it("answers the client reachability probe over GET and POST", async () => {
    const app = createApp();
    const env = testEnv(createFakeDb());
    const getRes = await callApp(app, env, "/System/Ping");
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toBe("Jellino");
    const postRes = await callApp(app, env, "/System/Ping", { method: "POST" });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toBe("Jellino");
  });

  it("returns json 404 for unknown api routes", async () => {
    const app = createApp();
    const res = await callApp(app, testEnv(createFakeDb()), "/api/nope");
    expect(res.status).toBe(404);
  });

  it("redirects root to setup on first run and serves home after setup", async () => {
    const app = createApp();
    const db = createFakeDb();
    const firstRes = await callApp(app, testEnv(db), "/");
    expect(firstRes.status).toBe(302);
    expect(firstRes.headers.get("location")).toBe("/setup");

    db.profiles.push({
      id: "admin-id",
      name: "Admin",
      password_hash: "hash",
      salt: "salt",
      is_admin: 1,
      disabled: 0,
      addon_mode: "custom",
      created_at: 1000,
    });
    const secondRes = await callApp(app, testEnv(db), "/");
    expect(secondRes.status).toBe(200);
    const html = await secondRes.text();
    expect(html).toContain("Jellino Server");
    expect(html).toContain("Open Admin Dashboard");
  });

  it("serves setup and admin pages directly from typescript without html files", async () => {
    const app = createApp();
    const setupRes = await callApp(app, testEnv(createFakeDb()), "/setup");
    expect(setupRes.status).toBe(200);
    const setupHtml = await setupRes.text();
    expect(setupHtml).toContain("Welcome to Jellino");
    expect(setupHtml).toContain("Sign in with Nuvio");
    expect(setupHtml).not.toContain("Custom Admin Account");

    const adminRes = await callApp(app, testEnv(createFakeDb()), "/admin");
    expect(adminRes.status).toBe(200);
    const adminHtml = await adminRes.text();
    expect(adminHtml).toContain("Jellino Admin");
    expect(adminHtml).toContain("sidebar");
  });

  it("redirects legacy .html routes to clean extension-less endpoints", async () => {
    const app = createApp();
    const setupRedirect = await callApp(app, testEnv(createFakeDb()), "/setup.html");
    expect(setupRedirect.status).toBe(301);
    expect(setupRedirect.headers.get("location")).toBe("/setup");

    const adminRedirect = await callApp(app, testEnv(createFakeDb()), "/admin.html");
    expect(adminRedirect.status).toBe(301);
    expect(adminRedirect.headers.get("location")).toBe("/admin");
  });
});

  it("serves the admin client with instantly flipping switches", async () => {
    const app = createApp();
    const res = await callApp(app, testEnv(createFakeDb()), "/admin.js");
    expect(res.status).toBe(200);
    const js = await res.text();
    expect(js).toContain('btn.dataset.state = next ? "checked" : "unchecked"');
  });

  it("serves admin js and css directly from typescript modules in memory", async () => {
    const app = createApp();
    const jsRes = await callApp(app, testEnv(createFakeDb()), "/admin.js");
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("Content-Type")).toContain("application/javascript");
    expect(await jsRes.text()).toContain("jellino-admin-token");

    const cssRes = await callApp(app, testEnv(createFakeDb()), "/admin.css");
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("Content-Type")).toContain("text/css");

    const remuxRes = await callApp(app, testEnv(createFakeDb()), "/remux-theme.css");
    expect(remuxRes.status).toBe(200);
    expect(remuxRes.headers.get("Content-Type")).toContain("text/css");
  });

describe("admin bundle", () => {
  it("defines every page handler referenced by PAGES", () => {
    const handlers = [...ADMIN_CLIENT_JS.matchAll(/render:\s*(\w+)/g)].map((match) => match[1]);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(ADMIN_CLIENT_JS).toContain(`function ${handler}(`);
    }
  });

  it("executes its top level without throwing against a minimal DOM", () => {
    const node = (): unknown =>
      new Proxy(function () {}, {
        get(_target, key) {
          if (key === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
          if (key === "style") return {};
          if (key === "dataset") return {};
          return node();
        },
        apply() {
          return node();
        },
      });
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { window: globals.window, document: globals.document, location: globals.location, fetch: globals.fetch };
    globals.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
    globals.document = {
      getElementById: () => node(),
      querySelectorAll: () => [],
      querySelector: () => node(),
      createElement: () => node(),
      addEventListener: () => undefined,
      documentElement: node(),
      body: node(),
    };
    globals.location = { href: "" };
    globals.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    try {
      expect(() => new Function(ADMIN_CLIENT_JS)()).not.toThrow();
    } finally {
      globals.window = saved.window;
      globals.document = saved.document;
      globals.location = saved.location;
      globals.fetch = saved.fetch;
    }
  });
});
