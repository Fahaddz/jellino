import { describe, expect, it } from "vitest";
import { episodeDto, fetchMeta, seriesDto } from "../src/meta";

const A = "https://a.example";
const B = "https://b.example";

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

describe("display names", () => {
  it("merges a real name over an id-like name from a thin meta addon", async () => {
    const fetchMock = (async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${A}/meta/series/tt1.json`) {
        return Response.json({ meta: { id: "tt1", type: "series", name: "tt1", videos: [{ season: 1, episode: 1, title: "Pilot" }] } });
      }
      if (url === `${B}/meta/series/tt1.json`) {
        return Response.json({ meta: { id: "tt1", type: "series", name: "Breaking Bad" } });
      }
      return new Response("down", { status: 500 });
    }) as unknown as typeof fetch;

    const resolved = await fetchMeta(memoryCache(), fetchMock, [A, B], A, "series", "tt1");
    expect(resolved?.meta.name).toBe("Breaking Bad");
  });

  it("never puts a raw id in a title", () => {
    const series = { id: "tt0903747", type: "series", name: "tt0903747", videos: [{ season: 1, episode: 1, title: "Pilot" }] };
    const seriesBody = seriesDto("server", A, series) as Record<string, unknown>;
    expect(seriesBody.Name).toBe("tt0903747");

    const episode = episodeDto("server", A, series, { season: 1, episode: 1, title: "Pilot" }) as Record<string, unknown>;
    expect(episode.Name).toBe("Pilot");
    expect(episode.SeriesName).toBe("Pilot");

    const named = { ...series, name: "Breaking Bad" };
    const namedEpisode = episodeDto("server", A, named, { season: 1, episode: 1, title: "Pilot" }) as Record<string, unknown>;
    expect(namedEpisode.SeriesName).toBe("Breaking Bad");
  });
  it("keeps looking past the old three-addon cap for a real name", async () => {
    const bases = ["https://m1.example", "https://m2.example", "https://m3.example", "https://m4.example", "https://m5.example"];
    const fetchMock = (async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${bases[4]}/meta/series/tt9.json`) {
        return Response.json({ meta: { id: "tt9", type: "series", name: "Real Name", videos: [{ season: 1, episode: 1, title: "Pilot" }] } });
      }
      const match = bases.find((base) => url === `${base}/meta/series/tt9.json`);
      if (match) return Response.json({ meta: { id: "tt9", type: "series", name: "tt9", videos: [{ season: 1, episode: 1, title: "Pilot" }] } });
      return new Response("down", { status: 500 });
    }) as unknown as typeof fetch;

    const resolved = await fetchMeta(memoryCache(), fetchMock, bases, bases[0] as string, "series", "tt9");
    expect(resolved?.meta.name).toBe("Real Name");
  });
});
