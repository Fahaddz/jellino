import { describe, expect, it } from "vitest";
import {
  cachedJson,
  evict,
  MANIFEST_TTL_SECONDS,
  META_TTL_SECONDS,
  CATALOG_TTL_SECONDS,
  upstreamFetch,
  upstreamTimeoutMs,
} from "../src/cache";
import { STREAM_TTL_SECONDS } from "../src/streams";
import { SUBTITLE_LIST_TTL_SECONDS } from "../src/subtitles";

function memoryCache(): Cache {
  const store = new Map<string, Response>();
  return {
    match: async (key: Request) => store.get(key.url) ?? undefined,
    put: async (key: Request, value: Response) => {
      store.set(key.url, value);
    },
    delete: async (key: Request) => store.delete(key.url),
  } as unknown as Cache;
}

describe("cachedJson", () => {
  it("misses once then serves hits without the loader", async () => {
    const cache = memoryCache();
    let loads = 0;
    const first = await cachedJson(cache, "https://addon.example/manifest.json", 60, async () => {
      loads += 1;
      return { version: 1 };
    });
    expect(first.hit).toBe(false);
    expect(loads).toBe(1);
    const second = await cachedJson(cache, "https://addon.example/manifest.json", 60, async () => {
      loads += 1;
      return { version: 2 };
    });
    expect(second.hit).toBe(true);
    expect(second.data).toEqual({ version: 1 });
    expect(loads).toBe(1);
  });

  it("stores the configured max-age", async () => {
    const seen = new Map<string, Response>();
    const cache = {
      match: async () => undefined,
      put: async (key: Request, value: Response) => {
        seen.set(key.url, value.clone());
      },
      delete: async () => false,
    } as unknown as Cache;
    await cachedJson(cache, "https://addon.example/meta.json", META_TTL_SECONDS, async () => ({}));
    expect(seen.get("https://addon.example/meta.json")?.headers.get("cache-control")).toBe(
      `public, max-age=${META_TTL_SECONDS}`,
    );
  });

  it("never caches loader failures", async () => {
    const cache = memoryCache();
    await expect(
      cachedJson(cache, "https://addon.example/down.json", 60, async () => {
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");
    expect(await cache.match(new Request("https://addon.example/down.json"))).toBeUndefined();
  });

  it("evicts entries back to miss", async () => {
    const cache = memoryCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { n: loads };
    };
    await cachedJson(cache, "https://addon.example/refresh.json", 60, load);
    expect(await evict(cache, "https://addon.example/refresh.json")).toBe(true);
    const after = await cachedJson(cache, "https://addon.example/refresh.json", 60, load);
    expect(after.hit).toBe(false);
    expect(after.data).toEqual({ n: 2 });
  });

  it("pins edge TTLs to the measured change-rate budget", () => {
    expect(MANIFEST_TTL_SECONDS).toBe(21600);
    expect(CATALOG_TTL_SECONDS).toBe(7200);
    expect(META_TTL_SECONDS).toBe(86400);
    expect(STREAM_TTL_SECONDS).toBe(1800);
    expect(SUBTITLE_LIST_TTL_SECONDS).toBe(3600);
  });
});

describe("upstreamFetch timeout", () => {
  it("applies a fixed 30-second guard", async () => {
    expect(upstreamTimeoutMs()).toBe(30000);
    const impl = (_input: unknown, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(upstreamFetch(impl, "https://slow.example/sub.srt", {}, 10)).rejects.toThrow("aborted");
  });

  it("passes through responses that arrive in time and preserves init", async () => {
    const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
      expect(input).toBe("https://addon.example/ok.json");
      expect(init?.headers).toMatchObject({ accept: "application/json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('{"ok":true}');
    };
    const res = await upstreamFetch(impl, "https://addon.example/ok.json", { headers: { accept: "application/json" } });
    expect(res.ok).toBe(true);
  });

  it("refuses localhost, private and link-local upstream targets", async () => {
    const impl = async () => new Response("{}");
    for (const url of [
      "http://localhost/admin",
      "http://127.0.0.1/admin",
      "http://10.0.0.5/admin",
      "http://192.168.1.50/admin",
      "http://172.16.4.1/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/admin",
      "http://[::1]/admin",
      "http://0.0.0.0/admin",
      "http://router.local/admin",
      "ftp://addon.example/file",
    ]) {
      await expect(upstreamFetch(impl, url)).rejects.toThrow("blocked upstream target");
    }
    const res = await upstreamFetch(impl, "https://addon.example/meta/movie/tt1.json");
    expect(res.ok).toBe(true);
  });
});
