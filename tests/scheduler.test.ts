import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { registerFirstUser } from "../src/auth";
import { serverSecret } from "../src/session";
import {
  SCHEDULE_INTERVAL_MS,
  SCHEDULER_ENSURE_URL,
  SCHEDULER_OBJECT_NAME,
  SCHEDULER_RUN_URL,
  SchedulerDO,
  ensureScheduledRun,
} from "../src/scheduler";
import { callApp, createFakeDb, testEnv } from "./fake-db";
import type { Env } from "../src/db";

type Db = import("@cloudflare/workers-types").D1Database;
type DoState = import("@cloudflare/workers-types").DurableObjectState;
type Execution = import("@cloudflare/workers-types").ExecutionContext;

const ALPHA = "https://alpha.example";

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

function installNet(manifestCalls: string[]) {
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
    manifestCalls.push(url);
    if (url === `${ALPHA}/manifest.json`) {
      return new Response(JSON.stringify({ catalogs: [{ type: "movie", id: "top", name: "Top" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("down", { status: 500 });
  };
}

function fakeState(initial: number | null = null) {
  let alarm = initial;
  const state = {
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => {
        alarm = time;
      },
    },
  } as unknown as DoState;
  return { state, alarm: () => alarm };
}

function schedulerEnv(db: Db, selfFetch: (url: string, init?: RequestInit) => Promise<Response>) {
  return {
    DB: db,
    ASSETS: {} as never,
    SELF: { fetch: selfFetch } as never,
  } as unknown as Env;
}

function executionContext(): { ctx: Execution; promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => promises.push(p) } as unknown as Execution, promises };
}

describe("scheduler durable object", () => {
  it("arms the alarm when none is set", async () => {
    const { state, alarm } = fakeState(null);
    const db = createFakeDb() as unknown as Db;
    const worker = new SchedulerDO(state, schedulerEnv(db, async () => new Response(null, { status: 202 })));
    const before = Date.now();
    const res = await worker.fetch(new Request(SCHEDULER_ENSURE_URL));
    expect(res.status).toBe(204);
    const armed = alarm();
    expect(armed).not.toBeNull();
    expect(armed as number).toBeGreaterThanOrEqual(before + SCHEDULE_INTERVAL_MS - 1000);
    expect(armed as number).toBeLessThanOrEqual(Date.now() + SCHEDULE_INTERVAL_MS + 1000);
  });

  it("keeps an alarm that is still in the future", async () => {
    const existing = Date.now() + 60_000;
    const { state, alarm } = fakeState(existing);
    const db = createFakeDb() as unknown as Db;
    const worker = new SchedulerDO(state, schedulerEnv(db, async () => new Response(null, { status: 202 })));
    await worker.fetch(new Request(SCHEDULER_ENSURE_URL));
    expect(alarm()).toBe(existing);
  });

  it("replaces a stale alarm that already fired", async () => {
    const { state, alarm } = fakeState(Date.now() - 1000);
    const db = createFakeDb() as unknown as Db;
    const worker = new SchedulerDO(state, schedulerEnv(db, async () => new Response(null, { status: 202 })));
    await worker.fetch(new Request(SCHEDULER_ENSURE_URL));
    expect(alarm() as number).toBeGreaterThan(Date.now());
  });

  it("re-arms before running and calls the runner with the server secret", async () => {
    const { state, alarm } = fakeState(null);
    const db = createFakeDb() as unknown as Db;
    const calls: { url: string; auth: string | undefined }[] = [];
    const env = schedulerEnv(db, async (url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined });
      return new Response(null, { status: 202 });
    });
    const worker = new SchedulerDO(state, env);
    await worker.alarm();
    expect(alarm() as number).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SCHEDULER_RUN_URL);
    expect(calls[0]?.auth).toBe(`Bearer ${await serverSecret(db)}`);
  });

  it("keeps the chain alive when the runner fails", async () => {
    const { state, alarm } = fakeState(null);
    const db = createFakeDb() as unknown as Db;
    const env = schedulerEnv(db, async () => {
      throw new Error("upstream down");
    });
    const worker = new SchedulerDO(state, env);
    await expect(worker.alarm()).resolves.toBeUndefined();
    expect(alarm() as number).toBeGreaterThan(Date.now());
  });

  it("bootstraps the alarm from an incoming request", async () => {
    const db = createFakeDb() as unknown as Db;
    const armed: string[] = [];
    const env = {
      DB: db,
      ASSETS: {} as never,
      SCHEDULER: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (input: RequestInfo) => {
            armed.push(String(input instanceof Request ? input.url : input));
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as unknown as Env;
    const { ctx, promises } = executionContext();
    ensureScheduledRun(env, ctx);
    await Promise.all(promises);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toBe(SCHEDULER_ENSURE_URL);
    expect(SCHEDULER_OBJECT_NAME).toBe("scheduler");
  });
});

describe("scheduled run endpoint", () => {
  it("rejects callers without the server secret", async () => {
    const raw = createFakeDb();
    const app = createApp();
    const res = await callApp(app, testEnv(raw), "/__internal/scheduled", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("runs the scheduled job for the scheduler", async () => {
    const manifestCalls: string[] = [];
    installNet(manifestCalls);
    const raw = createFakeDb();
    const db = raw as unknown as Db;
    const admin = (await registerFirstUser(db, "dad", "supersecret1", 1000)).body as { id: string };
    raw.addons.push({ profile_id: admin.id, url: ALPHA, position: 0, enabled: 1 });
    const app = createApp();
    const secret = await serverSecret(db);
    const res = await callApp(app, testEnv(raw), "/__internal/scheduled", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(202);
    expect(manifestCalls).toContain(`${ALPHA}/manifest.json`);
  });
});
