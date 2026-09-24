import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodePerson } from "../src/ids";
import { readSetting } from "../src/db";
import { seasonPoster, type StremioMeta } from "../src/meta";
import { parsedAudioTags } from "../src/streams";
import { TMDB_API_KEY_SETTING } from "../src/people";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const authHeader = (token: string) => ({ "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` });

function installTmdbNet() {
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
    if (url.includes("/search/person")) {
      expect(url).toContain("api_key=tmdb-key-1");
      return Response.json({ results: [{ id: 31, name: "Tom Hanks", profile_path: "/hank.jpg", popularity: 99 }] });
    }
    if (url.includes("/person/31")) {
      return Response.json({
        name: "Tom Hanks",
        profile_path: "/hank.jpg",
        biography: "American actor and filmmaker.",
        birthday: "1956-07-09",
        deathday: null,
        place_of_birth: "Concord, California, USA",
      });
    }
    return new Response("down", { status: 500 });
  };
}

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const created = await registerFirstUser(db, "dad", "supersecret1", 1000);
  const token = await issueToken(db, (created.body as { id: string }).id, Math.floor(Date.now() / 1000));
  return { raw, db, adminId: (created.body as { id: string }).id, token };
}

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).caches;
  delete (globalThis as unknown as Record<string, unknown>).fetch;
});

describe("metadata parity extras", () => {
  it("fills person pages from TMDB when a key is set", async () => {
    installTmdbNet();
    const { raw, db, adminId, token } = await household();
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(TMDB_API_KEY_SETTING, "tmdb-key-1").run();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodePerson("Tom Hanks");

    const res = await callApp(app, env, `/Items/${id}?userId=${adminId}`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      Name: "Tom Hanks",
      Type: "Person",
      Overview: "American actor and filmmaker.",
      PremiereDate: "1956-07-09T00:00:00.000Z",
      ProductionLocations: ["Concord, California, USA"],
      ImageTags: { Primary: "p" },
    });
    expect(body.EndDate).toBeUndefined();

    const image = await callApp(app, env, `/Items/${id}/Images/Primary`, { headers: authHeader(token) });
    expect(image.status).toBe(302);
    expect(image.headers.get("location")).toBe("https://image.tmdb.org/t/p/h632/hank.jpg");
  });

  it("serves the bare person stub without a TMDB key", async () => {
    installTmdbNet();
    const { raw, adminId, token } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodePerson("Tom Hanks");

    const res = await callApp(app, env, `/Items/${id}?userId=${adminId}`, { headers: authHeader(token) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ Name: "Tom Hanks", Type: "Person", Overview: "" });
    expect(body.PremiereDate).toBeUndefined();
  });

  it("prefers app_extras.seasonPosterByNumber for season art", () => {
    const meta = {
      id: "tt1",
      type: "series",
      name: "Show",
      app_extras: { seasonPosterByNumber: { "2": "https://img.example/s2.jpg" } },
      seasonPosters: { "2": "https://img.example/old.jpg" },
    } as StremioMeta;
    expect(seasonPoster(meta, 2)).toBe("https://img.example/s2.jpg");
  });

  it("derives Atmos and DTS profile labels from parsed stream data", () => {
    const atmos = parsedAudioTags({
      streamData: { parsedFile: { audioTracks: [{ codec: "truehd", atmos: true, channels: "5.1" }] } },
    } as never);
    expect(atmos?.profile).toBe("Dolby TrueHD + Dolby Atmos");
    expect(atmos?.audioCodec).toBe("truehd");

    const dts = parsedAudioTags({
      name: "Movie 2160p DTS-HD MA 7.1",
      streamData: { parsedFile: { audioTracks: [{ codec: "dts", channels: "7.1" }] } },
    } as never);
    expect(dts?.profile).toBe("DTS-HD MA");
  });

  it("stores the TMDB key through the settings API", async () => {
    installTmdbNet();
    const { raw, db, token } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const res = await callApp(app, env, "/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: JSON.stringify({ tmdbApiKey: "tmdb-key-1" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tmdbApiKey: string }).tmdbApiKey).toBe("tmdb-key-1");
    expect(await readSetting(db, TMDB_API_KEY_SETTING)).toBe("tmdb-key-1");
  });
});
