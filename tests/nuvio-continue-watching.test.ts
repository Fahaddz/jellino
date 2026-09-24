import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { saveNuvioAccount } from "../src/nuvio";
import {
  applyNuvioWatchSnapshot,
  readTombstones,
  recordTombstone,
  refreshNuvioWatch,
  resetNuvioWatchState,
  type NuvioWatchProgressRpc,
  type NuvioWatchedItemRpc,
} from "../src/nuvio-home";
import { readWatchEntry, writeWatchPosition } from "../src/watch-state";
import { encodeItem } from "../src/ids";
import { callApp, createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";
const NOW = Math.floor(Date.now() / 1000);

interface NuvioNet {
  snapshot: NuvioWatchProgressRpc[];
  watched: NuvioWatchedItemRpc[];
  snapshotCalls: number;
  watchedCalls: number;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function installNuvioNet(overrides: Partial<NuvioNet> = {}): NuvioNet {
  const state: NuvioNet = {
    snapshot: [],
    watched: [],
    snapshotCalls: 0,
    watchedCalls: 0,
    ...overrides,
  };
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/rpc/sync_pull_watch_progress")) {
      state.snapshotCalls += 1;
      return jsonResponse(state.snapshot);
    }
    if (url.endsWith("/rpc/sync_pull_watched_items")) {
      state.watchedCalls += 1;
      return jsonResponse(state.watched);
    }
    if (url.includes("/rpc/sync_push_")) return jsonResponse({});
    if (url.includes("/rest/v1/")) return jsonResponse([]);
    return new Response("down", { status: 500 });
  };
  return state;
}

const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;
const realCaches = (globalThis as unknown as Record<string, unknown>).caches;

function installCaches(): void {
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
}

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).fetch;
  installCaches();
  resetNuvioWatchState();
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).fetch = realFetch;
  (globalThis as unknown as Record<string, unknown>).caches = realCaches;
  resetNuvioWatchState();
});

async function household() {
  const raw = createFakeDb();
  const db = raw as unknown as Db;
  const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
  raw.addons.push({ profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 });
  await db.prepare("UPDATE profiles SET nuvio_profile_index = 0 WHERE id = ?").bind(admin.id).run();
  await saveNuvioAccount(db, {
    email: "user@nuvio.tv",
    access_token: "mock-token",
    refresh_token: "mock-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    last_sync: 0,
  });
  return { raw, db, adminId: admin.id };
}

function authHeader(token: string): Record<string, string> {
  return { "X-Emby-Authorization": `MediaBrowser Client="test", Token="${token}"` };
}

function movieEntry(overrides: Partial<NuvioWatchProgressRpc> = {}): NuvioWatchProgressRpc {
  return {
    content_id: "tt100",
    content_type: "movie",
    video_id: "tt100",
    season: null,
    episode: null,
    position: 1000,
    duration: 2000,
    last_watched: NOW * 1000,
    progress_key: "tt100",
    ...overrides,
  };
}

describe("nuvio continue watching sync", () => {
  it("imports snapshot progress on a forced refresh", async () => {
    const { db, adminId } = await household();
    installNuvioNet({ snapshot: [movieEntry()] });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    const row = await readWatchEntry(db, adminId, "movie:tt100");
    expect(row?.positionTicks).toBe(10_000_000);
  });

  it("keeps a newer local position over an older remote snapshot", async () => {
    const { db, adminId } = await household();
    await writeWatchPosition(db, adminId, "movie:tt100", 900_000_000, NOW);
    installNuvioNet({
      snapshot: [movieEntry({ last_watched: (NOW - 3600) * 1000, position: 1000 })],
    });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    expect((await readWatchEntry(db, adminId, "movie:tt100"))?.positionTicks).toBe(900_000_000);
  });

  it("does not resurrect a tombstoned item from an older remote snapshot", async () => {
    const { db, adminId } = await household();
    await recordTombstone(db, adminId, "progress", "movie:tt100", NOW);
    installNuvioNet({
      snapshot: [movieEntry({ last_watched: (NOW - 3600) * 1000 })],
    });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    expect(await readWatchEntry(db, adminId, "movie:tt100")).toBeNull();
  });

  it("clears the tombstone when Nuvio reports a newer watch", async () => {
    const { db, adminId } = await household();
    await recordTombstone(db, adminId, "progress", "movie:tt100", NOW - 3600);
    installNuvioNet({ snapshot: [movieEntry()] });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    expect((await readWatchEntry(db, adminId, "movie:tt100"))?.positionTicks).toBe(10_000_000);
    expect((await readTombstones(db, adminId, "progress")).has("movie:tt100")).toBe(false);
  });

  it("single-flights concurrent refreshes per profile", async () => {
    const { db, adminId } = await household();
    const net = installNuvioNet({ snapshot: [movieEntry()] });
    await Promise.all([
      refreshNuvioWatch(db, fetch, adminId, NOW, { force: true }),
      refreshNuvioWatch(db, fetch, adminId, NOW, { force: true }),
    ]);
    expect(net.snapshotCalls).toBe(1);
  });

  it("skips merging when the snapshot fingerprint is unchanged", async () => {
    const { raw, db, adminId } = await household();
    installNuvioNet({ snapshot: [movieEntry()] });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    const writes = raw.counts.writes;
    await refreshNuvioWatch(db, fetch, adminId, NOW + 5, { force: true });
    expect(raw.counts.writes).toBe(writes);
  });

  it("clears a stale local resume row on reconcile", async () => {
    const { db, adminId } = await household();
    await writeWatchPosition(db, adminId, "movie:tt100", 600_000_000, NOW - 1000);
    const result = await applyNuvioWatchSnapshot(db, adminId, [], [], [], NOW);
    expect(result.cleared).toBe(1);
    expect((await readWatchEntry(db, adminId, "movie:tt100"))?.positionTicks).toBe(0);
  });

  it("keeps a locally written row inside the reconcile write guard", async () => {
    const { db, adminId } = await household();
    await writeWatchPosition(db, adminId, "movie:tt100", 600_000_000, NOW);
    const result = await applyNuvioWatchSnapshot(db, adminId, [], [], [], NOW);
    expect(result.cleared).toBe(0);
    expect((await readWatchEntry(db, adminId, "movie:tt100"))?.positionTicks).toBe(600_000_000);
  });

  it("does not clear local-only non-IMDb progress on reconcile", async () => {
    const { db, adminId } = await household();
    await writeWatchPosition(db, adminId, "movie:tmdb:42", 600_000_000, NOW - 1000);
    const result = await applyNuvioWatchSnapshot(db, adminId, [], [], [], NOW);
    expect(result.cleared).toBe(0);
    expect(await readWatchEntry(db, adminId, "movie:tmdb:42")).not.toBeNull();
  });

  it("keeps a tombstoned local row during reconcile", async () => {
    const { db, adminId } = await household();
    await writeWatchPosition(db, adminId, "movie:tt100", 600_000_000, NOW - 1000);
    await recordTombstone(db, adminId, "progress", "movie:tt100", NOW - 500);
    const result = await applyNuvioWatchSnapshot(db, adminId, [], [], [], NOW);
    expect(result.cleared).toBe(0);
    expect((await readWatchEntry(db, adminId, "movie:tt100"))?.positionTicks).toBe(600_000_000);
  });

  it("hides an item removed in Nuvio from the Resume response", async () => {
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, NOW);
    await writeWatchPosition(db, adminId, "movie:tt100", 600_000_000, NOW - 1000);
    installNuvioNet();
    const app = createApp();
    const env = testEnv(raw);

    const before = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(((await before.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(1);

    await applyNuvioWatchSnapshot(db, adminId, [], [], [], NOW);

    const after = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(((await after.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(0);
  });

  it("clears progress and records a tombstone when hidden through the Jellyfin route", async () => {
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, NOW);
    const id = encodeItem("https://alpha.example", "movie", "tt100");
    await writeWatchPosition(db, adminId, "movie:tt100", 600_000_000, NOW - 1000);
    installNuvioNet();

    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/ExcludeContinueWatching/${id}`, {
      method: "POST",
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    expect((await readWatchEntry(db, adminId, "movie:tt100"))?.positionTicks).toBe(0);
    expect((await readTombstones(db, adminId, "progress")).has("movie:tt100")).toBe(true);

    const resume = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    expect(((await resume.json()) as { TotalRecordCount: number }).TotalRecordCount).toBe(0);
  });
  it("shows one continue-watching row per series, not one per episode", async () => {
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, NOW);
    installNuvioNet();
    await writeWatchPosition(db, adminId, "episode:tt200:1:1", 600_000_000, NOW - 200);
    await writeWatchPosition(db, adminId, "episode:tt200:1:2", 600_000_000, NOW - 100);
    await writeWatchPosition(db, adminId, "episode:tt201:1:1", 600_000_000, NOW - 300);

    const res = await callApp(createApp(), testEnv(raw), `/Users/${adminId}/Items/Resume`, { headers: authHeader(token) });
    const body = (await res.json()) as { TotalRecordCount: number };
    expect(body.TotalRecordCount).toBe(2);
  });
});
