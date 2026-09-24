import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeEpisode, encodeItem } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";

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
    if (url === `${ALPHA}/meta/series/tt200.json`) {
      return Response.json({
        meta: {
          id: "tt200",
          type: "series",
          name: "Airing Show",
          videos: [
            { season: 1, episode: 1, title: "Pilot", released: "2020-01-01" },
            { season: 2, episode: 1, title: "Future One", released: "2099-01-05" },
            { season: 2, episode: 2, title: "Future Two", released: "2099-02-01" },
          ],
        },
      });
    }
    if (url === `${ALPHA}/meta/series/tt300.json`) {
      return Response.json({
        meta: {
          id: "tt300",
          type: "series",
          name: "Favorite Show",
          videos: [{ season: 1, number: 1, title: "Numbered Future", released: "2099-03-01" }],
        },
      });
    }
    return new Response("down", { status: 500 });
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

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 });
  return { raw, db, adminId: admin.id };
}

function liveToken(db: Db, profileId: string): Promise<string> {
  return issueToken(db, profileId, Math.floor(Date.now() / 1000));
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

async function watchEpisode(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof testEnv>,
  token: string,
  episode: string,
): Promise<void> {
  await callApp(app, env, "/Sessions/Playing/Stopped", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json" },
    body: JSON.stringify({ ItemId: episode, PositionTicks: 5_000_000_000 }),
  });
}

describe("upcoming episodes", () => {
  it("lists future episodes of watched series ordered by air date", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    await watchEpisode(app, env, token, encodeEpisode(ALPHA, "tt200", 1, 1));

    const res = await callApp(app, env, `/Shows/Upcoming?userId=${adminId}`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      Items: { Name: string; Type: string; SeriesName: string; IndexNumber: number; PremiereDate: string; UserData: { Key: string } }[];
      TotalRecordCount: number;
      StartIndex: number;
    };
    expect(body.TotalRecordCount).toBe(2);
    expect(body.Items.map((item) => item.Name)).toEqual(["Future One", "Future Two"]);
    expect(body.Items[0]?.SeriesName).toBe("Airing Show");
    expect(body.Items[0]?.Type).toBe("Episode");
    expect(body.Items[0]?.IndexNumber).toBe(1);
    expect(body.Items[0]?.PremiereDate).toBe("2099-01-05T00:00:00.000Z");
    expect(body.Items[0]?.UserData.Key).toBeTruthy();
    expect(body.StartIndex).toBe(0);
  });

  it("pages the list and includes favorited number-only series", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    await watchEpisode(app, env, token, encodeEpisode(ALPHA, "tt200", 1, 1));
    const favorite = encodeItem(ALPHA, "series", "tt300");
    await callApp(app, env, `/UserFavoriteItems/${favorite}`, { method: "POST", headers: authHeader(token) });

    const limited = await callApp(app, env, `/Shows/Upcoming?userId=${adminId}&Limit=1`, { headers: authHeader(token) });
    const limitedBody = (await limited.json()) as { Items: { Name: string }[]; TotalRecordCount: number };
    expect(limitedBody.TotalRecordCount).toBe(3);
    expect(limitedBody.Items).toHaveLength(1);
    expect(limitedBody.Items[0]?.Name).toBe("Future One");

    const scoped = await callApp(app, env, `/Users/${adminId}/Items/Upcoming`, { headers: authHeader(token) });
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { Items: { Name: string; SeriesName: string }[]; TotalRecordCount: number };
    expect(scopedBody.TotalRecordCount).toBe(3);
    expect(scopedBody.Items.map((item) => item.Name)).toContain("Numbered Future");
    expect(scopedBody.Items.find((item) => item.Name === "Numbered Future")?.SeriesName).toBe("Favorite Show");
  });

  it("returns empty rows for fresh profiles and requires a token", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const anon = await callApp(app, env, `/Users/${adminId}/Items/Upcoming`);
    expect(anon.status).toBe(401);
    const res = await callApp(app, env, `/Shows/Upcoming?userId=${adminId}`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(0);
  });

  it("answers the same routes with a trailing slash", async () => {
    installNet();
    const { raw, db, adminId } = await household();
    const token = await liveToken(db, adminId);
    const app = createApp();
    const env = testEnv(raw);
    const upcoming = await callApp(app, env, `/Shows/Upcoming/?userId=${adminId}`, { headers: authHeader(token) });
    expect(upcoming.status).toBe(200);
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume/`, { headers: authHeader(token) });
    expect(resume.status).toBe(200);
  });
});
