import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { callApp, createFakeDb, testEnv } from "./fake-db";
import { clearProgressDebounce } from "../src/sessions";
import { readWatchPosition } from "../src/watch-state";
import { encodeItem } from "../src/ids";

type Db = import("@cloudflare/workers-types").D1Database;

describe("Quick Connect", () => {
  it("supports initiate, status polling, authorize, and authentication exchange", async () => {
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const app = createApp();
    const env = testEnv(raw);

    const admin = (await registerFirstUser(db, "owner", "adminsecret123", Math.floor(Date.now() / 1000))).body as { id: string };
    const adminToken = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));

    const enabledRes = await callApp(app, env, "/QuickConnect/Enabled");
    expect(enabledRes.status).toBe(200);
    expect(await enabledRes.json()).toBe(true);

    const enabledPostRes = await callApp(app, env, "/QuickConnect/Enabled", { method: "POST" });
    expect(enabledPostRes.status).toBe(200);
    expect(await enabledPostRes.json()).toBe(true);

    const initRes = await callApp(app, env, "/QuickConnect/Initiate", {
      method: "POST",
      headers: {
        "X-Emby-Authorization": 'MediaBrowser Client="Moonfin", Device="Apple TV", DeviceId="tv-1", Version="1.0.0"',
      },
    });
    expect(initRes.status).toBe(200);
    const initData = (await initRes.json()) as {
      Code: string;
      Secret: string;
      Authenticated: boolean;
      AppName: string;
      DeviceName: string;
      AuthenticationToken?: string | null;
    };
    expect(initData.Code).toMatch(/^\d{6}$/);
    expect(initData.Secret).toBeTruthy();
    expect(initData.Authenticated).toBe(false);
    expect(initData.AuthenticationToken).toBeNull();
    expect(initData.AppName).toBe("Moonfin");
    expect(initData.DeviceName).toBe("Apple TV");

    const connectPending = await callApp(app, env, `/QuickConnect/Connect?secret=${initData.Secret}`);
    expect(connectPending.status).toBe(200);
    const pendingData = (await connectPending.json()) as { Authenticated: boolean; Code: string; AuthenticationToken?: string | null };
    expect(pendingData.Authenticated).toBe(false);
    expect(pendingData.AuthenticationToken).toBeNull();
    expect(pendingData.Code).toBe(initData.Code);

    const authRes = await callApp(app, env, `/QuickConnect/Authorize?code=${initData.Code}&userId=${admin.id}`, {
      method: "POST",
      headers: {
        "X-Emby-Authorization": `MediaBrowser Client="admin", Token="${adminToken}"`,
      },
    });
    expect(authRes.status).toBe(200);

    const connectAuthed = await callApp(app, env, `/QuickConnect/Connect?secret=${initData.Secret}`);
    expect(connectAuthed.status).toBe(200);
    const authedData = (await connectAuthed.json()) as { Authenticated: boolean; AuthenticationToken?: string | null };
    expect(authedData.Authenticated).toBe(true);
    expect(authedData.AuthenticationToken).toBe(initData.Secret);

    const postConnectRes = await callApp(app, env, "/QuickConnect/Connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Secret: initData.Secret }),
    });
    expect(postConnectRes.status).toBe(200);
    const postConnectData = (await postConnectRes.json()) as { Authenticated: boolean };
    expect(postConnectData.Authenticated).toBe(true);

    const claimRes = await callApp(app, env, "/Users/AuthenticateWithQuickConnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Secret: initData.Secret }),
    });
    expect(claimRes.status).toBe(200);
    const claimData = (await claimRes.json()) as {
      User: { Id: string; Name: string };
      AccessToken: string;
      ServerId: string;
    };
    expect(claimData.User.Id).toBe(admin.id);
    expect(claimData.User.Name).toBe("owner");
    expect(claimData.AccessToken).toBeTruthy();

    const claimAgain = await callApp(app, env, "/Users/AuthenticateWithQuickConnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Secret: initData.Secret }),
    });
    expect(claimAgain.status).toBe(401);
  });
});

describe("watch_state progress debounce", () => {
  it("debounces writes when position changes by less than 10 seconds, but writes on pause or stop", async () => {
    clearProgressDebounce();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const app = createApp();
    const env = testEnv(raw);

    const admin = (await registerFirstUser(db, "owner", "adminsecret123", Math.floor(Date.now() / 1000))).body as { id: string };
    const adminToken = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
    const itemId = encodeItem("https://v3-cinemeta.strem.io", "movie", "tt1234567");

    const playRes = await callApp(app, env, "/Sessions/Playing", {
      method: "POST",
      headers: {
        "X-Emby-Authorization": `MediaBrowser Client="Moonfin", Token="${adminToken}"`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: 10000000,
        PlaySessionId: "session-1",
      }),
    });
    expect(playRes.status).toBe(200);

    const p1 = await callApp(app, env, "/Sessions/Playing/Progress", {
      method: "POST",
      headers: {
        "X-Emby-Authorization": `MediaBrowser Client="Moonfin", Token="${adminToken}"`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: 30000000,
        IsPaused: false,
        PlaySessionId: "session-1",
      }),
    });
    expect(p1.status).toBe(200);

    const p2 = await callApp(app, env, "/Sessions/Playing/Progress", {
      method: "POST",
      headers: {
        "X-Emby-Authorization": `MediaBrowser Client="Moonfin", Token="${adminToken}"`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: 50000000,
        IsPaused: false,
        PlaySessionId: "session-1",
      }),
    });
    expect(p2.status).toBe(200);

    const pauseRes = await callApp(app, env, "/Sessions/Playing/Progress", {
      method: "POST",
      headers: {
        "X-Emby-Authorization": `MediaBrowser Client="Moonfin", Token="${adminToken}"`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ItemId: itemId,
        PositionTicks: 60000000,
        IsPaused: true,
        PlaySessionId: "session-1",
      }),
    });
    expect(pauseRes.status).toBe(200);

    expect(await readWatchPosition(db, admin.id, "movie:tt1234567")).toBe(60000000);
  });
});
