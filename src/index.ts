import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import type { Env } from "./db";
import { profileCount, readSetting, writeSetting } from "./db";
import { hashPassword, newSalt } from "./auth";
import { renderSetupPage } from "./ui/setup";
import { renderAdminPage } from "./ui/admin";
import { renderHomePage } from "./ui/home";
import { ADMIN_CLIENT_JS } from "./ui/admin-client";
import { ADMIN_CSS } from "./ui/admin-css";
import { REMUX_THEME_CSS } from "./ui/remux-css";
import { authenticateByName, bearerToken, clearProfileDisabledCache, findProfile, issueToken, listProfiles, ownerForRequest, publicDto, rateAllow, readCredentials, serverSecret, userDto, verifiedOwner, verifyToken } from "./session";
import { collectionTileInfo, collectionsFolderDto, profileCollections, profileLibraries, profileLibrarySplit, profileViewItem, catalogBases, viewDisplayName } from "./library";
import { isHiddenItem } from "./hidden";
import { boolQuery, csvSet, imageWidth, pageParams, queryIgnoreCase } from "./query";
import { artFromImageTag, artImageTag, artUrlAllowed, defaultLibraryTile } from "./library-art";
import { COLLECTIONS_VIEW_ID, decodeItem, decodeLibrary, decodePerson, decodeView, encodeItem } from "./ids";
import { episodeDto, movieDto, profileMeta, runtimeTicks, seasonDto, seasonEpisodes, seasonNumbers, seriesDto, sortNameFor, videoEpisodeNumber, type StremioVideo } from "./meta";
import { artworkUrl, personFilmography, profileCatalogItems, profileChildItems, profileLatest, profileSearch, viewArtwork } from "./browse";
import { profileMediaSources, registerPlayback } from "./playback";
import { placeholderMediaSources } from "./streams";
import { registerHealth } from "./health";
import { registerProfiles } from "./profiles";
import { attachProfileUserData, pullNuvioWatch, readWatchRows, registerResume, resumeItems, warmLikelyEpisode } from "./resume";
import { registerSessions } from "./sessions";
import { aggregateUserData, attachListUserData, itemKey, readWatchEntry, readFavoriteKeys, isFavoriteItem, type WatchRow } from "./watch-state";
import { fetchMediaSegments } from "./segments";
import { ensureSchema, schemaReady } from "./schema";
import { registerSettings } from "./settings";
import { BUILD_ID, SERVER_VERSION } from "./version";
import { runScheduled } from "./cron";
import { ensureScheduledRun, SCHEDULER_RUN_PATH } from "./scheduler";
import { registerStubs } from "./stubs";
import { applyItemQuery, itemQuery, registerDiscover } from "./discover";
import { personAvatarSvg, personDetail, photoFromImageTag, readPersonPhoto, rememberPersonPhoto, TMDB_API_KEY_SETTING } from "./people";
import { clientInfo, flushAppLog, logApp, logFailureThrottled, registerAppLog } from "./applog";
import { logSubtitleServe } from "./subtitles";
import { registerQuickConnect } from "./quickconnect";
import { type NuvioProfile, nuvioPullProfiles, nuvioSignInAndSave, readNuvioAccount, resolveNuvioAvatarUrl } from "./nuvio";
import { syncFromNuvio } from "./nuvio-home";

const SERVER_ID = "jellino";
const SERVER_NAME = "Jellino";
const ROUTE_MISS_LOG_SECONDS = 600;
const routeMissLogAt = new Map<string, number>();
const JELLYFIN_ROUTE_PREFIXES = [
  "/Users",
  "/UserItems",
  "/Items",
  "/Shows",
  "/Videos",
  "/Sessions",
  "/System",
  "/UserViews",
  "/Library",
  "/Persons",
  "/Search",
  "/Genres",
  "/Studios",
  "/Movies",
  "/DisplayPreferences",
  "/QuickConnect",
  "/Localization",
  "/Branding",
  "/ScheduledTasks",
  "/Plugins",
  "/Audio",
  "/LiveTv",
  "/Playlists",
];

export function createApp() {
  const app = new Hono<{ Bindings: Env }>({ strict: false });

  app.use(
    "*",
    cors({
      origin: "*",
      exposeHeaders: ["Content-Length", "Content-Range", "Content-Type", "Location", "Cache-Control"],
      maxAge: 600,
    }),
  );

  app.use(async (c, next) => {
    if (!c.env.DB) console.error("schema setup failed: missing DB binding");
    else {
      await ensureSchema(c.env.DB);
    }
    await next();
    await flushAppLog(c.env.DB);
  });

  app.use(async (c, next) => {
    const url = new URL(c.req.url);
    if (!url.pathname.includes("//")) return next();
    const fixedPath = url.pathname.replace(/\/{2,}/g, "/");
    if (/^\/+(Videos\/[^/]+\/[^/]+\/Subtitles|Items\/[^/]+\/Subtitles)\//.test(url.pathname)) {
      try {
        await logSubtitleServe(c.env.DB, {
          at: Math.floor(Date.now() / 1000),
          profileId: "anonymous",
          itemId: fixedPath.split("/")[2] ?? "",
          index: -1,
          format: "",
          outcome: "double-slash rewritten",
          ms: 0,
          size: 0,
          url: "",
        });
      } catch {
        void 0;
      }
      const rewritten = new Request(new URL(fixedPath + url.search, url.origin), c.req.raw);
      return app.fetch(rewritten, c.env);
    }
    return c.redirect(fixedPath + (url.search || ""), 308);
  });

  registerStubs(app, SERVER_ID);
  registerDiscover(app, SERVER_ID);
  registerAppLog(app);
  registerSettings(app);
  registerPlayback(app);
  registerHealth(app);
  registerProfiles(app);
  registerResume(app, SERVER_ID);
  registerSessions(app);
  registerQuickConnect(app, SERVER_ID, SERVER_NAME);

  app.post(SCHEDULER_RUN_PATH, async (c) => {
    const provided = bearerToken(c.req.raw);
    const expected = await serverSecret(c.env.DB);
    if (!provided || provided !== expected) return c.json({ error: "unauthorized" }, 401);
    await runScheduled(c.env.DB, caches.default, fetch, Math.floor(Date.now() / 1000));
    return c.json({ ok: true }, 202);
  });

  app.get("/health", (c) => c.json({ status: "ok", schema: schemaReady() ? "ready" : "pending" }));

  app.get("/api/version", (c) => c.json({ build: BUILD_ID }));

  app.get("/System/Info/Public", (c) =>
    c.json({
      LocalAddress: "http://127.0.0.1",
      ServerName: SERVER_NAME,
      Version: SERVER_VERSION,
      ProductName: "Jellyfin Server",
      OperatingSystem: "Linux",
      Id: SERVER_ID,
      StartupWizardCompleted: true,
    }),
  );

  app.get("/System/Info", (c) =>
    c.json({
      Id: SERVER_ID,
      ServerName: SERVER_NAME,
      Version: SERVER_VERSION,
      ProductName: "Jellyfin Server",
      OperatingSystem: "Linux",
      StartupWizardCompleted: true,
      HasPendingRestart: false,
      IsShuttingDown: false,
      SupportsLibraryMonitor: false,
      WebSocketPortNumber: 443,
      CompletedInstallations: [],
      CanSelfRestart: false,
      CanLaunchWebBrowser: false,
      ProgramDataPath: "/data",
      ItemsByNamePath: "/data/items",
      CachePath: "/cache",
      LogPath: "/logs",
      InternalMetadataPath: "/data/metadata",
      TranscodingTempPath: "/transcoding-temp",
      HasUpdateAvailable: false,
      EncoderLocationType: "Custom",
      CastReceiverApplications: [],
    }),
  );

  app.get("/System/Configuration", (c) =>
    c.json({
      ServerName: SERVER_NAME,
      UICulture: "en-US",
      EnableDashboardResponseCaching: true,
    }),
  );

  app.get("/System/Configuration/dashboard", (c) => c.json({}));

  app.get("/", async (c) => {
    const total = await profileCount(c.env.DB);
    if (total === 0) {
      return c.redirect("/setup", 302);
    }
    return c.html(renderHomePage(SERVER_NAME, SERVER_VERSION));
  });

  app.get("/setup", (c) => c.html(renderSetupPage()));
  app.get("/setup.html", (c) => c.redirect("/setup", 301));

  app.get("/admin", (c) => c.html(renderAdminPage()));
  app.get("/admin.html", (c) => c.redirect("/admin", 301));

  app.get("/admin.js", (c) => {
    return c.body(ADMIN_CLIENT_JS, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
  });

  app.get("/admin.css", (c) => {
    return c.body(ADMIN_CSS, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
  });

  app.get("/remux-theme.css", (c) => {
    return c.body(REMUX_THEME_CSS, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
  });

  app.post("/Users/AuthenticateByName", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const body = payload as { Username?: unknown; username?: unknown; Pw?: unknown; Password?: unknown; password?: unknown };
    const username = body.Username ?? body.username;
    const password = body.Pw ?? body.Password ?? body.password ?? "";
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Math.floor(Date.now() / 1000);
    const result = await authenticateByName(
      c.env.DB,
      SERVER_ID,
      username,
      password,
      ip,
      now,
      SERVER_NAME,
      fetch,
    );
    return c.json(result.body, result.status);
  });

  app.get("/Users/Public", async (c) => {
    const profiles = await listProfiles(c.env.DB);
    return c.json(profiles.map((p) => publicDto(p, SERVER_ID)));
  });

  app.get("/Users/Me", async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const token = bearerToken(c.req.raw);
    const profileId = token ? await verifyToken(c.env.DB, token, now) : null;
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const profile = await findProfile(c.env.DB, profileId);
    if (!profile) return c.json({ error: "not found" }, 404);
    return c.json(userDto(profile, SERVER_ID));
  });

  app.on(["GET", "POST"], "/System/Ping", (c) => c.json(SERVER_NAME));

  app.get("/Users", async (c) => {
    const owner = await verifiedOwner(c.env.DB, c.req.raw, Math.floor(Date.now() / 1000));
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    const profiles = await listProfiles(c.env.DB);
    return c.json(profiles.map((p) => userDto(p, SERVER_ID, SERVER_NAME)));
  });

  app.get("/Users/:id", async (c) => {
    const owner = await verifiedOwner(c.env.DB, c.req.raw, Math.floor(Date.now() / 1000));
    if (!owner) return c.json({ error: "unauthorized" }, 401);
    const profile = await findProfile(c.env.DB, c.req.param("id"));
    if (!profile) return c.json({ error: "not found" }, 404);
    return c.json(userDto(profile, SERVER_ID, SERVER_NAME));
  });

  function avatarSvg(name: string, colorHex?: string | null): string {
    const clean = name.trim();
    const letter = (clean[0] ?? "?").toUpperCase().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let fill = colorHex;
    if (!fill || !/^#[0-9a-fA-F]{3,8}$/.test(fill)) {
      let hue = 0;
      for (const ch of clean) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
      fill = `hsl(${hue},45%,32%)`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${fill}"/><text x="128" y="172" font-family="sans-serif" font-size="140" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
  }

  async function avatarResponse(c: Context<{ Bindings: Env }>, id: string) {
    const hasCache = typeof caches !== "undefined" && Boolean(caches?.default);
    const key = new Request(`https://jellino.local/avatar/${id}`, { method: "GET" });
    if (hasCache) {
      const cached = await caches.default.match(key);
      if (cached) return cached;
    }
    const profile = await findProfile(c.env.DB, id);
    if (!profile) return c.json({ error: "not found" }, 404);
    if (profile.avatar_url && /^https?:/i.test(profile.avatar_url)) {
      const res = redirectResponse(profile.avatar_url);
      if (hasCache) {
        await caches.default.put(key, res.clone());
      }
      return res;
    }
    const headers = new Headers({ "content-type": "image/svg+xml", "cache-control": "public, max-age=604800, stale-while-revalidate=86400" });
    const res = new Response(avatarSvg(profile.name, profile.avatar_color_hex), { headers });
    if (hasCache) {
      await caches.default.put(key, res.clone());
    }
    return res;
  }

  app.get("/Users/:id/Images/:kind", (c) => avatarResponse(c, c.req.param("id")));

  app.get("/Users/:id/Images/:kind/:index", (c) => avatarResponse(c, c.req.param("id")));

  async function ancestorsResponse(c: Context<{ Bindings: Env }>, userId: string | undefined, id: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const decoded = decodeItem(id);
    if (!decoded) return c.json({ error: "not found" }, 404);
    if (decoded.kind !== "season" && decoded.kind !== "episode") return c.json([]);
    const resolved = await profileMeta(c.env.DB, caches.default, fetch, profileId, decoded.addonUrl, "series", decoded.stremioId);
    if (!resolved) return c.json({ error: "not found" }, 404);
    const chain: Record<string, unknown>[] = [seriesDto(SERVER_ID, resolved.addonUrl, resolved.meta)];
    if (decoded.kind === "episode") {
      const numbers = seasonNumbers(resolved.meta);
      if (!numbers.includes(decoded.season ?? -1)) return c.json({ error: "not found" }, 404);
      chain.push(seasonDto(SERVER_ID, resolved.addonUrl, resolved.meta, decoded.season ?? 0));
    }
    return c.json(chain);
  }

  app.get("/Users/:userId/Items/:id/Ancestors", (c) => ancestorsResponse(c, c.req.param("userId"), c.req.param("id")));

  app.get("/Items/:id/Ancestors", (c) => ancestorsResponse(c, c.req.query("userId"), c.req.param("id")));

  async function viewsResponse(c: Context<{ Bindings: Env }>, userId?: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    try {
      const split = await profileLibrarySplit(c.env.DB, caches.default, fetch, profileId, SERVER_ID);
      if (!split) return c.json({ error: "not found" }, 404);
      const items = split.collections.length > 0 ? [...split.pinned, collectionsFolderDto(SERVER_ID)] : split.pinned;
      return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
    } catch {
      return c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
  }

  app.get("/Users/:id/Views", (c) => viewsResponse(c, c.req.param("id")));

  app.get("/UserViews", (c) => viewsResponse(c, c.req.query("userId") ?? c.req.query("UserId")));

  app.get("/Library/MediaFolders", async (c) => {
    const profileId = await ownerForRequest(c, c.req.query("userId") ?? c.req.query("UserId"));
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const split = await profileLibrarySplit(c.env.DB, caches.default, fetch, profileId, SERVER_ID);
    if (!split) return c.json({ error: "not found" }, 404);
    const items = split.collections.length > 0 ? [...split.pinned, collectionsFolderDto(SERVER_ID)] : split.pinned;
    return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
  });

  async function gatedProfile(c: Context<{ Bindings: Env }>, userId?: string) {
    return ownerForRequest(c, userId);
  }

  async function withUserData(
    db: Env["DB"],
    profileId: string,
    id: string,
    dto: Record<string, unknown>,
    runTimeTicks: number | null = null,
  ): Promise<Record<string, unknown>> {
    const key = itemKey(id);
    if (!key) return dto;
    const [entry, isFav, isHidden] = await Promise.all([
      readWatchEntry(db, profileId, key),
      isFavoriteItem(db, profileId, key),
      isHiddenItem(db, profileId, key),
    ]);
    const position = entry?.positionTicks ?? 0;
    const lastPlayed = entry?.updatedAt && entry.updatedAt > 0 ? new Date(entry.updatedAt * 1000).toISOString() : undefined;
    const data: Record<string, unknown> = {
      Key: id,
      ItemId: id,
      Played: (entry?.played ?? 0) === 1,
      PlaybackPositionTicks: position,
      PlayCount: entry?.playCount ?? 0,
      IsFavorite: isFav,
      IsHiddenByUser: isHidden,
      ...(lastPlayed ? { LastPlayedDate: lastPlayed } : {}),
    };
    if (runTimeTicks !== null && runTimeTicks > 0 && position > 0) {
      const pct = Math.min(100, (position / runTimeTicks) * 100);
      if (pct > 0) data.PlayedPercentage = Math.round(pct * 100) / 100;
    }
    dto.UserData = data;
    return dto;
  }

  async function itemResponse(c: Context<{ Bindings: Env }>, userId: string | undefined, id: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const person = decodePerson(id);
    if (person) {
      const detail = await personDetail(
        caches.default,
        fetch,
        person,
        await readSetting(c.env.DB, TMDB_API_KEY_SETTING),
      ).catch(() => null);
      if (detail?.photo) await rememberPersonPhoto(caches.default, person, detail.photo).catch(() => undefined);
      const personName = detail?.name || person;
      return c.json({
        Name: personName,
        SortName: sortNameFor(personName),
        ServerId: SERVER_ID,
        Id: id,
        Etag: id,
        Type: "Person",
        MediaType: "Unknown",
        IsFolder: false,
        Overview: detail?.biography || "",
        ...(detail?.birthday ? { PremiereDate: `${detail.birthday}T00:00:00.000Z` } : {}),
        ...(detail?.deathday ? { EndDate: `${detail.deathday}T00:00:00.000Z` } : {}),
        ...(detail?.birthplace ? { ProductionLocations: [detail.birthplace] } : {}),
        ImageTags: detail?.photo ? { Primary: "p" } : {},
        BackdropImageTags: [],
        UserData: {
          Key: id,
          ItemId: id,
          PlaybackPositionTicks: 0,
          PlayCount: 0,
          IsFavorite: false,
          Played: false,
        },
      });
    }
    if (id === COLLECTIONS_VIEW_ID || decodeLibrary(id) || decodeView(id)) {
      const dto = await profileViewItem(c.env.DB, caches.default, fetch, profileId, SERVER_ID, id);
      if (dto) return c.json(dto);
      return c.json({ error: "not found" }, 404);
    }
    const decoded = decodeItem(id);
    if (!decoded) return c.json({ error: "not found" }, 404);
    const metaType = decoded.kind === "season" || decoded.kind === "episode" ? "series" : decoded.kind;
    const resolved = await profileMeta(c.env.DB, caches.default, fetch, profileId, decoded.addonUrl, metaType, decoded.stremioId);
    if (!resolved) {
      await logFailureThrottled(c.env.DB, `meta:${profileId}:${decoded.addonUrl}:${decoded.stremioId}`, {
        at: Math.floor(Date.now() / 1000),
        level: "error",
        category: "meta",
        kind: "empty-meta",
        profileId,
        message: `${metaType}/${decoded.stremioId} resolved from no addon`,
        url: decoded.addonUrl,
      });
      return c.json({ error: "not found" }, 404);
    }
    let wantedSource: string | null = null;
    let asksForMediaSources = false;
    for (const [key, value] of Object.entries(c.req.query())) {
      const lower = key.toLowerCase();
      if (lower === "mediasourceid" && value.trim()) wantedSource = value.trim();
      if (lower === "fields" && /\bMediaSources\b/i.test(value)) asksForMediaSources = true;
    }
    const shouldResolveSources = wantedSource !== null || asksForMediaSources;
    const detailSelection = wantedSource
      ? {
          audio: null,
          subtitle: null,
          mediaSourceId: wantedSource,
          ...(c.req.header("user-agent") ? { userAgent: c.req.header("user-agent") as string } : {}),
        }
      : undefined;
    const episodeKeys = (season: number) =>
      seasonEpisodes(resolved.meta, season).map(
        (v) => `episode:${decoded.stremioId}:${season}:${videoEpisodeNumber(v) ?? 0}`,
      );
    const detailSources = async (): Promise<Record<string, unknown>[]> => {
      if (!shouldResolveSources) return placeholderMediaSources(id);
      const resolvedSources =
        (await profileMediaSources(c.env.DB, caches.default, fetch, profileId, id, detailSelection)) ?? [];
      return resolvedSources.length > 0 ? resolvedSources : placeholderMediaSources(id);
    };
    const attachItemStreams = (dto: Record<string, unknown>, sources: Record<string, unknown>[]): void => {
      const first = sources[0];
      if (!first || first.Type === "Placeholder") return;
      if (Array.isArray(first.MediaStreams)) dto.MediaStreams = first.MediaStreams;
      if (first.Container !== undefined && first.Container !== null) dto.Container = first.Container;
      if (sources.length > 1) dto.MediaSourceCount = sources.length;
    };
    if (decoded.kind === "season") {
      if (!seasonNumbers(resolved.meta).includes(decoded.season ?? -1)) return c.json({ error: "not found" }, 404);
      const rows = await readWatchRows(c.env.DB, profileId);
      const dto = seasonDto(SERVER_ID, resolved.addonUrl, resolved.meta, decoded.season ?? 0);
      dto.UserData = { Key: id, ItemId: id, ...aggregateUserData(rows, episodeKeys(decoded.season ?? 0)) };
      return c.json(dto);
    }
    if (decoded.kind === "episode") {
      const video = seasonEpisodes(resolved.meta, decoded.season ?? -1).find(
        (v) => videoEpisodeNumber(v) === decoded.episode,
      );
      const dto = video ? episodeDto(SERVER_ID, resolved.addonUrl, resolved.meta, video) : null;
      if (!dto) return c.json({ error: "not found" }, 404);
      dto.EnableMediaSourceDisplay = true;
      const episodeSources = await detailSources();
      dto.MediaSources = episodeSources;
      attachItemStreams(dto, episodeSources);
      return c.json(await withUserData(c.env.DB, profileId, id, dto, runtimeTicks(resolved.meta.runtime)));
    }
    if (decoded.kind === "series" || resolved.meta.type === "series") {
      const rows = await readWatchRows(c.env.DB, profileId);
      const dto = await withUserData(
        c.env.DB,
        profileId,
        id,
        seriesDto(SERVER_ID, resolved.addonUrl, resolved.meta),
      );
      const agg = aggregateUserData(
        rows,
        seasonNumbers(resolved.meta).flatMap((s) => episodeKeys(s)),
      );
      dto.UserData = {
        ...((dto.UserData ?? {}) as Record<string, unknown>),
        Played: agg.Played,
        ...(agg.UnplayedItemCount === undefined ? {} : { UnplayedItemCount: agg.UnplayedItemCount }),
      };
      warmLikelyEpisode(c, profileId, decoded.stremioId, resolved.meta, rows);
      return c.json(dto);
    }
    const movie = movieDto(SERVER_ID, resolved.addonUrl, resolved.meta);
    movie.EnableMediaSourceDisplay = true;
    const movieSources = await detailSources();
    movie.MediaSources = movieSources;
    attachItemStreams(movie, movieSources);
    return c.json(await withUserData(c.env.DB, profileId, id, movie, runtimeTicks(resolved.meta.runtime)));
  }

  app.get("/Users/:userId/Items/Latest", (c) => latestResponse(c, c.req.param("userId")));
  app.get("/Items/Latest", (c) => latestResponse(c, c.req.query("userId") ?? c.req.query("UserId")));

  app.get("/Users/:userId/Items/:id", (c) => itemResponse(c, c.req.param("userId"), c.req.param("id")));

  app.get("/Items/:id/Images/:kind/:index", (c) => imageResponse(c, c.req.param("id"), c.req.param("kind")));

  app.get("/Items/:id/Images/:kind", (c) => imageResponse(c, c.req.param("id"), c.req.param("kind")));

  app.get("/Items/:id", (c) => itemResponse(c, c.req.query("userId") ?? c.req.query("UserId"), c.req.param("id")));

  async function mediaSegmentsResponse(c: Context<{ Bindings: Env }>, id: string) {
    const profileId = await ownerForRequest(c, c.req.query("userId") ?? c.req.query("UserId"));
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const decoded = decodeItem(id);
    if (!decoded || (decoded.kind !== "movie" && decoded.kind !== "episode")) {
      return c.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }
    const metaType = decoded.kind === "episode" ? "series" : "movie";
    let imdbId: string | null = null;
    let tmdbId: string | null = null;
    let resolved = null;
    if (decoded.stremioId.startsWith("tt")) {
      imdbId = decoded.stremioId.split(":")[0] ?? null;
    }
    if (decoded.stremioId.startsWith("tmdb:")) {
      tmdbId = decoded.stremioId.split(":")[1] ?? null;
    }
    if (!imdbId || !tmdbId) {
      resolved = await profileMeta(c.env.DB, caches.default, fetch, profileId, decoded.addonUrl, metaType, decoded.stremioId);
      if (!imdbId && resolved?.meta.imdb_id) imdbId = resolved.meta.imdb_id;
      if (!tmdbId) {
        const candidate = resolved?.meta.moviedb_id ?? resolved?.meta.tmdb_id;
        if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") tmdbId = String(candidate).trim();
      }
    }
    let malId: number | null = null;
    if (decoded.stremioId.startsWith("mal:")) {
      const parsed = parseInt(decoded.stremioId.replace(/^mal:/, ""), 10);
      if (!Number.isNaN(parsed)) malId = parsed;
    } else if (resolved?.meta) {
      const candidate = (resolved.meta as { mal_id?: unknown; malId?: unknown }).mal_id ?? (resolved.meta as { mal_id?: unknown; malId?: unknown }).malId;
      if (candidate !== undefined && candidate !== null) {
        const parsed = parseInt(String(candidate), 10);
        if (!Number.isNaN(parsed)) malId = parsed;
      }
    }
    const ticks = resolved?.meta?.runtime ? runtimeTicks(resolved.meta.runtime) : null;
    const runtimeMs = ticks && ticks > 0 ? Math.round(ticks / 10000) : null;
    const wantedTypes = String(c.req.query("includeSegmentTypes") ?? c.req.query("IncludeSegmentTypes") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const publicMetaDbKey = await readSetting(c.env.DB, "publicmetadb_api_key");
    const segments = await fetchMediaSegments(
      caches.default,
      fetch,
      {
        itemId: id,
        imdbId,
        tmdbId,
        season: decoded.season,
        episode: decoded.episode,
        malId,
        runtimeMs,
      },
      publicMetaDbKey,
    );

    const filtered = wantedTypes.length > 0
      ? segments.filter((s) => wantedTypes.includes(s.Type))
      : segments;

    return c.json({
      Items: filtered,
      TotalRecordCount: filtered.length,
      StartIndex: 0,
    });
  }

  app.get("/Items/:id/MediaSegments", (c) => mediaSegmentsResponse(c, c.req.param("id")));
  app.get("/MediaSegments/:id", (c) => mediaSegmentsResponse(c, c.req.param("id")));
  app.get("/Users/:userId/Items/:id/MediaSegments", (c) => mediaSegmentsResponse(c, c.req.param("id")));

  app.get("/Users/:userId/Items", (c) => itemsResponse(c, c.req.param("userId")));

  app.get("/Items", (c) => itemsResponse(c, c.req.query("userId")));




const itemDtoMemoryCache = new Map<string, { dto: Record<string, unknown>; expiresAt: number }>();

  app.post("/Items/:id/Refresh", (c) => {
    const id = c.req.param("id");
    if (id) itemDtoMemoryCache.delete(id);
    return c.body(null, 204);
  });

  async function itemsResponse(c: Context<{ Bindings: Env }>, userId?: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const { limit, start } = pageParams(c);
    const itemFilter = itemQuery(c);
    const idsRaw = c.req.query("Ids") ?? c.req.query("ids");
    if (idsRaw) {
      const ids = idsRaw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .slice(0, 100);
      const [rows, favKeys] = await Promise.all([
        readWatchRows(c.env.DB, profileId),
        readFavoriteKeys(c.env.DB, profileId),
      ]);
      const items = await Promise.all(
        ids.map(async (id) => {
          const cached = itemDtoMemoryCache.get(id);
          if (cached && cached.expiresAt > Date.now()) {
            return { ...cached.dto };
          }
          const decoded = decodeItem(id);
          const type =
            decoded?.kind === "episode" ? "Episode" : decoded?.kind === "series" ? "Series" : decoded?.kind === "movie" ? "Movie" : "Folder";
          if (!decoded) {
            return {
              Name: id,
              ServerId: SERVER_ID,
              Id: id,
              Type: type,
              MediaType: type === "Folder" ? null : "Video",
              IsFolder: type === "Series",
            };
          }
          const metaType = decoded.kind === "season" || decoded.kind === "episode" ? "series" : decoded.kind;
          const resolved = await profileMeta(c.env.DB, caches.default, fetch, profileId, decoded.addonUrl, metaType, decoded.stremioId).catch(() => null);
          if (!resolved) {
            return {
              Name: decoded.stremioId,
              ServerId: SERVER_ID,
              Id: id,
              Type: type,
              MediaType: type === "Folder" ? null : "Video",
              IsFolder: type === "Series",
            };
          }
          let dto: Record<string, unknown>;
          if (decoded.kind === "series" || resolved.meta.type === "series") {
            dto = seriesDto(SERVER_ID, resolved.addonUrl, resolved.meta);
          } else if (decoded.kind === "movie") {
            dto = movieDto(SERVER_ID, resolved.addonUrl, resolved.meta);
          } else if (decoded.kind === "episode") {
            const video = seasonEpisodes(resolved.meta, decoded.season ?? -1).find(
              (v) => videoEpisodeNumber(v) === decoded.episode,
            );
            const ep = video ? episodeDto(SERVER_ID, resolved.addonUrl, resolved.meta, video) : null;
            dto = ep ?? {
                  Name: `Episode ${decoded.episode}`,
                  ServerId: SERVER_ID,
                  Id: id,
                  Type: "Episode",
                  MediaType: "Video",
                  IsFolder: false,
                  IndexNumber: decoded.episode,
                  ParentIndexNumber: decoded.season,
                  SeriesName: resolved.meta.name,
                };
          } else if (decoded.kind === "season") {
            dto = seasonDto(SERVER_ID, resolved.addonUrl, resolved.meta, decoded.season ?? 0);
          } else {
            dto = {
              Name: resolved.meta.name ?? decoded.stremioId,
              ServerId: SERVER_ID,
              Id: id,
              Type: type,
              MediaType: type === "Folder" ? null : "Video",
              IsFolder: type === "Series",
            };
          }
          if (itemDtoMemoryCache.size >= 500) {
            const firstKey = itemDtoMemoryCache.keys().next().value;
            if (firstKey) itemDtoMemoryCache.delete(firstKey);
          }
          itemDtoMemoryCache.set(id, { dto, expiresAt: Date.now() + 10 * 60 * 1000 });
          return { ...dto };
        }),
      );
      attachListUserData(items, rows, null, favKeys);
      return c.json({ Items: items, TotalRecordCount: items.length, StartIndex: 0 });
    }
    const searchTerm = c.req.query("searchTerm") ?? c.req.query("SearchTerm");
    let parentId = c.req.query("parentId") ?? c.req.query("ParentId");
    try {
      const filters = requestedFilters(c);
      const isFavReq = filters.has("isfavorite") || boolQuery(c, "IsFavorite") === true;

      if (!searchTerm && !parentId && isFavReq) {
        const favRows = await c.env.DB
          .prepare("SELECT item_key, content_id, content_type, name, poster FROM profile_favorites WHERE profile_id = ? ORDER BY added_at DESC")
          .bind(profileId)
          .all<{ item_key: string; content_id: string; content_type: string; name: string; poster: string | null }>();
        const favs = favRows.results ?? [];
        const items = favs.map((f) => {
          const isMovie = f.content_type === "movie";
          const id = encodeItem("tmdb", isMovie ? "movie" : "series", f.content_id);
          const posterTag = artImageTag(f.poster);
          return {
            Name: f.name || f.content_id,
            ServerId: SERVER_ID,
            Id: id,
            Type: isMovie ? "Movie" : "Series",
            MediaType: "Video",
            IsFolder: !isMovie,
            ...(posterTag ? { ImageTags: { Primary: posterTag } } : {}),
            UserData: {
              Key: id,
              ItemId: id,
              Played: false,
              PlaybackPositionTicks: 0,
              PlayCount: 0,
              IsFavorite: true,
            },
          };
        });
        const filtered = applyItemQuery(items, itemFilter);
        const hits = filtered.slice(start, start + limit);
        return c.json({ Items: hits, TotalRecordCount: filtered.length, StartIndex: start });
      }

      if (!searchTerm && !parentId && filters.has("isresumable")) {
        const mediaTypesRaw = (c.req.query("MediaTypes") ?? c.req.query("mediaTypes") ?? "").toLowerCase();
        if (mediaTypesRaw.includes("audio") && !mediaTypesRaw.includes("video")) {
          return c.json({ Items: [], TotalRecordCount: 0, StartIndex: start });
        }
        const includeRaw = (c.req.query("IncludeItemTypes") ?? c.req.query("includeItemTypes") ?? "").toLowerCase();
        const types = new Set<"movie" | "series" | "episode">();
        for (const part of includeRaw.split(",")) {
          const kind = part.trim();
          if (kind === "movie" || kind === "series" || kind === "episode") types.add(kind);
        }
        await pullNuvioWatch(c.env.DB, fetch, profileId);
        const urls = await catalogBases(c.env.DB, profileId);
        if (!urls) return c.json({ error: "not found" }, 404);
        const { items, total } = await resumeItems(c.env.DB, caches.default, urls, SERVER_ID, profileId, {
          limit,
          start,
          types: types.size > 0 ? types : null,
        });
        return c.json({ Items: items, TotalRecordCount: total, StartIndex: start });
      }

      const [rows, favKeys] = await Promise.all([
        readWatchRows(c.env.DB, profileId),
        readFavoriteKeys(c.env.DB, profileId),
      ]);
      if (itemFilter.personIds.length > 0) {
        const names = itemFilter.personIds
          .map((value) => (decodePerson(value) ?? value).trim())
          .filter((value) => value.length > 0);
        const filmography =
          names.length > 0
            ? await personFilmography(c.env.DB, caches.default, fetch, profileId, SERVER_ID, names, { start, limit })
            : null;
        if (filmography) {
          const filtered = applyItemQuery(filmography.items, { ...itemFilter, personIds: [] });
          const hits = filtered.slice(start, start + limit);
          attachListUserData(hits, rows, null, favKeys);
          const total = filmography.hasMore ? start + hits.length + 1 : filtered.length;
          return c.json({ Items: hits, TotalRecordCount: total, StartIndex: start });
        }
      }
      if (searchTerm) {
        const items = await profileSearch(c.env.DB, caches.default, fetch, profileId, SERVER_ID, searchTerm, limit, start);
        if (!items) return c.json({ error: "not found" }, 404);
        const filtered = applyItemQuery(applyWatchFilters(items, filters, rows, favKeys), itemFilter);
        const hits = filtered.slice(0, limit);
        attachListUserData(hits, rows, null, favKeys);
        const total = start + hits.length + (items.length >= limit ? 1 : 0);
        return c.json({ Items: hits, TotalRecordCount: total, StartIndex: start });
      }
      if (!parentId) {
        const itemTypes = c.req.query("includeItemTypes") ?? c.req.query("IncludeItemTypes");
        if (itemTypes) {
          const lower = itemTypes.toLowerCase();
          const wantsBoxSets = lower.includes("boxset");
          const wantsItems = lower.includes("movie") || lower.includes("series") || lower.includes("episode");
          if (wantsBoxSets && !wantsItems) {
            return collectionsPage(c, profileId, start, limit);
          }
          const views = await profileLibraries(c.env.DB, caches.default, fetch, profileId, SERVER_ID);
          if (views && views.length > 0) {
            const targetType = lower.includes("series") || lower.includes("episode") ? "tvshows" : lower.includes("movie") ? "movies" : null;
            if (targetType) {
              const match = views.find((v) => v.CollectionType === targetType);
              if (match) parentId = String(match.Id ?? "");
            }
          }
        }
      }
      if (parentId) {
        if (parentId === COLLECTIONS_VIEW_ID) {
          return collectionsPage(c, profileId, start, limit);
        }
        const wantedGenres = [...itemFilter.genres, ...itemFilter.genreIds];
        const singleGenre = wantedGenres.length === 1 ? wantedGenres[0] ?? null : null;
        const page = await profileCatalogItems(c.env.DB, caches.default, fetch, profileId, SERVER_ID, parentId, {
          window: { start, limit },
          genre: singleGenre,
        });
        if (page) {
          const effective = page.limit > 0 ? page.limit : limit;
          const facetQuery = page.genreApplied ? { ...itemFilter, genres: [], genreIds: [] } : itemFilter;
          const filtered = applyItemQuery(applyWatchFilters(page.items, filters, rows, favKeys), facetQuery);
          const hits = filtered.slice(0, effective);
          attachListUserData(hits, rows, null, favKeys);
          const total = page.hasMore ? start + hits.length + Math.max(effective, 1) : start + filtered.length;
          return c.json({ Items: hits, TotalRecordCount: total, StartIndex: start });
        }
        const parent = decodeItem(parentId);
        const deep = boolQuery(c, "Recursive") === true;
        const children = parent
          ? await profileChildItems(c.env.DB, caches.default, fetch, profileId, SERVER_ID, parentId, parent, deep)
          : null;
        if (!children) return c.json({ error: "not found" }, 404);
        const filtered = applyItemQuery(applyWatchFilters(children.items, filters, rows, favKeys), itemFilter);
        const hits = filtered.slice(start, start + limit);
        attachListUserData(hits, rows, null, favKeys);
        return c.json({ Items: hits, TotalRecordCount: filtered.length, StartIndex: start });
      }
    } catch {
      return c.json({ Items: [], TotalRecordCount: 0, StartIndex: start });
    }
    return c.json({ Items: [], TotalRecordCount: 0, StartIndex: start });
  }

  function requestedFilters(c: Context<{ Bindings: Env }>): Set<string> {
    const filters = csvSet(c.req.query("Filters") ?? c.req.query("filters") ?? "");
    const played = boolQuery(c, "IsPlayed");
    if (played === true) filters.add("isplayed");
    if (played === false) filters.add("isunplayed");
    return filters;
  }

  function applyWatchFilters(
    items: Record<string, unknown>[],
    filters: Set<string>,
    rows: WatchRow[],
    favKeys: Set<string>,
  ): Record<string, unknown>[] {
    const wantPlayed = filters.has("isplayed");
    const wantUnplayed = filters.has("isunplayed");
    const wantResumable = filters.has("isresumable");
    const wantFavorite = filters.has("isfavorite");
    if (!wantPlayed && !wantUnplayed && !wantResumable && !wantFavorite) return items;
    const byKey = new Map(rows.map((row) => [row.itemKey, row]));
    return items.filter((item) => {
      const k = itemKey(String(item.Id ?? "")) ?? "";
      const row = byKey.get(k);
      const played = (row?.played ?? 0) === 1;
      const position = row?.positionTicks ?? 0;
      if (wantPlayed && !played) return false;
      if (wantUnplayed && played) return false;
      if (wantResumable && (played || position <= 0)) return false;
      if (wantFavorite && !favKeys.has(k)) return false;
      return true;
    });
  }

  function searchHint(item: Record<string, unknown>): Record<string, unknown> {
    const id = String(item.Id ?? "");
    const imageTags = item.ImageTags as Record<string, string> | undefined;
    const backdropTags = item.BackdropImageTags as string[] | undefined;
    return {
      Id: id,
      ItemId: id,
      Name: String(item.Name ?? ""),
      Type: String(item.Type ?? ""),
      IsFolder: item.IsFolder ?? false,
      RunTimeTicks: item.RunTimeTicks ?? null,
      ProductionYear: item.ProductionYear ?? null,
      PrimaryImageTag: imageTags?.Primary ?? null,
      ThumbImageTag: imageTags?.Primary ?? null,
      ThumbImageItemId: id,
      BackdropImageTag: backdropTags?.[0] ?? null,
      BackdropImageItemId: backdropTags?.[0] ? id : null,
    };
  }

  async function searchHintsResponse(c: Context<{ Bindings: Env }>, userId?: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const searchTerm = c.req.query("searchTerm") ?? c.req.query("SearchTerm") ?? c.req.query("term") ?? "";
    if (!searchTerm.trim()) {
      return c.json({ SearchHints: [], TotalRecordCount: 0 });
    }
    const rawLimit = c.req.query("limit") ?? c.req.query("Limit");
    const limit = Number(rawLimit ?? 20) || 20;
    try {
      const items = await profileSearch(c.env.DB, caches.default, fetch, profileId, SERVER_ID, searchTerm, limit);
      if (!items) return c.json({ error: "not found" }, 404);
      const hints = items.map(searchHint);
      return c.json({ SearchHints: hints, TotalRecordCount: hints.length });
    } catch {
      return c.json({ SearchHints: [], TotalRecordCount: 0 });
    }
  }

  app.get("/Search/Hints", (c) => searchHintsResponse(c, c.req.query("userId")));
  app.get("/Users/:userId/Search/Hints", (c) => searchHintsResponse(c, c.req.param("userId")));

  async function latestResponse(c: Context<{ Bindings: Env }>, userId?: string) {
    const profileId = await ownerForRequest(c, userId);
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const { limit } = pageParams(c);
    const parentId = c.req.query("parentId") ?? c.req.query("ParentId");
    const itemTypes = c.req.query("includeItemTypes") ?? c.req.query("IncludeItemTypes");
    try {
      const items = await profileLatest(c.env.DB, caches.default, fetch, profileId, SERVER_ID, parentId, limit, itemTypes);
      if (!items) return c.json({ error: "not found" }, 404);
      await attachProfileUserData(c.env.DB, profileId, items);
      return c.json(applyItemQuery(items, itemQuery(c)));
    } catch {
      return c.json([]);
    }
  }

  function widthClass(width: number | null): string {
    if (width !== null && width > 800) return "xl";
    if (width !== null && width > 500) return "lg";
    return "sm";
  }

  async function tokenOwner(c: Context<{ Bindings: Env }>): Promise<string | null> {
    const token = bearerToken(c.req.raw);
    if (!token) return null;
    return verifyToken(c.env.DB, token, Math.floor(Date.now() / 1000)).catch(() => null);
  }

  function redirectResponse(target: string): Response {
    return new Response(null, {
      status: 302,
      headers: { location: target, "cache-control": "public, max-age=604800, stale-while-revalidate=86400" },
    });
  }

  async function imageResponse(c: Context<{ Bindings: Env }>, id: string, kind: string) {
    const normalizedKind = kind.toLowerCase();
    if (normalizedKind !== "primary" && normalizedKind !== "thumb" && normalizedKind !== "backdrop" && normalizedKind !== "logo") {
      return c.json({ error: "not found" }, 404);
    }
    const taggedArt = artUrlAllowed(artFromImageTag(queryIgnoreCase(c, "tag")));
    if (taggedArt) return redirectResponse(taggedArt);
    const width = imageWidth(c);
    const key = new Request(`https://jellino.local/img/${id}/${normalizedKind}/${widthClass(width)}`, { method: "GET" });
    const cached = await caches.default.match(key);
    if (cached) return cached;
    const view = decodeView(id);
    if (view) {
      const viewKey = new Request(`https://jellino.local/img/v2/${id}/${normalizedKind}/${widthClass(width)}`, {
        method: "GET",
      });
      const viewCached = await caches.default.match(viewKey);
      if (viewCached) return viewCached;
      {
        const art = await viewArtwork(c.env.DB, caches.default, fetch, view);
        if (art && (art.startsWith("https://") || art.startsWith("http://"))) {
          try {
            const res = redirectResponse(new URL(art).toString());
            await caches.default.put(viewKey, res.clone());
            return res;
          } catch {
          }
        }
      }
      const tileOwner = await tokenOwner(c);
      const tile = defaultLibraryTile(
        view.catalogType,
        await viewDisplayName(c.env.DB, caches.default, fetch, tileOwner, view),
      );
      const headers = new Headers({ "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" });
      await caches.default.put(viewKey, new Response(tile, { headers }));
      return new Response(tile, { headers });
    }
    if (id === COLLECTIONS_VIEW_ID || decodeLibrary(id)) {
      const tileOwner = await tokenOwner(c);
      const info = await collectionTileInfo(c.env.DB, tileOwner, id);
      if (info) {
        const tileKey = new Request(`https://jellino.local/img/col/${id}/${normalizedKind}/${widthClass(width)}`, {
          method: "GET",
        });
        const tileCached = await caches.default.match(tileKey);
        if (tileCached) return tileCached;
        const tile = defaultLibraryTile(info.catalogType, info.name);
        const headers = new Headers({ "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" });
        await caches.default.put(tileKey, new Response(tile, { headers }));
        return new Response(tile, { headers });
      }
    }
    const person = decodePerson(id);
    if (person) {
      const personKey = new Request(`https://jellino.local/person-img/v2/${encodeURIComponent(person.toLowerCase())}/${widthClass(width)}`, {
        method: "GET",
      });
      const tagged = artUrlAllowed(photoFromImageTag(queryIgnoreCase(c, "tag")));
      if (tagged) return redirectResponse(tagged);
      const cachedPerson = await caches.default.match(personKey);
      if (cachedPerson) return cachedPerson;
      const photo = await readPersonPhoto(caches.default, person);
      if (photo) {
        const res = redirectResponse(photo);
        await caches.default.put(personKey, res.clone());
        return res;
      }
      const tile = personAvatarSvg(person);
      const headers = new Headers({ "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" });
      await caches.default.put(personKey, new Response(tile, { headers }));
      return new Response(tile, { headers });
    }
    const target = await artworkUrl(caches.default, fetch, id, normalizedKind, width);
    if (!target || !(target.startsWith("https://") || target.startsWith("http://"))) {
      return c.json({ error: "not found" }, 404);
    }
    try {
      const final = new URL(target).toString();
      const res = redirectResponse(final);
      await caches.default.put(key, res.clone());
      return res;
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  }

  async function collectionsPage(c: Context<{ Bindings: Env }>, profileId: string, start: number, limit: number) {
    const collections = await profileCollections(c.env.DB, caches.default, fetch, profileId, SERVER_ID);
    if (!collections) return c.json({ error: "not found" }, 404);
    return c.json({ Items: collections.slice(start, start + limit), TotalRecordCount: collections.length, StartIndex: start });
  }

  async function profileSeriesMeta(c: Context<{ Bindings: Env }>) {
    const profileId = await ownerForRequest(c, queryIgnoreCase(c, "userId"));
    if (!profileId) return c.json({ error: "unauthorized" }, 401);
    const decoded = decodeItem(c.req.param("id") ?? "");
    if (!decoded || decoded.kind !== "series") return c.json({ error: "not found" }, 404);
    const resolved = await profileMeta(c.env.DB, caches.default, fetch, profileId, decoded.addonUrl, "series", decoded.stremioId);
    if (!resolved) return c.json({ error: "not found" }, 404);
    return { profileId, decoded, resolved };
  }

  function episodeItems(resolved: { addonUrl: string; meta: Parameters<typeof episodeDto>[2] }, videos: StremioVideo[]): Record<string, unknown>[] {
    return videos
      .map((video) => {
        const ep = episodeDto(SERVER_ID, resolved.addonUrl, resolved.meta, video);
        if (ep) {
          ep.EnableMediaSourceDisplay = true;
          ep.MediaSources = placeholderMediaSources(String(ep.Id ?? ""));
        }
        return ep;
      })
      .filter((dto): dto is Record<string, unknown> => dto !== null);
  }

  app.get("/Shows/:id/Seasons", async (c) => {
    const ctx = await profileSeriesMeta(c);
    if (ctx instanceof Response) return ctx;
    const { profileId, decoded, resolved } = ctx;
    const rows = await readWatchRows(c.env.DB, profileId);
    const items = seasonNumbers(resolved.meta).map((season) => {
      const dto = seasonDto(SERVER_ID, resolved.addonUrl, resolved.meta, season);
      const id = String(dto.Id ?? "");
      dto.UserData = {
        Key: id,
        ItemId: id,
        ...aggregateUserData(
          rows,
          seasonEpisodes(resolved.meta, season).map((v) => `episode:${decoded.stremioId}:${season}:${videoEpisodeNumber(v) ?? 0}`),
        ),
      };
      return dto;
    });
    return c.json({ Items: items, TotalRecordCount: items.length });
  });

  app.get("/Shows/:id/Episodes", async (c) => {
    const ctx = await profileSeriesMeta(c);
    if (ctx instanceof Response) return ctx;
    const { profileId, decoded, resolved } = ctx;
    const seasonParam = queryIgnoreCase(c, "season");
    const seasonIdParam = queryIgnoreCase(c, "seasonId");
    let season = seasonParam !== undefined ? Number(seasonParam) : null;
    if (seasonIdParam) {
      const seasonDecoded = decodeItem(seasonIdParam);
      if (!seasonDecoded || seasonDecoded.kind !== "season" || seasonDecoded.stremioId !== decoded.stremioId) {
        return c.json({ error: "not found" }, 404);
      }
      season = seasonDecoded.season;
    }
    const seasons = season === null ? seasonNumbers(resolved.meta) : [season];
    const startIndexParam = queryIgnoreCase(c, "startIndex");
    const limitParam = queryIgnoreCase(c, "limit");
    const startIndex = startIndexParam !== undefined ? Math.max(0, parseInt(startIndexParam, 10) || 0) : 0;
    const limit = limitParam !== undefined ? Math.max(1, parseInt(limitParam, 10) || 0) : undefined;
    const sortBy = (queryIgnoreCase(c, "sortBy") ?? "").toLowerCase();
    const isDescending = (queryIgnoreCase(c, "sortOrder") ?? "").toLowerCase() === "descending";
    const filters = requestedFilters(c);
    const hasFilter = filters.has("isplayed") || filters.has("isunplayed") || filters.has("isresumable");
    let videos = seasons.flatMap((s) => seasonEpisodes(resolved.meta, s));
    if (sortBy.includes("indexnumber") || sortBy.includes("sortname")) {
      videos.sort((a, b) => {
        const sDiff = (typeof a.season === "number" ? a.season : 0) - (typeof b.season === "number" ? b.season : 0);
        if (sDiff !== 0) return sDiff;
        return (videoEpisodeNumber(a) ?? 0) - (videoEpisodeNumber(b) ?? 0);
      });
      if (isDescending) videos.reverse();
    }
    const rows = await readWatchRows(c.env.DB, profileId);
    if (!hasFilter) {
      const totalRecordCount = videos.length;
      const pageVideos = limit !== undefined ? videos.slice(startIndex, startIndex + limit) : videos.slice(startIndex);
      const items = episodeItems(resolved, pageVideos);
      attachListUserData(items, rows, runtimeTicks(resolved.meta.runtime));
      warmLikelyEpisode(c, profileId, decoded.stremioId, resolved.meta, rows, season);
      return c.json({ Items: items, TotalRecordCount: totalRecordCount, StartIndex: startIndex });
    }
    const allItems = episodeItems(resolved, videos);
    const filtered = applyWatchFilters(allItems, filters, rows, new Set());
    const items = limit !== undefined ? filtered.slice(startIndex, startIndex + limit) : filtered.slice(startIndex);
    attachListUserData(items, rows, runtimeTicks(resolved.meta.runtime));
    warmLikelyEpisode(c, profileId, decoded.stremioId, resolved.meta, rows, season);
    return c.json({ Items: items, TotalRecordCount: filtered.length, StartIndex: startIndex });
  });

  app.get("/api/setup/status", async (c) => {
    const total = await profileCount(c.env.DB);
    return c.json({ users: total, adminExists: total > 0 });
  });

  const handleNuvioAuth = async (c: Context<{ Bindings: Env }>) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Math.floor(Date.now() / 1000);
    if (!(await rateAllow(c.env.DB, `auth-nuvio:${ip}`, 300, 10, now))) {
      return c.json({ error: "too many attempts" }, 429);
    }

    const credentials = await readCredentials(c);
    if (credentials instanceof Response) return credentials;

    const admin = await c.env.DB
      .prepare("SELECT id, name, is_admin, disabled FROM profiles WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1")
      .first<{ id: string; name: string; is_admin: number; disabled: number }>();

    if (admin) {
      if (admin.disabled === 1) return c.json({ error: "invalid credentials" }, 401);
      const existingAccount = await readNuvioAccount(c.env.DB);
      const configuredEmail = (await readSetting(c.env.DB, "admin_email")) || existingAccount?.email;
      if (!configuredEmail || configuredEmail.trim().toLowerCase() !== credentials.email.trim().toLowerCase()) {
        return c.json({ error: "invalid credentials" }, 401);
      }
    }

    const signIn = await nuvioSignInAndSave(c.env.DB, fetch, credentials.email, credentials.password);
    if (!signIn.ok) {
      return c.json({ error: signIn.error }, 400);
    }

    await writeSetting(c.env.DB, "admin_email", signIn.email.trim().toLowerCase());

    let effectiveAdmin: { id: string; name: string; is_admin: number } | null = admin;
    if (effectiveAdmin) {
      const salt = newSalt();
      const passwordHash = await hashPassword(credentials.password, salt);
      await c.env.DB
        .prepare("UPDATE profiles SET password_hash = ?, salt = ?, token_epoch = token_epoch + 1 WHERE id = ?")
        .bind(passwordHash, salt, effectiveAdmin.id)
        .run();
      clearProfileDisabledCache(c.env.DB, effectiveAdmin.id);
    } else {
      const profilesRes = await nuvioPullProfiles(fetch, signIn.session.access_token);
      const nuvioProfiles: NuvioProfile[] = profilesRes.profiles ?? [];
      const primary = nuvioProfiles.find((p: NuvioProfile) => p.profile_index === 0) ?? nuvioProfiles[0];
      const adminName = (primary?.name || credentials.email.split("@")[0] || "Admin").trim();
      const adminColor = primary?.avatar_color_hex || "#7c5cff";
      const adminIndex = primary?.profile_index ?? 0;
      const adminAvatarUrl = resolveNuvioAvatarUrl(primary ?? {});

      const salt = newSalt();
      const passwordHash = await hashPassword(credentials.password, salt);
      const adminId = crypto.randomUUID();

      await c.env.DB
        .prepare(
          "INSERT INTO profiles (id, name, password_hash, salt, is_admin, addon_mode, nuvio_profile_id, nuvio_profile_index, avatar_color_hex, avatar_url, created_at) VALUES (?, ?, ?, ?, 1, 'custom', ?, ?, ?, ?, ?)",
        )
        .bind(adminId, adminName, passwordHash, salt, primary?.id ?? null, adminIndex, adminColor, adminAvatarUrl, now)
        .run();

      effectiveAdmin = { id: adminId, name: adminName, is_admin: 1 };
    }

    try {
      await syncFromNuvio(c.env.DB, fetch, { force: true });
    } catch {
      void 0;
    }
    if (!effectiveAdmin) return c.json({ error: "not found" }, 500);
    const token = await issueToken(c.env.DB, effectiveAdmin.id, now);

    return c.json({
      ok: true,
      token,
      user: { id: effectiveAdmin.id, name: effectiveAdmin.name, is_admin: true },
    });
  };

  app.post("/api/setup/nuvio", async (c) => {
    const total = await profileCount(c.env.DB);
    if (total > 0) return c.json({ error: "registration closed" }, 403);
    return handleNuvioAuth(c);
  });
  app.post("/api/admin/login", handleNuvioAuth);

  app.notFound(async (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not found" }, 404);
    }
    if (JELLYFIN_ROUTE_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) {
      const key = `${c.req.method} ${c.req.path}`;
      const at = Math.floor(Date.now() / 1000);
      if (at - (routeMissLogAt.get(key) ?? 0) >= ROUTE_MISS_LOG_SECONDS) {
        routeMissLogAt.set(key, at);
        const shape = [...new URL(c.req.url).searchParams.keys()].sort().join("+").slice(0, 160) || "none";
        const { client, device } = clientInfo(c.req.raw);
        const who = client ? `${client}${device ? ` on ${device}` : ""}` : "anonymous";
        try {
          await logApp(c.env.DB, {
            at,
            level: "warn",
            kind: "route404",
            profileId: "anonymous",
            message: `${c.req.method} ${c.req.path} q=${shape} client=${who}`,
            url: c.req.url.slice(0, 500),
          });
        } catch {
          void 0;
        }
      }
    }
    if (c.req.path.includes("/Subtitles/")) {
      const parts = c.req.path.split("/");
      const shape = [...new URL(c.req.url).searchParams.keys()].sort().join("+").slice(0, 40) || "none";
      const ordinal = Number(/\/Subtitles\/(\d+)/.exec(c.req.path)?.[1] ?? NaN);
      try {
        await logSubtitleServe(c.env.DB, {
          at: Math.floor(Date.now() / 1000),
          profileId: "anonymous",
          itemId: parts[2] ?? "",
          index: Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : -1,
          format: parts[parts.length - 1]?.startsWith("Stream.") ? (parts[parts.length - 1] as string) : "",
          outcome: `404 unmatched route ${c.req.method} ${c.req.path.slice(0, 180)} q=${shape}`,
          ms: 0,
          size: 0,
          url: "",
        });
      } catch {
        void 0;
      }
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}

const workerApp = createApp();

export { SchedulerDO } from "./scheduler";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    ensureScheduledRun(env, ctx);
    return workerApp.fetch(request, env, ctx);
  },
};
