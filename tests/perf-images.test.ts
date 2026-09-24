import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { encodeItem } from "../src/ids";
import { callApp, testEnv } from "./fake-db";
import { freshCounters, installPerfNet, perfAuth, saveGlobals, tmdbCalls, tmdbHousehold, CINE } from "./perf-net";

const realGlobals = saveGlobals();

beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).caches;
  delete (globalThis as unknown as Record<string, unknown>).fetch;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).caches = realGlobals.caches;
  (globalThis as unknown as Record<string, unknown>).fetch = realGlobals.fetch;
});

describe("perf images", () => {
  it("edge-caches image redirects with a week-long cache-control", async () => {
    const counters = freshCounters();
    installPerfNet(counters, 0);
    const { raw, token } = await tmdbHousehold();
    const app = createApp();
    const env = testEnv(raw);
    const headers = perfAuth(token);
    const id = encodeItem(CINE, "movie", "tt1");
    const first = await callApp(app, env, `/Items/${id}/Images/Primary`, { headers });
    expect(first.status).toBe(302);
    expect(first.headers.get("cache-control") ?? "").toContain("max-age=604800");
    const cached = await caches.default.match(new Request(`https://jellino.local/img/${id}/primary/sm`));
    expect(cached?.status).toBe(302);
    const fetchesAfterFirst = counters.urls.length;
    const readsAfterFirst = raw.counts.reads;
    const second = await callApp(app, env, `/Items/${id}/Images/Primary`, { headers });
    expect(second.status).toBe(302);
    expect(counters.urls.length).toBe(fetchesAfterFirst);
    expect(raw.counts.reads).toBe(readsAfterFirst);
  });

  it("edge-caches user avatar with week-long cache-control and zero D1 reads on repeat", async () => {
    const counters = freshCounters();
    installPerfNet(counters, 0);
    const { raw, token, adminId } = await tmdbHousehold();
    const app = createApp();
    const env = testEnv(raw);
    const headers = perfAuth(token);

    const first = await callApp(app, env, `/Users/${adminId}/Images/Primary`, { headers });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control") ?? "").toContain("max-age=604800");
    const cached = await caches.default.match(new Request(`https://jellino.local/avatar/${adminId}`));
    expect(cached?.status).toBe(200);

    const readsAfterFirst = raw.counts.reads;
    const second = await callApp(app, env, `/Users/${adminId}/Images/Primary`, { headers });
    expect(second.status).toBe(200);
    expect(raw.counts.reads).toBe(readsAfterFirst);
  });
});
