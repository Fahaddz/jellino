import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const CINE = "https://cine.example";

function installNet() {
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
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${CINE}/manifest.json`) {
      return Response.json({ catalogs: [{ type: "movie", id: "top", name: "Top" }] });
    }
    return new Response("missing", { status: 404 });
  };
}

const realCaches = (globalThis as unknown as Record<string, unknown>).caches;
const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).caches;
  delete (globalThis as unknown as Record<string, unknown>).fetch;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).caches = realCaches;
  (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
});

describe("compat stubs", () => {
  it("answers empty shapes without touching D1", async () => {
    const raw = createFakeDb();
    const app = createApp();
    const env = testEnv(raw);
    const persons = (await (await callApp(app, env, "/Persons?userId=x")).json()) as Record<string, unknown>;
    expect(persons).toMatchObject({ Items: [], TotalRecordCount: 0 });
    expect(await (await callApp(app, env, "/Items/abc/LocalTrailers")).json()).toEqual([]);
    expect(await (await callApp(app, env, "/Items/abc/SpecialFeatures")).json()).toEqual([]);
    expect(await (await callApp(app, env, "/Videos/abc/AdditionalParts")).json()).toMatchObject({ Items: [] });
    expect((await callApp(app, env, "/Sessions/Playing/Ping", { method: "POST" })).status).toBe(204);
    expect(await (await callApp(app, env, "/Items/abc/Intros")).json()).toMatchObject({ Items: [] });
    expect(await (await callApp(app, env, "/Users/x/Items/abc/Intros")).json()).toMatchObject({ Items: [] });
    expect(await (await callApp(app, env, "/Items/abc/ThemeSongs")).json()).toMatchObject({ Items: [] });
    expect(await (await callApp(app, env, "/Items/abc/ThemeVideos")).json()).toMatchObject({ Items: [] });
    expect(await (await callApp(app, env, "/Items/abc/ThemeMedia")).json()).toMatchObject({
      ThemeVideosResult: { Items: [] },
      ThemeSongsResult: { Items: [] },
      SoundtrackSongsResult: { Items: [] },
    });
    expect(await (await callApp(app, env, "/Branding/Configuration")).json()).toMatchObject({
      SplashscreenEnabled: false,
      CustomCss: "",
    });
    expect((await callApp(app, env, "/Branding/Css")).status).toBe(200);
    expect((await callApp(app, env, "/Branding/Css.css")).status).toBe(200);

    const utcRes = await callApp(app, env, "/GetUtcTime");
    expect(utcRes.status).toBe(200);
    const utcData = (await utcRes.json()) as { RequestReceptionTime: string; ResponseTransmissionTime: string };
    expect(utcData.RequestReceptionTime).toBeTruthy();
    expect(utcData.ResponseTransmissionTime).toBeTruthy();

    const syncPlayRes = await callApp(app, env, "/SyncPlay/List");
    expect(syncPlayRes.status).toBe(200);
    expect(await syncPlayRes.json()).toEqual([]);

    expect(await (await callApp(app, env, "/Localization/Options")).json()).toEqual([
      { Name: "English", Value: "en-us" },
    ]);
    expect(await (await callApp(app, env, "/Localization/Countries")).json()).toEqual([
      { Name: "United States", DisplayName: "United States", TwoLetterISORegionName: "US", ThreeLetterISORegionName: "USA" },
    ]);
    expect(await (await callApp(app, env, "/Localization/Cultures")).json()).toEqual([
      { Name: "English", DisplayName: "English", TwoLetterISOLanguageName: "en", ThreeLetterISOLanguageName: "eng", ThreeLetterISOLanguageNames: ["eng"] },
    ]);
    expect(await (await callApp(app, env, "/Localization/ParentalRatings")).json()).toEqual([]);

    expect(await (await callApp(app, env, "/System/Endpoint")).json()).toMatchObject({ IsLocal: false });
    expect(await (await callApp(app, env, "/ScheduledTasks")).json()).toEqual([]);
    expect(await (await callApp(app, env, "/Plugins")).json()).toEqual([]);
    expect((await callApp(app, env, "/ClientLog/Document", { method: "POST", body: "{}" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/Capabilities/Full", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/sess-1/Capabilities/Full", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/Capabilities", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/sess-1/Capabilities", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/Viewing", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/sess-1/Viewing", { method: "POST" })).status).toBe(204);
    expect(await (await callApp(app, env, "/Sessions")).json()).toEqual([]);
    expect(await (await callApp(app, env, "/UserViews/GroupingOptions")).json()).toEqual([]);
    expect(await (await callApp(app, env, "/Users/u-1/GroupingOptions")).json()).toEqual([]);
    expect((await callApp(app, env, "/Users/u-1/Configuration", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Users/u-1/Policy", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/Logout", { method: "POST" })).status).toBe(204);
    expect((await callApp(app, env, "/Sessions/LogoutById", { method: "POST" })).status).toBe(204);
    expect(await (await callApp(app, env, "/LiveTv/Channels")).json()).toMatchObject({ Items: [], TotalRecordCount: 0 });
    expect(await (await callApp(app, env, "/LiveTv/Programs")).json()).toMatchObject({ Items: [], TotalRecordCount: 0 });
    expect(await (await callApp(app, env, "/LiveTv/Recordings")).json()).toMatchObject({ Items: [], TotalRecordCount: 0 });
    expect(await (await callApp(app, env, "/LiveTv/TunerHosts")).json()).toEqual([]);
    expect(await (await callApp(app, env, "/LiveTv/ListingProviders")).json()).toEqual([]);
    expect(await (await callApp(app, env, "/LiveTv/Info")).json()).toMatchObject({ IsEnabled: false });
  });

  it("derives virtual folders from the profile library behind the token", async () => {
    installNet();
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: admin.id, url: CINE, position: 0, enabled: 1 });
    const token = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
    const app = createApp();
    const env = testEnv(raw);
    const anon = await callApp(app, env, "/Library/VirtualFolders");
    expect(anon.status).toBe(401);
    const folders = await callApp(app, env, `/Library/VirtualFolders?userId=${admin.id}`, {
      headers: { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` },
    });
    expect(folders.status).toBe(200);
  });
});
