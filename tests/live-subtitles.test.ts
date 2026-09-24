import { describe, expect, it } from "vitest";
import { registerFirstUser } from "../src/auth";
import { createFakeDb } from "./fake-db";
import { issueToken } from "../src/session";
import { fetchAddonSubtitles, subtitleBody } from "../src/subtitles";

type Db = import("@cloudflare/workers-types").D1Database;

const V3 = "https://opensubtitles-v3.strem.io";
const RUN = process.env.JELLINO_LIVE_TEST === "1";

function liveCache(): Cache {
  const store = new Map<string, string>();
  return {
    match: async (key: Request) => {
      const body = store.get(key.url);
      return body === undefined ? undefined : new Response(body);
    },
    put: async (key: Request, value: Response) => {
      store.set(key.url, await value.clone().text());
    },
    delete: async (key: Request) => store.delete(key.url),
  } as unknown as Cache;
}

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: V3, position: 0, enabled: 1 });
  const token = await issueToken(db, admin.id, Math.floor(Date.now() / 1000));
  void token;
  return { raw, db, adminId: admin.id };
}

describe.skipIf(!RUN)("live opensubtitles-v3 pipeline", () => {
  it(
    "lists series episode subtitles with fetchable http urls",
    async () => {
      const { db, adminId } = await household();
      void db;
      void adminId;
      const cache = liveCache();
      const found = await fetchAddonSubtitles(cache, fetch, V3, "series", "tt14688458:1:1", undefined);
      expect(found.length).toBeGreaterThan(0);
      for (const track of found.slice(0, 5)) {
        expect(track.url).toMatch(/^https?:\/\//);
      }
    },
    60000,
  );

  it(
    "downloads the first series subtitle as renderable cues",
    async () => {
      const cache = liveCache();
      const found = await fetchAddonSubtitles(cache, fetch, V3, "series", "tt14688458:1:1", undefined);
      expect(found.length).toBeGreaterThan(0);
      const first = found[0];
      if (!first) throw new Error("no subtitles");
      const vtt = await subtitleBody(cache, fetch, first.url, "vtt", first.lang);
      expect(vtt).not.toBeNull();
      expect((vtt?.body.match(/-->/g) ?? []).length).toBeGreaterThan(0);
      const json = await subtitleBody(cache, fetch, first.url, "json", first.lang);
      const parsed = JSON.parse(json?.body ?? "{}") as { TrackEvents: unknown[] };
      expect(parsed.TrackEvents.length).toBeGreaterThan(0);
    },
    60000,
  );

  it(
    "lists and downloads a movie subtitle",
    async () => {
      const cache = liveCache();
      const found = await fetchAddonSubtitles(cache, fetch, V3, "movie", "tt8946378", undefined);
      expect(found.length).toBeGreaterThan(0);
      const first = found[0];
      if (!first) throw new Error("no subtitles");
      const vtt = await subtitleBody(cache, fetch, first.url, "vtt", first.lang);
      expect(vtt).not.toBeNull();
      expect(vtt?.body).toContain("-->");
    },
    60000,
  );
});
