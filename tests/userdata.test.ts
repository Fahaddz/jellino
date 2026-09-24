import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { readWatchEntry } from "../src/watch-state";
import { encodeItem } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  const token = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
  return { raw, db, adminId: admin.id, token };
}

const auth = (token: string) => ({ "X-Emby-Authorization": `MediaBrowser Client="odin", Token="${token}"`, "content-type": "application/json" });

describe("client user data routes", () => {
  it("applies Played through /UserItems/:id/UserData", async () => {
    const { raw, db, adminId, token } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt900");

    const played = await callApp(app, env, `/UserItems/${id}/UserData`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ Played: true }),
    });
    expect(played.status).toBe(200);
    expect(((await played.json()) as { Played: boolean }).Played).toBe(true);

    const unplayed = await callApp(app, env, `/UserItems/${id}/UserData`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ Played: false }),
    });
    expect(((await unplayed.json()) as { Played: boolean }).Played).toBe(false);
  });

  it("stores PlaybackPositionTicks through the userId spelling", async () => {
    const { raw, db, adminId, token } = await household();
    const app = createApp();
    const env = testEnv(raw);
    const id = encodeItem(ALPHA, "movie", "tt901");

    const res = await callApp(app, env, `/Users/${adminId}/Items/${id}/UserData`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ PlaybackPositionTicks: 600000000 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { PlaybackPositionTicks: number }).PlaybackPositionTicks).toBe(600000000);
    expect((await readWatchEntry(db, adminId, "movie:tt901"))?.positionTicks).toBe(600000000);
  });

  it("answers the encoding configuration Odin probes", async () => {
    const { raw } = await household();
    const res = await callApp(createApp(), testEnv(raw), "/System/Configuration/encoding");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
