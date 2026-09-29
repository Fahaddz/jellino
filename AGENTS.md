# AGENTS.md — rules for working on Jellino

Read this before changing anything. These rules are product decisions, not preferences.

## What Jellino is

Jellino is a **bridge/linker/converter** between a **Nuvio account** (with its Stremio addons) and **Jellyfin clients**. It speaks the Jellyfin protocol to clients and the Nuvio/Stremio addon protocols upstream. It is not a media server: no files, no storage, no transcoding, no video proxying. Streams are handed to players as direct URLs.

## Clients

- **Moonfin** is the primary target and is tested on all platforms.
- **Odin** (TestFlight, Apple only, from the Fusion dev) is tested on Apple devices. Subtitles behave better on Odin than on Moonfin clients.
- Every other Jellyfin client should work but is untested. Do not break protocol compatibility for untested clients; use Jellyfin DTO shapes that the official server emits.

## The golden rule: Jellino does not limit

Jellino must not impose product limits. Limits belong to the upstream owner:

- **Streams**: AIOStreams/the stream addons decide how many and which streams exist. Jellino renders what they report.
- **Catalog size**: AIOMetadata/addons decide how many items a catalog has and how they page. Jellino pages through the addon until the addon says there is no more.
- **Subtitles**: the subtitle addons decide what tracks exist. Jellino shows what the addon lists.
- **Watch progress**: Nuvio decides what is in progress; Jellino mirrors it.

Allowed exceptions, and only these:

1. **Upstream-ported limits.** If the reference project (e.g. AIOMetadata) has a limit, port it 1:1 rather than inventing one. Subtitle menu caps (`SUBTITLES_PER_LANGUAGE`, `SUBTITLES_MAX`) exist in AIOMetadata to keep client menus usable and to avoid hammering providers, so they stay — except that `SUBTITLES_PER_LANGUAGE` is deliberately 8 instead of AIOMetadata's 3 (see the README deviations table).
2. **Request budgets and timeouts.** Per-request page budgets (`MAX_WINDOW_PAGES`, `MAX_CATALOG_PAGES`) and network timeouts exist to keep a single request inside Cloudflare limits and must never cap what a user can eventually see: scrolling always walks further.
3. **Jellyfin protocol requirements.** Total counts, field shapes, and pagination headers are protocol obligations, not product limits.

Never add a setting or a control that lets Jellino cap upstream output. "Addon request timeout" was removed for exactly this reason: AIOStreams already enforces its own timeouts.

## Nuvio is the single source of truth

- There are **no local accounts**. Setup is Nuvio sign-in. A Nuvio account is mandatory.
- **Profiles** are created, renamed, disabled, and deleted only in Nuvio; the hourly sync mirrors that. Jellino admins can only set a per-profile client password or use Quick Connect.
- **Addons** are managed only in Nuvio. Jellino has a read-only addon view.
- **Library layout** (rows, order, titles, hidden catalogs, collections) is Nuvio's home catalog settings. There is no library editor and no local ordering/capping.
- **Watch state, watched items, favorites** live in Nuvio. Favorites are the Nuvio Library. If a scrobbler is connected inside Nuvio, Nuvio handles it; Jellino never talks to third-party trackers.

## Sync rules

- Pull: resume/next-up/upcoming refresh the profile snapshot at most once per 60 s (single-flight, fingerprint skip when unchanged).
- Reconcile: hourly full pull; the only place remote deletions are inferred; fail-closed (a failed pull never clears local state).
- Push: immediately on playback start, on stop, and throttled while playing; mark watched/unwatched and favorite toggles push right away.
- Deletes are causal: write a tombstone before the remote delete so stale snapshots cannot resurrect anything.
- `ExcludeContinueWatching` / `UserHiddenItems` follow Nuvio semantics (removing progress) and filter Resume.
- **Resume shows one row per series** (the most recently updated in-progress episode) plus one row per movie. Next Up shows the next episode. Never list several episodes of the same series in Continue Watching.

## Reference projects rule

Every feature follows a pinned upstream project, 1:1 where the protocol allows. The map, pinned commits, and the update procedure live in `docs/reference-projects.md`. When behavior is defined upstream, port it instead of inventing it. If a field has no upstream source, document it in the README "Known gaps" instead of approximating.

Key owners: AIOMetadata (subtitles, metadata, segments, streams DTOs), Remux (Jellyfin protocol surface and admin theme), Nuvio self-host (account schema and RPCs), NuvioTV/Mobile/Desktop (tracking behavior), jellyfin/jellyfin (protocol shapes).

**Deviation rule:** any change or fix to a feature that follows a reference 1:1 must be recorded in the README's "Deliberate deviations from the references" table (feature, reference behavior, our behavior, why). That table is the reason future upstream syncs do not silently revert our decisions. The subtitle per-language limit (8, not 3) is the current example.

### Upstream Reference: AIOMetadata Metadata Pipeline
- **Upstream Repository:** `https://github.com/cedya77/aiometadata`
- **Branch:** `dev`
- **Pinned Commit:** `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29)
- **Source Files in AIOMetadata:**
  - `addon/lib/jellyfin/items.ts` (`metaToBaseItem`, `buildEpisodes`, `pageEpisodes`, `buildSeasons`, `providerIds`, `sortNameFor`, `includeTypesFilter`)
  - `addon/lib/jellyfin/dto.ts` (`publicSystemInfo`, `systemInfo`, `userDto`, `collectionFolder`)
  - `addon/lib/jellyfin/people.ts` (`personByName`, `similarTitles`, `personCredits`)
- **Jellino Destination Files:**
  - `src/meta.ts` (`movieDto`, `seriesDto`, `seasonDto`, `episodeDto`, `providerIds`, `sortNameFor`)
  - `src/people.ts` (`personByName`, `similarTitles`, `personCredits`, `photoImageTag`, `personAvatarSvg`)
  - `src/index.ts` (`/Shows/:id/Episodes`, `/Shows/:id/Seasons`, `/Items`, `/Artists`, `/Persons`)
- **Parity & Key Enhancements:**
  1. **Episode Pagination Before DTO Mapping:** `/Shows/:id/Episodes` slices raw video entries before building DTOs (upstream commit `f3835d19`), preventing CPU/memory exhaustion on 1000+ episode anime series.
  2. **Episode SortName Chronological Padding:** Episode `SortName` is prefixed with 4-digit zero-padded episode index (`0001 - ...`) to ensure correct chronological sorting in Jellyfin clients.
  3. **Per-Entry Anime Provider ID Isolation:** Prevents attaching parent series IMDb/TMDB IDs to per-entry anime (`kitsu`, `mal`, `anilist`, `anidb`) so Jellyfin clients do not fold separate seasons together.
  4. **Richer DTOs:** Jellino populates `Studios`, `ProductionCompanies`, `Taglines`, `Status`, `CriticRating`, `RecursiveItemCount`, and dynamic `PrimaryImageAspectRatio` from `app_extras` which upstream hardcodes empty.
  5. **Watched Filters (upstream `2d6c53e`):** `Filters=IsPlayed`/`IsUnplayed` and the standalone `IsPlayed=true/false` query flags both filter library and home listings (`requestedFilters` in `src/index.ts`).
- **How to Sync Future Upstream Updates:**
  1. Run `git -C tmp/aiometadata fetch origin && git -C tmp/aiometadata diff f5846af709c853abe2c77e09c1b8fa757c70006d..origin/dev -- addon/lib/jellyfin/items.ts addon/lib/jellyfin/dto.ts addon/lib/jellyfin/people.ts`
  2. Port any new field mappings or performance adjustments into `src/meta.ts`, `src/people.ts`, or `src/index.ts`.
  3. Run `bun run typecheck && bun test tests/meta.test.ts`.

### Upstream Reference: Nuvio Account Model & Tracking Sync
- **Upstream Repositories:**
  - `https://github.com/NuvioMedia/NuvioTV` (`dev` branch, commit `c257a2365e`)
  - `https://github.com/NuvioMedia/NuvioMobile` (`cmp-rewrite` branch, commit `fc4608d292`)
  - `https://github.com/NuvioMedia/NuvioDesktop` (`Dev` branch, commit `b1e00724c5`)
  - `https://github.com/NuvioMedia/self-host` (commit `39ea2bd1bc`)
- **Note:** The previous NuvioTV pin (`8a38b0dec4`) no longer exists upstream; the branch was rewritten.
- **Source Files in Upstream:**
  - `NuvioMobile`: `SupabaseProgressSyncAdapter.kt`, `SupabaseWatchedSyncAdapter.kt`, `SupabaseLibrarySyncAdapter.kt`
  - `NuvioTV`: `WatchProgress.kt` (`COMPLETED_THRESHOLD = 0.90f`, `STARTED_THRESHOLD = 0.02f`)
- **Jellino Destination Files:**
  - `src/nuvio.ts`, `src/nuvio-home.ts`, `src/sessions.ts`, `src/cron.ts`
- **Parity & Key Behaviors:**
  1. **Threshold Alignment:** Jellino uses `MAX_RESUME_PCT = 90` (matching Nuvios 90% threshold for marked-as-watched).
  2. **1-to-1 DTO Fields:** Progress, Watched, and Library RPC payload contracts match upstream fields (`content_id`, `content_type`, `video_id`, `progress_key`, etc.).
  3. **Bidirectional Tombstones:** Deletions from both sides are tombstoned to prevent stale items from resurfacing.
  4. **Multi-Profile Free-Tier Throttling:** Strict 60s per-item push debouncing prevents Cloudflare Worker subrequest limit exhaustion across concurrent profiles.

### Upstream Reference: Jellyfin Client Compatibility & Quick Connect
- **Upstream Repository:** `https://github.com/jellyfin/jellyfin` and `https://github.com/lostb1t/remux`
- **Source Files in Upstream:**
  - `jellyfin`: OpenAPI spec for `QuickConnectResult`, `/QuickConnect/*`, `/Localization/*`, `/Branding/*`, `/Sessions/*`, `/Users/*`
  - `remux`: `crates/remux-server/src/api/system.rs`, `crates/remux-server/src/api/users.rs`
- **Jellino Destination Files:**
  - `src/quickconnect.ts`, `src/stubs.ts`, `src/session.ts`
- **Parity & Key Behaviors:**
  1. **QuickConnect Protocol:**
     - Both `GET` and `POST` handled on `/QuickConnect/Enabled` and `/QuickConnect/Connect`.
     - `QuickConnectResult` returns `AuthenticationToken: secret` when authenticated (or `null` when pending), meeting Jellyfin 10.9 OpenAPI client polling requirements.
     - `/QuickConnect/Authorize` reads `userId` / `UserId` from both query parameters and JSON body.
  2. **Pre-Login Probes & Clock Sync:**
     - `GET /GetUtcTime` and `/getutctime` return current ISO timestamps (`RequestReceptionTime` / `ResponseTransmissionTime`), preventing pre-login connection warnings on Android TV and Tizen.
  3. **Branding & SyncPlay Stubs:**
     - `GET /Branding/Css.css` aliased to `/Branding/Css`.
     - `GET /SyncPlay/List` returns `[]` matching `SyncPlayAccess: "CreateAndJoinGroups"`.
  4. **Telemetry & Client Capabilities:**
     - Handles `/Sessions/:id/Capabilities` and `/Sessions/:id/Capabilities/Full`.
     - Handles `/Sessions/Viewing` and `/Sessions/:id/Viewing`.
     - Handles `/Users/:id/GroupingOptions`, `/Users/:id/Configuration`, and `/Users/:id/Policy`.
     - Provides `/Localization/Countries`, `/Localization/Cultures`, and `/Localization/ParentalRatings`.

### Upstream Reference: Remux Protocol Surface & Session Management
- **Upstream Repository:** `https://github.com/lostb1t/remux`
- **Branch:** `main`
- **Pinned Commit:** `816aacb935af72e4f5d920a245030e3dbac3f794` (synced 2026-09-29)
- **Source Files in Remux:**
  - `crates/remux-server/src/api/session.rs` (`report_playback_stopped`, `report_playback_progress`, `sessions_capabilities_full`, `get_sessions`, `remote_play`, `remote_playstate_command`)
  - `crates/remux-server/src/api/items.rs`
  - `crates/remux-dashboard` (admin dashboard theme and CSS variables)
- **Jellino Destination Files:**
  - `src/sessions.ts` (`sessionBody`, `clearProgressDebounce`)
  - `src/watch-state.ts` (`applyStopPosition`, `writeWatchPosition`, `readWatchPosition`, `setPlayed`, `itemKey`)
  - `src/ui/remux-css.ts`, `src/ui/admin-client.ts`
- **Parity & Key Enhancements:**
  1. **Positionless Stop Preservation (upstream `da012b7`):** When a client issues `/Sessions/Playing/Stopped` without providing `PositionTicks`, Jellino checks in-memory debounced progress and persisted D1 watch position before defaulting to 0, ensuring playback position is never accidentally erased.
  2. **Direct-Play Optimization:** Unlike Remux which runs local ffmpeg transcoding, Jellino operates as a pure direct-play bridge for Cloudflare Workers isolates without spawning subprocesses or probing over HTTP range.
  3. **Tolerant Boolean Query Values (upstream `f50c400`):** `boolQuery` in `src/query.ts` accepts boolean query parameters case-insensitively and as `1`/`0`, matching upstream's generated query deserializers.
- **How to Sync Future Upstream Updates:**
  1. Run `git -C tmp/remux fetch origin && git -C tmp/remux diff 816aacb935af72e4f5d920a245030e3dbac3f794..origin/main -- crates/remux-server/src/api/session.rs crates/remux-server/src/api/items.rs crates/remux-dashboard/`
  2. Check for session protocol or client capability changes. Boolean query values must stay case-insensitive and accept `1`/`0` (`src/query.ts` `boolQuery`).
  3. Run `bun run typecheck && bun test tests/sessions.test.ts`.

### Upstream Reference: AIOMetadata Stream & MediaSource Pipeline
- **Upstream Repository:** `https://github.com/cedya77/aiometadata`
- **Branch:** `dev`
- **Pinned Commit:** `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29)
- **Source Files in AIOMetadata:**
  - `addon/lib/jellyfin/streams.ts` (`mediaSourceFor`, `buildMediaStreams`, `mediaSourceIdFor`, `foldLabel`, `videoRange`, `placeholderMediaSource`)
  - `addon/lib/jellyfin/index.ts` (video streaming route aliases and `/Items/:itemId/MediaSources`)
- **Jellino Destination Files:**
  - `src/streams.ts` (`mediaSource`, `mediaSourceIdFor`, `parseTags`, `foldLabel`, `placeholderMediaSources`)
  - `src/playback.ts` (`videoRedirect`, `bareMediaSources`, `userMediaSources`, `profileMediaSources`)
- **Parity & Key Enhancements:**
  1. **Unicode Small-Caps & Zero-Width Unfolding (`foldLabel`):** Normalizes small-capital letters (`ᴀ`–`ᴢ`) and strips zero-width spaces, enabling accurate extraction of 4K/HDR/HEVC/DV/Atmos metadata from Torrentio, MediaFusion, and other debrid stream addons.
  2. **Extended Video Streaming Route Aliases:** Handles `/Videos/:id/stream`, `/Videos/:id/stream.:ext`, `/Videos/:id/stream/:filename`, `/Videos/:id/original`, `/Videos/:id/original.:ext`, and `/Videos/:id/original/:filename`.
  3. **Dedicated MediaSources Endpoints:** Implements `GET /Items/:id/MediaSources` and `GET /Users/:userId/Items/:id/MediaSources` for Infuse and Kodi clients.
  4. **Cloudflare Worker Safe Defaults:** Disables remote stream range probing (`SupportsProbing: false`) to preserve subrequest and CPU budgets, and preserves pure transparent bridge behavior without dropping or capping streams.
  5. **Full Placeholder Stream Flags (upstream `4e13dd5`):** `placeholderMediaSource` emits `ReadAtNativeFramerate`, `IgnoreDts`, `IgnoreIndex`, `GenPtsInput`, and `HasSegments` alongside the rest of the stream flags.
  6. **Suggestions Stubs (upstream `b8b4654`):** `/Items/Suggestions` and `/Users/:userId/Suggestions` answer an empty list ahead of the `/Items/:id` route instead of being read as an item id.
  7. **Not Ported — Text-Only Stream Notices (`toNotice`):** Upstream lists non-playable addon entries as extra placeholder sources behind a dashboard setting; Jellino keeps the source list to playable streams.
- **How to Sync Future Upstream Updates:**
  1. Run `git -C tmp/aiometadata fetch origin && git -C tmp/aiometadata diff f5846af709c853abe2c77e09c1b8fa757c70006d..origin/dev -- addon/lib/jellyfin/streams.ts addon/lib/jellyfin/index.ts`
  2. Check for newly supported audio/video codec mappings or route parameters and update `src/streams.ts` and `src/playback.ts`.
  3. Run `bun run typecheck && bun test tests/playback.test.ts`.

### Upstream Reference: AIOMetadata & Skip Providers Media Segments Pipeline
- **Upstream Repository:** `https://github.com/cedya77/aiometadata`
- **Branch:** `dev`
- **Pinned Commit:** `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29)
- **Source Files in AIOMetadata:**
  - `addon/lib/jellyfin/segments.ts` (`fromPublicMetaDb`, `fromIntroDb`, `fromAniSkip`, `segmentsFor`, `segmentId`)
  - `addon/utils/publicmetadbUtils.ts` (`fetchSkips`)
  - `addon/lib/jellyfin/index.ts` (`/MediaSegments/:itemId`)
- **Jellino Destination Files:**
  - `src/segments.ts` (`fetchMediaSegments`, `fromPublicMetaDb`, `fromAniSkip`, `fromIntroDb`, `segmentId`)
  - `src/index.ts` (`mediaSegmentsResponse`, `/Items/:id/MediaSegments`, `/MediaSegments/:id`, `/Users/:userId/Items/:id/MediaSegments`)
- **Parity & Key Enhancements:**
  1. **Provider Precedence (1:1 with Upstream):** Queries `PublicMetaDB` (if API key configured) -> `AniSkip` (anime OP/ED/recap) -> `IntroDB` (TV intro/outro/recap).
  2. **Anime MAL ID Isolation:** Only queries AniSkip with verified MyAnimeList IDs (`mal:...` or `meta.mal_id`), preventing Kitsu IDs from erroneously querying unrelated MAL anime.
  3. **Runtime Propagation:** Supplies target `runtimeMs` from meta to enable length-matched AniSkip results.
  4. **Tiered Edge Caching:** 7-day TTL on positive segment matches; 5-minute negative cache on misses to minimize upstream API calls and subrequests.
  5. **Not Ported — `fetchResume` Pagination:** Upstream pages `PublicMetaDB /api/external/resume`; Jellino's resume points come from Nuvio and only `fetchSkips` is ported.
- **How to Sync Future Upstream Updates:**
  1. Run `git -C tmp/aiometadata fetch origin && git -C tmp/aiometadata diff f5846af709c853abe2c77e09c1b8fa757c70006d..origin/dev -- addon/lib/jellyfin/segments.ts addon/utils/publicmetadbUtils.ts`
  2. Check for new segment types or upstream API schema updates.
  3. Run `bun run typecheck && bun test tests/segments.test.ts`.

### Upstream Reference: AIOMetadata Subtitle Pipeline
- **Upstream Repository:** `https://github.com/cedya77/aiometadata`
- **Branch:** `dev`
- **Pinned Commit:** `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29)
- **Source Files in AIOMetadata:**
  - `addon/lib/jellyfin/subtitles.ts` (formats, parsers, cue converters, language normalization, `pickSubtitles`, `subtitleFormatFor`, `subtitleCodecFor`)
  - `addon/lib/jellyfin/index.ts` (lines ~1015–1250: `attachExternalSubtitles` and `subtitleHandler` route handlers)
- **Jellino Destination Files:**
  - `src/subtitles.ts` (all subtitle parsers, cue encoders, charset decoders, gzip decompressor, language tables, addon fetchers)
  - `src/playback.ts` (`videosSubtitle` endpoint, `profileMediaSources`, `rebuildOffer`)
  - `src/streams.ts` (`subtitleStream` DTO generator)
- **Parity Status:** 1:1 with latest HEAD on `dev`. Since the initial port (`0c5cba04`) upstream changed only cache-lifetime reads in `subtitles.ts`; parsers, formats, and handlers are untouched.
- **Deliberate Deviations from Upstream:**
  1. `SUBTITLES_PER_LANGUAGE = 8`: Upstream defaults to 3 (`envInt('JELLYFIN_SUBTITLES_PER_LANGUAGE', 3, 1)`). Jellino sets this to 8 so users have more subtitle options per language. Total cap remains 40 (`SUBTITLES_MAX = 40`).
  2. **Multi-Addon Fanout:** Upstream queries only one stream addon base (`fetchAddonSubtitles`); Jellino queries all enabled subtitle-capable addons for the user's Nuvio profile (`fetchAllAddonSubtitles`).
  3. **Character Encoding Detection:** Upstream assumes raw UTF-8 strings (`raw.toString('utf8')`), breaking Arabic and non-Latin subtitles. Jellino implements `decodeSubtitleBytes` detecting UTF-8/UTF-16 BOMs and legacy code pages (Windows-1256 for Arabic, Windows-1250/1251/1252, Shift-JIS, GBK).
  4. **Transparent Decompression:** Jellino includes `decompressIfNeeded` to unpack `.srt.gz` responses from Stremio subtitle addons (which crash or serve binary upstream).
  5. **Cloudflare Cache & Dynamic Rebuild:** Upstream uses in-process Node `LRUCache`. Jellino uses Cloudflare Cache API (`caches.default`) with fallback reconstruction via `rebuildOffer` if the edge cache expires.
  6. **Observability Logging:** Jellino logs every subtitle request, latency, payload size, and outcome to D1 `app_log` (category `subtitle`) via `logSubtitleServe`.
- **How to Sync Future Upstream Updates:**
  1. Run `git -C tmp/aiometadata fetch origin && git -C tmp/aiometadata diff f5846af709c853abe2c77e09c1b8fa757c70006d..origin/dev -- addon/lib/jellyfin/subtitles.ts addon/lib/jellyfin/index.ts`
  2. If upstream changed subtitle parsing, formatting, or routing, port the logic to `src/subtitles.ts` or `src/playback.ts` while preserving the 6 deliberate deviations above.
  3. Run `bun run typecheck && bun test tests/subtitles.test.ts`.
  4. Update the pinned commit and last-synced date here and in `docs/reference-projects.md`.

### Upstream Reference: Edge Asset Caching & Artwork Delivery Pipeline
- **Upstream Pattern:** Direct CDN redirect & multi-tier edge cache hierarchy
- **Jellino Destination Files:**
  - `src/index.ts` (`imageResponse`, `avatarResponse`, `redirectResponse`)
  - `src/browse.ts` (`artworkUrl`, `rememberCatalogArt`, `readItemArt`, `sizeImageUrl`)
  - `src/people.ts` (`rememberPersonPhotos`, `readPersonPhoto`, `photoImageTag`, `personAvatarSvg`)
  - `src/library-art.ts` (`artImageTag`, `artFromImageTag`, `defaultLibraryTile`)
- **Key Behaviors & Free-Tier Optimizations:**
  1. **Tag-First Zero-Subrequest Resolution:** Client DTOs include Base64-encoded CDN URLs (`art_...`, `ph_...`). Requests to `/Items/:id/Images/:kind?tag=...` decode and issue a HTTP 302 redirect with `cache-control: public, max-age=604800, stale-while-revalidate=86400` in 0ms without hitting D1 or upstream addons.
  2. **Proactive Catalog Art Pointers (`rememberCatalogArt`):** During catalog discovery, parses and caches poster/backdrop/logo pointers in Edge Cache (`https://jellino.local/item-art/${id}`) for 7 days so tagless client fetches avoid calling upstream `/meta/`.
  3. **Responsive Image Sizing (`sizeImageUrl`):** Inspects client width parameters and rewrites TMDB URLs to `w342`, `w500`, `w780`, or `w1280` on the fly, eliminating texture memory exhaustion on smart TVs and reducing edge egress.
  4. **Edge-Cached User Avatars:** Checks `caches.default` before querying D1 for user avatars (`https://jellino.local/avatar/${id}`), eliminating D1 reads on app boots across 6 concurrent profiles. Purges edge cache on Nuvio profile reconciliation.
  5. **Instant Vector SVG Fallbacks:** Generates vector SVG avatars for cast without photos and SVG posters for custom libraries without artwork, ensuring zero 404 broken images.

## Platform constraints

- Cloudflare free tier only: one Worker, one D1 database, the Cache API. No R2, KV, Durable Objects, or Queues.
- Artwork is a 302 redirect to provider CDNs; subtitle bodies live in the Cache API.
- Advertise **Jellyfin 12.1.0** (single `SERVER_VERSION` in `src/version.ts`). Modern Jellyfin SDKs refuse versions below 12.
- Keep per-request fan-out inside Cloudflare subrequest limits. Background warming is deliberately disabled: it doubles subrequests for no user-visible gain (see the README deviations table).

## Code rules

- **Zero comments in `src/`.** CI fails on any line starting with `//` or `/*`. Document in README/docs instead.
- No status columns ("Done") in the README. Keep it short; the same information with fewer words.
- The admin client is one template string. After editing `src/ui/admin-client.ts`, check that the bundle parses AND executes: `tests/system.test.ts` guards both (every `render:` handler must exist, and the bundle must run against a minimal DOM). Admin assets are cache-busted with `BUILD_ID`.
- Settings must exist only when they control something Jellino genuinely owns. General currently exposes two optional keys: PublicMetaDB (skip-intro lookups) and TMDB (person pages).
- Log everything that helps diagnose a client problem (catalog/stream/meta/subtitle/sync failures, playstate actions, client 404s) under `app_log` categories. `logApp` buffers in memory and flushes once per request, with a 300-row cap and pruning every 50 flushes, so comprehensive logging stays cheap on D1. Filter by category in Admin → Logs & Debug.

## Commands

```bash
bun install
bun run dev        # wrangler dev with local D1
bun run test       # vitest; must pass before any PR
bun run typecheck
bun run deploy
```

Run `bun run typecheck && bun run test` before every commit. CI runs the comment guard, typecheck, and the full suite on `main`.
