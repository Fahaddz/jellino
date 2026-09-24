import type { Context, Hono } from "hono";
import type { Env } from "./db";
import { encodePerson, decodePerson } from "./ids";
import { verifiedOwner } from "./session";
import { imageWidth } from "./query";
import { collectionsFolderDto, profileLibrarySplit } from "./library";
import { personAvatarSvg, photoFromImageTag, readPersonPhoto } from "./people";

export function registerStubs(app: Hono<{ Bindings: Env }>, serverId: string): void {
  app.get("/System/Configuration/:key", (c) => c.json({}));

  app.get("/DisplayPreferences/:id", (c) =>
    c.json({
      Id: c.req.param("id") ?? "emby",
      Client: c.req.query("client") ?? "emby",
      CustomPrefs: {},
    }),
  );
  app.post("/DisplayPreferences/:id", (c) => c.body(null, 204));
  app.get("/Persons", (c) =>
    c.json({ Items: [], TotalRecordCount: 0, StartIndex: Number(c.req.query("startIndex") ?? 0) || 0 }),
  );

  app.get("/Persons/:name", (c) => {
    const name = (c.req.param("name") ?? "").trim();
    if (!name) return c.json({ error: "not found" }, 404);
    return c.json({ Name: name, ServerId: serverId, Id: encodePerson(name), Type: "Person", IsFolder: false });
  });

  async function personImage(c: Context<{ Bindings: Env }>, name: string, kind: string) {
    const normalizedKind = kind.toLowerCase();
    if (normalizedKind !== "primary" && normalizedKind !== "thumb") return c.json({ error: "not found" }, 404);
    const clean = decodePerson(name) ?? name.trim();
    if (!clean) return c.json({ error: "not found" }, 404);
    const width = imageWidth(c);
    const tier = width !== null && width > 500 ? "lg" : "sm";
    const cacheKey = new Request(`https://jellino.local/person/${encodeURIComponent(clean.toLowerCase())}/${normalizedKind}/${tier}`, {
      method: "GET",
    });
    const tagged = photoFromImageTag(c.req.query("tag") ?? c.req.query("Tag"));
    if (tagged) {
      const res = new Response(null, {
        status: 302,
        headers: { location: tagged, "cache-control": "public, max-age=604800" },
      });
      await caches.default.put(cacheKey, res.clone());
      return res;
    }
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
    const photo = await readPersonPhoto(caches.default, clean);
    if (photo) {
      const res = new Response(null, {
        status: 302,
        headers: { location: photo, "cache-control": "public, max-age=604800" },
      });
      await caches.default.put(cacheKey, res.clone());
      return res;
    }
    const headers = new Headers({ "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" });
    const tile = personAvatarSvg(clean);
    await caches.default.put(cacheKey, new Response(tile, { headers }));
    return new Response(tile, { headers });
  }

  app.get("/Persons/:name/Images/:kind", (c) => personImage(c, c.req.param("name") ?? "", c.req.param("kind") ?? ""));

  app.get("/Persons/:name/Images/:kind/:index", (c) =>
    personImage(c, c.req.param("name") ?? "", c.req.param("kind") ?? ""),
  );

  app.get("/Items/:id/LocalTrailers", (c) => c.json([]));

  app.get("/Items/:id/Intros", (c) => c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));

  app.get("/Users/:userId/Items/:id/Intros", (c) => c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));

  app.get("/Items/:id/SpecialFeatures", (c) => c.json([]));

  app.get("/Videos/:id/AdditionalParts", (c) => c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));

  app.post("/Sessions/Playing/Ping", (c) => c.body(null, 204));

  app.get("/Items/:id/ThemeSongs", (c) => c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));

  app.get("/Items/:id/ThemeVideos", (c) => c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));

  app.get("/Items/:id/ThemeMedia", (c) =>
    c.json({
      ThemeVideosResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
      ThemeSongsResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
      SoundtrackSongsResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
    }),
  );

  app.get("/Branding/Configuration", (c) =>
    c.json({ SplashscreenEnabled: false, LoginDisclaimer: "", CustomCss: "" }),
  );

  app.get("/Branding/Css", (c) => c.body("", 200, { "content-type": "text/css" }));
  app.get("/Branding/Css.css", (c) => c.body("", 200, { "content-type": "text/css" }));

  app.get("/GetUtcTime", (c) => {
    const nowIso = new Date().toISOString();
    return c.json({ RequestReceptionTime: nowIso, ResponseTransmissionTime: nowIso });
  });
  app.get("/getutctime", (c) => {
    const nowIso = new Date().toISOString();
    return c.json({ RequestReceptionTime: nowIso, ResponseTransmissionTime: nowIso });
  });

  app.get("/SyncPlay/List", (c) => c.json([]));
  app.get("/syncplay/list", (c) => c.json([]));

  app.get("/Localization/Options", (c) => c.json([{ Name: "English", Value: "en-us" }]));

  app.get("/Localization/Countries", (c) =>
    c.json([
      { Name: "United States", DisplayName: "United States", TwoLetterISORegionName: "US", ThreeLetterISORegionName: "USA" },
    ]),
  );

  app.get("/Localization/Cultures", (c) =>
    c.json([
      { Name: "English", DisplayName: "English", TwoLetterISOLanguageName: "en", ThreeLetterISOLanguageName: "eng", ThreeLetterISOLanguageNames: ["eng"] },
    ]),
  );

  app.get("/Localization/ParentalRatings", (c) => c.json([]));

  app.get("/System/Endpoint", (c) => c.json({ IsLocal: false, IsInNetwork: true }));

  app.get("/ScheduledTasks", (c) => c.json([]));

  app.get("/Plugins", (c) => c.json([]));

  app.post("/ClientLog/Document", (c) => c.body(null, 204));

  app.post("/Sessions/Capabilities", (c) => c.body(null, 204));
  app.post("/Sessions/Capabilities/Full", (c) => c.body(null, 204));
  app.post("/Sessions/:id/Capabilities", (c) => c.body(null, 204));
  app.post("/Sessions/:id/Capabilities/Full", (c) => c.body(null, 204));

  app.post("/Sessions/Viewing", (c) => c.body(null, 204));
  app.post("/Sessions/:id/Viewing", (c) => c.body(null, 204));

  app.post("/Sessions/Logout", (c) => c.body(null, 204));

  app.post("/Sessions/LogoutById", (c) => c.body(null, 204));

  app.get("/Sessions", (c) => c.json([]));

  app.get("/UserViews/GroupingOptions", (c) => c.json([]));
  app.get("/Users/:id/GroupingOptions", (c) => c.json([]));

  app.post("/Users/:id/Configuration", (c) => c.body(null, 204));
  app.post("/Users/:id/Policy", (c) => c.body(null, 204));

  const liveTvEmpty = { Items: [], TotalRecordCount: 0, StartIndex: 0 };
  app.get("/LiveTv/Channels", (c) => c.json(liveTvEmpty));
  app.get("/livetv/channels", (c) => c.json(liveTvEmpty));
  app.get("/LiveTv/Programs", (c) => c.json(liveTvEmpty));
  app.get("/livetv/programs", (c) => c.json(liveTvEmpty));
  app.get("/LiveTv/Recordings", (c) => c.json(liveTvEmpty));
  app.get("/livetv/recordings", (c) => c.json(liveTvEmpty));
  app.get("/LiveTv/TunerHosts", (c) => c.json([]));
  app.get("/livetv/tunerhosts", (c) => c.json([]));
  app.get("/LiveTv/ListingProviders", (c) => c.json([]));
  app.get("/livetv/listingproviders", (c) => c.json([]));
  app.get("/LiveTv/Manage/Channels", (c) => c.json(liveTvEmpty));
  app.get("/livetv/manage/channels", (c) => c.json(liveTvEmpty));
  app.get("/LiveTv/ChannelMappingOptions", (c) => c.json({ TunerChannels: [], ProviderChannels: [], Mappings: [] }));
  app.get("/livetv/channelmappingoptions", (c) => c.json({ TunerChannels: [], ProviderChannels: [], Mappings: [] }));
  app.get("/LiveTv/SeriesTimers", (c) => c.json(liveTvEmpty));
  app.get("/livetv/seriestimers", (c) => c.json(liveTvEmpty));
  app.get("/LiveTv/Timers", (c) => c.json(liveTvEmpty));
  app.get("/livetv/timers", (c) => c.json(liveTvEmpty));
  app.get("/LiveTv/Info", (c) => c.json({ Services: [], IsEnabled: false, EnabledUsers: [] }));
  app.get("/livetv/info", (c) => c.json({ Services: [], IsEnabled: false, EnabledUsers: [] }));
  app.get("/LiveTv/GuideInfo", (c) => {
    const nowIso = new Date().toISOString();
    return c.json({ StartDate: nowIso, EndDate: nowIso });
  });
  app.get("/livetv/guideinfo", (c) => {
    const nowIso = new Date().toISOString();
    return c.json({ StartDate: nowIso, EndDate: nowIso });
  });

  app.get("/Library/VirtualFolders", async (c) => {
    const userId = c.req.query("userId") ?? c.req.query("UserId");
    const owner = await verifiedOwner(c.env.DB, c.req.raw, Math.floor(Date.now() / 1000));
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    const target = userId || owner;
    if (owner !== target) return c.json({ error: "unauthorized" }, 401);
    const split = await profileLibrarySplit(c.env.DB, caches.default, fetch, target, serverId);
    if (!split) return c.json({ error: "not found" }, 404);
    const views = split.collections.length > 0 ? [...split.pinned, collectionsFolderDto(serverId)] : split.pinned;
    return c.json(views.map((view) => folderFor(view as { Name: string; Id: string; CollectionType?: string })));
  });
}

function folderFor(view: { Name: string; Id: string; CollectionType?: string }): Record<string, unknown> {
  return {
    Name: view.Name,
    Locations: [],
    CollectionType: view.CollectionType,
    ItemId: view.Id,
    PrimaryImageItemId: view.Id,
    RefreshStatus: "Idle",
  };
}
