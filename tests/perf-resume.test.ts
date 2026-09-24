import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { encodeItem } from "../src/ids";
import { callApp, testEnv } from "./fake-db";
import { CINE, freshCounters, installPerfNet, perfAuth, saveGlobals, tmdbHousehold } from "./perf-net";

const realGlobals = saveGlobals();

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).caches;
  delete (globalThis as unknown as Record<string, unknown>).fetch;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).caches = realGlobals.caches;
  (globalThis as unknown as Record<string, unknown>).fetch = realGlobals.fetch;
});

describe("perf resume", () => {
  it("resolves resume rows concurrently", async () => {
    const counters = freshCounters();
    installPerfNet(counters, 1);
    const { raw, adminId, token } = await tmdbHousehold();
    const app = createApp();
    const env = testEnv(raw);
    const headers = { ...perfAuth(token), "content-type": "application/json" };
    for (const stremioId of ["tt201", "tt202", "tt203"]) {
      const itemId = encodeItem(CINE, "movie", stremioId);
      const progress = await callApp(app, env, "/Sessions/Playing/Progress", {
        method: "POST",
        headers,
        body: JSON.stringify({ ItemId: itemId, PositionTicks: 600000000 }),
      });
      expect(progress.status).toBe(200);
    }
    counters.urls.length = 0;
    counters.maxActive = 0;
    installPerfNet(counters, 1);
    counters.urls.length = 0;
    counters.maxActive = 0;
    const resume = await callApp(app, env, `/Users/${adminId}/Items/Resume`, { headers: perfAuth(token) });
    expect(resume.status).toBe(200);
    expect(((await resume.json()) as { Items: unknown[] }).Items).toHaveLength(3);
    expect(counters.maxActive).toBeGreaterThan(1);
  });
});
