import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { issueToken } from "../src/session";
import { encodeItem } from "../src/ids";
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
import { readWatchPosition, writeWatchPosition } from "../src/watch-state";
import { createFakeDb, testEnv } from "./fake-db";

type Db = import("@cloudflare/workers-types").D1Database;

const ALPHA = "https://alpha.example";
const NOW = Math.floor(Date.now() / 1000);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

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

interface WatchedNet {
  watched: NuvioWatchedItemRpc[];
  progressSnapshot: NuvioWatchProgressRpc[];
  watchedPushes: number;
  watchedDeletes: number;
  progressPushes: number;
  progressDeletes: number;
  snapshotRequests: number;
}

function installWatchedNet(overrides: Partial<WatchedNet> = {}): WatchedNet {
  const state: WatchedNet = {
    watched: [],
    progressSnapshot: [],
    watchedPushes: 0,
    watchedDeletes: 0,
    progressPushes: 0,
    progressDeletes: 0,
    snapshotRequests: 0,
    ...overrides,
  };
  (globalThis as unknown as Record<string, unknown>).fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url === `${ALPHA}/meta/movie/tt100.json`) {
      return jsonResponse({ meta: { id: "tt100", type: "movie", name: "Film", runtime: "120 min" } });
    }
    if (url.endsWith("/rpc/sync_pull_watch_progress")) {
      state.snapshotRequests += 1;
      return jsonResponse(state.progressSnapshot);
    }
    if (url.endsWith("/rpc/sync_pull_watched_items")) {
      state.snapshotRequests += 1;
      return jsonResponse(state.watched);
    }
    if (url.endsWith("/rpc/sync_push_watched_items")) {
      state.watchedPushes += 1;
      return jsonResponse({});
    }
    if (url.endsWith("/rpc/sync_push_watch_progress")) {
      state.progressPushes += 1;
      return jsonResponse({});
    }
    if (url.endsWith("/rpc/sync_push_library_items")) return jsonResponse({});
    if (url.includes("/rest/v1/profile_watched") && method === "DELETE") {
      state.watchedDeletes += 1;
      return jsonResponse([]);
    }
    if (url.includes("/rest/v1/profile_watch_progress") && method === "DELETE") {
      state.progressDeletes += 1;
      return jsonResponse([]);
    }
    if (url.includes("/rest/v1/")) return jsonResponse([]);
    return new Response("down", { status: 500 });
  };
  return state;
}

const realFetch = (globalThis as unknown as Record<string, unknown>).fetch;
const realCaches = (globalThis as unknown as Record<string, unknown>).caches;

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

function pendingContext(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (task: Promise<unknown>) => {
      pending.push(task);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

function watchedEntry(overrides: Partial<NuvioWatchedItemRpc> = {}): NuvioWatchedItemRpc {
  return {
    content_id: "tt900",
    content_type: "movie",
    title: "Film",
    season: null,
    episode: null,
    watched_at: NOW * 1000,
    ...overrides,
  };
}

describe("nuvio watched history sync", () => {
  it("marks an item watched from the snapshot pull", async () => {
    const { raw, db, adminId } = await household();
    installWatchedNet({ watched: [watchedEntry()] });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    const row = raw.watch.get(`${adminId}\nmovie:tt900`);
    expect(row?.played).toBe(1);
    expect(row?.positionTicks).toBe(0);
  });

  it("keeps local progress when a timestamp-less watched snapshot arrives", async () => {
    const { raw, db, adminId } = await household();
    await writeWatchPosition(db, adminId, "movie:tt900", 4_000_000_000, NOW - 30);
    installWatchedNet({ watched: [watchedEntry({ watched_at: 0 })] });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    const row = raw.watch.get(`${adminId}\nmovie:tt900`);
    expect(row?.played).toBe(0);
    expect(row?.positionTicks).toBe(4_000_000_000);
  });

  it("unmarks a watched item on reconcile when Nuvio no longer has it", async () => {
    const { raw, db, adminId } = await household();
    raw.watch.set(`${adminId}\nmovie:tt901`, { positionTicks: 0, played: 1, playCount: 1, updatedAt: NOW - 3600 });
    const result = await applyNuvioWatchSnapshot(db, adminId, [], [], [], NOW);
    expect(result.unwatched).toBe(1);
    expect(raw.watch.get(`${adminId}\nmovie:tt901`)?.played).toBe(0);
  });

  it("keeps a watched row protected by a newer tombstone during reconcile", async () => {
    const { raw, db, adminId } = await household();
    raw.watch.set(`${adminId}\nmovie:tt901`, { positionTicks: 0, played: 1, playCount: 1, updatedAt: NOW - 1000 });
    await recordTombstone(db, adminId, "watched", "movie:tt901", NOW - 500);
    const result = await applyNuvioWatchSnapshot(db, adminId, [], [], [], NOW);
    expect(result.unwatched).toBe(0);
    expect(raw.watch.get(`${adminId}\nmovie:tt901`)?.played).toBe(1);
  });

  it("ignores series-level watched entries without episode identity", async () => {
    const { raw, db, adminId } = await household();
    installWatchedNet({ watched: [watchedEntry({ content_id: "tt902", content_type: "series" })] });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    expect(raw.watch.get(`${adminId}\nseries:tt902`)).toBeUndefined();
  });

  it("pushes watched state and deletes progress when marked watched in Moonfin", async () => {
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, NOW);
    const net = installWatchedNet();
    await writeWatchPosition(db, adminId, "movie:tt100", 4_000_000_000, NOW - 60);
    const app = createApp();
    const { ctx, pending } = pendingContext();

    const res = await app.fetch(
      new Request(`http://localhost/UserPlayedItems/${encodeItem(ALPHA, "movie", "tt100")}`, {
        method: "POST",
        headers: authHeader(token),
      }),
      testEnv(raw),
      ctx,
    );

    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(raw.watch.get(`${adminId}\nmovie:tt100`)?.played).toBe(1);
    expect(await readWatchPosition(db, adminId, "movie:tt100")).toBe(0);
    expect(net.watchedPushes).toBe(1);
    expect(net.progressDeletes).toBe(1);
    expect((await readTombstones(db, adminId, "progress")).has("movie:tt100")).toBe(true);
  });

  it("pushes watched deletion and records tombstones when unmarked in Moonfin", async () => {
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, NOW);
    const net = installWatchedNet();
    raw.watch.set(`${adminId}\nmovie:tt100`, { positionTicks: 0, played: 1, playCount: 1, updatedAt: NOW - 3600 });
    const app = createApp();
    const { ctx, pending } = pendingContext();

    const res = await app.fetch(
      new Request(`http://localhost/UserPlayedItems/${encodeItem(ALPHA, "movie", "tt100")}`, {
        method: "DELETE",
        headers: authHeader(token),
      }),
      testEnv(raw),
      ctx,
    );

    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(raw.watch.get(`${adminId}\nmovie:tt100`)?.played).toBe(0);
    expect(net.watchedDeletes).toBe(1);
    expect(net.progressDeletes).toBe(1);
    expect((await readTombstones(db, adminId, "watched")).has("movie:tt100")).toBe(true);
    expect((await readTombstones(db, adminId, "progress")).has("movie:tt100")).toBe(true);
  });

  it("marks watched, clears progress, and deletes the remote progress row on playback completion", async () => {
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, NOW);
    const net = installWatchedNet();
    const app = createApp();
    const env = testEnv(raw);
    const movie = encodeItem(ALPHA, "movie", "tt100");
    const { ctx, pending } = pendingContext();

    const res = await app.fetch(
      new Request("http://localhost/Sessions/Playing/Stopped", {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ ItemId: movie, PositionTicks: 70_000_000_000 }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    await Promise.all(pending);
    const row = raw.watch.get(`${adminId}\nmovie:tt100`);
    expect(row?.played).toBe(1);
    expect(row?.positionTicks).toBe(0);
    expect(net.watchedPushes).toBe(1);
    expect(net.progressDeletes).toBe(1);
    expect(net.progressPushes).toBe(0);
  });

  it("pushes progress immediately when playback starts", async () => {
    const { raw, db, adminId } = await household();
    const token = await issueToken(db, adminId, NOW);
    const net = installWatchedNet();
    const app = createApp();
    const movie = encodeItem(ALPHA, "movie", "tt100");
    const { ctx, pending } = pendingContext();

    const res = await app.fetch(
      new Request("http://localhost/Sessions/Playing", {
        method: "POST",
        headers: { ...authHeader(token), "content-type": "application/json" },
        body: JSON.stringify({ ItemId: movie, PositionTicks: 0 }),
      }),
      testEnv(raw),
      ctx,
    );

    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(net.progressPushes).toBe(1);
  });
  it("imports a remote watched mark even when a local progress write came after it", async () => {
    const { raw, db, adminId } = await household();
    await writeWatchPosition(db, adminId, "episode:tt900:2:1", 4_000_000_000, NOW - 300);
    installWatchedNet({
      watched: [watchedEntry({ content_id: "tt900", content_type: "series", season: 2, episode: 1, watched_at: (NOW - 600) * 1000 })],
    });
    await refreshNuvioWatch(db, fetch, adminId, NOW, { force: true });
    const row = raw.watch.get(`${adminId}\nepisode:tt900:2:1`);
    expect(row?.played).toBe(1);
    expect(row?.positionTicks).toBe(0);
  });
});
