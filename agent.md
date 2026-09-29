# Jellino — Agent Specification & System Architecture

This document serves as the single source of truth for AI agents and developers working on **Jellino**. It details the core philosophy, architectural invariants, behavior rules, database schemas, and workflows.

---

## 0. AI Assistant Operating Protocol (How to Work With the User)

### Operating Philosophy
- **The user is NOT a developer:** Never overwhelm the user with raw compiler output, deep AST internals, or convoluted engineering jargon. Explain concepts in simple, direct, non-developer terms.
- **Always follow established reference projects:** The user does not want to invent ad-hoc designs, custom architectures, or unproven mechanisms from scratch. Jellino's strength comes from following more experienced projects and developers (such as [AIOMetadata](https://github.com/cedya77/aiometadata), [Remux](https://github.com/lostb1t/remux), [Nuvio self-host](https://github.com/NuvioMedia/self-host), [NuvioTV](https://github.com/NuvioMedia/NuvioTV), [Sink](https://github.com/ccbikai/sink), [NodeWarden](https://github.com/Cian911/nodewarden), [YAOS](https://github.com/mkoehnke/yaos)).
- **Keep it simpler with small deviations:** Follow upstream references as the primary baseline, keeping Jellino simpler with only small, deliberate deviations and fixes as needed to optimize for Cloudflare Free Tier or user experience. Always prefer already-established patterns over reinventing anything.

### When the User Asks "Check for Updates", "What Changed", or "Update the Project"
1. **Check Upstream References:** Inspect the reference checkouts in `tmp/` (or upstream remotes) against the pinned commits listed in `docs/reference-projects.md`.
2. **Summarize Simply:** Explain in clear, plain language what changed upstream and why the original author made the change.
3. **Ask Simply Before Adopting:** Ask the user directly: *"Project X made change Y because of Z. Would you like to adopt this approach in Jellino?"*
4. **State Trade-offs Clearly:** Mention whether adopting it impacts Cloudflare Free Tier limits, speed, or client compatibility (e.g. Moonfin or Odin).
5. **Wait for Approval:** Do not implement large structural changes or new upstream methods until the user gives the go-ahead.

---

## 1. Project Philosophy & Core Purpose

- **What is Jellino?**
  Jellino is a lightweight, zero-cost bridge running on **Cloudflare Workers** (Free Tier) that speaks the **Jellyfin protocol** on the frontend (for clients like Moonfin, Odin, Swiftfin, and Jellyfin Web) and connects to the **Stremio & Nuvio addon ecosystem** on the backend.
- **Why Jellino exists (owner's goal — never lose sight of this):**
  Apple banned Stremio, Nuvio, and every App Store app that supports third-party addons. Jellino was built so the owner can keep watching their own **Nuvio addons, Nuvio library, watch history, and favorites on iPhone, iPad, and Apple TV through Moonfin and Odin**. It is a **Nuvio-ecosystem bridge first**, not a general-purpose media server and not a Jellyfin feature clone.
- **Scope rule (do not violate):**
  Every feature must do at least one of these:
  1. Serve the Stremio/Nuvio addon ecosystem (catalogs, streams, subtitles, metadata).
  2. Mirror the owner's Nuvio account (profiles, addons, home layout, watch progress, watched items, favorites, collections).
  3. Make a Jellyfin client render that addon data correctly and beautifully.
  Anything that only lives inside Jellino with no Nuvio or addon counterpart **must not be built**. Personal star ratings are the canonical example of what not to add: Nuvio has no rating sync, so the data would be invisible in every Nuvio app, sync nowhere, and only burn free-tier usage and maintenance. Profile backup/restore is the second: the Nuvio account *is* the backup, so a Jellino export would only duplicate profiles, addons, and watch state that already live in Nuvio. Before building anything, ask: *"Does Nuvio have this? Does an addon provide this?"* If both answers are no, stop.
- **Rendering goal:**
  Moonfin and Odin should look like a real Jellyfin server. Every item must carry the artwork and metadata addons provide: posters, backdrops, season posters, episode stills, logos, overviews, genres, ratings, cast, and clean home/library rows. Missing artwork is a bug; a Jellyfin-only state store is not a feature.
- **Hardware & Cost:**
  Runs 100% on Cloudflare Free Tier (Workers, D1, R2, Cache API). Zero servers, zero VPS, zero recurring cost.
- **Client Focus:**
  Primary target clients are **Moonfin** and **Odin**.
- **Nuvio-Only Scrobbling:**
  Jellino never integrates with Trakt or any other scrobbler. All progress, watched, and favorite state goes to the Nuvio account only. If the owner has Trakt (or another service) connected inside Nuvio, Nuvio forwards the sync; adding a second scrobbler account to Jellino would violate the scope rule.
- **Addons Are Managed in Nuvio:**
  While a Nuvio account is linked, addons are added, removed, and reordered at `https://nuvio.tv/account?tab=addons` (or in the Nuvio app), then synchronized. Jellino's addon editor stays read-only and must never become a second source of truth.

---

## 2. Inviolable Architectural Rules

1. **Strict Zero-Comment Standard in `src/`:**
   - **NO comments** (single-line `//`, multi-line `/* */`, or JSDoc) are permitted in `src/`. Code must be self-explanatory with descriptive naming.
2. **Bun-Only Environment:**
   - Always use `bun`. Never use `npm`, `npx`, or `pnpm`.
   - Commands: `bun run typecheck`, `bun test tests/*.test.ts`.
3. **Zero Media Byte Proxying:**
   - The Cloudflare Worker **never** touches, proxies, or transcodes video bytes. Streams are returned as direct HTTP URLs or 302 redirects straight to the client.
4. **Unified Versioning:**
   - The runtime build identity is the `package.json` version, imported at build time (`BUILD_ID = v<version>` in `src/version.ts`). The dashboard `/api/version` row, the GitHub release tag, and the release workflow's bump commit must always name the same version. Never hand-maintain a second build counter — a manual `bNNN` id is how the dashboard and the deployed tag drifted apart.
5. **Cloudflare Free-Tier Safeguards:**
   - Strict budget per day for a family of 6:
     - Worker Requests: < 100,000 / day
     - D1 Reads: < 5,000,000 / day
     - D1 Writes: < 100,000 / day
     - R2 Storage: < 10 GB
   - All static settings and profile disabled statuses are cached in Worker module memory (`settingsCache`, `profileDisabledCache`).
   - D1 writes are batched using `db.batch(...)` across schema migrations, scheduled maintenance, Nuvio synchronization, and addon/favorite updates to eliminate round-trip overhead.
   - Watch state progress reports are debounced to 10-second intervals or >10-second position deltas. Pauses and stops commit immediately.
6. **Client-Facing Detail Invariants (never trade these for security, caching, or speed):**
   - **Versions button:** Moonfin draws its Versions button when `item.mediaSources.length > 1`. Every playable detail response for a movie or episode must therefore carry at least two `MediaSources` and always `EnableMediaSourceDisplay: true`. When the client asks for `Fields=MediaSources` (Moonfin always does, via `kDetailItemFields`), resolve the real sources and their subtitle tracks; when resolution yields nothing, fall back to the two placeholders (`Streams load when played` + `Load the stream list`) instead of an empty list. Never return `MediaSources: []` on a playable detail. A plain detail load (no `Fields`, no `MediaSourceId`) may stay placeholders.
   - **Subtitles button:** Moonfin's Subtitles button appears when the selected source's `MediaStreams` contain a `Subtitle` entry (or the user policy allows remote subtitle search). Real source resolution must therefore attach the external subtitle tracks to each source (and embedded ones from the stream probe). Do not strip subtitle streams for speed; that is what empties the picker.
   - **Marker source:** the second placeholder carries the `ph.…` marker id and must keep unwrapping to its item id in `PlaybackInfo` and `/Videos/:id/stream`, so selecting "Load the stream list" (or playing the marker directly) reaches the real streams.
   - **Latency is the accepted cost:** resolving on a detail request that asked for sources is mandatory even though it costs seconds; AIOMetadata's Jellyfin bridge awaits the same resolution. A missing button or an empty picker is a worse bug than a slower detail page.
7. **Artwork Is Never Host-Restricted (non-negotiable):**
   - Addon art URLs are data, not a security boundary. Never add host allowlists, whitelists, or trusted-host sets for image/artwork URLs. Validate only the scheme (`http`/`https`); reject `javascript:`, `data:`, `ftp:`, relative, and other schemes. Any host an IPTV, TMDB, TVDB, rating-poster, or custom addon serves from must work.
   - **How AIOMetadata does it (the reference):** its `/Items/:itemId/Images/:imageType` route resolves the URL from its own metadata and either **302-redirects** to the addon URL, or (when it reshapes the poster) fetches those same bytes through `cachedArtwork` — an `LRUCache` (64 MB / 6 h defaults) with coalesced in-flight loads — and serves them. User avatars 302 straight to the profile avatar URL. No host filter anywhere; only their own fetch path is bounded by the cache.
   - Jellino does the redirect flavor: image tags carry the addon URL itself (`art_<base64url>`) and redirect to it, and the meta-fallback route redirects to whatever URL the addon's meta names. If a future security pass wants SSRF protection, it must constrain the Worker's own fetch destinations (for example private/link-local addresses or obviously non-addon endpoints), never the client-visible image URLs the addons provide. Do not merge those two concerns.

---

## 3. Subsystem Behaviors & User-Agreed Specifications

### A. Subtitle Delivery (AIOMetadata Method)

> **Credit & Source of Truth.** This pipeline is a direct port of **AIOMetadata**'s Jellyfin integration — [github.com/cedya77/aiometadata](https://github.com/cedya77/aiometadata) on branch **`dev`**, pinned at commit `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29). The upstream files are `addon/lib/jellyfin/subtitles.ts` and `attachExternalSubtitles` / `subtitleHandler` in `addon/lib/jellyfin/index.ts`.
>
> **Before changing anything subtitle-related:** check `tmp/aiometadata` on `dev` against pinned commit `f5846af7`. Jellino's subtitle implementation must stay **1:1 with AIOMetadata** — same cue parsing, same `pickSubtitles`, same advertised field set, same format negotiation, same conversion, same 502-on-failure.
>
> **Intentional Deviations:** (1) `SUBTITLES_PER_LANGUAGE = 8` (upstream default is 3), (2) multi-addon fanout querying all enabled subtitle addons, (3) legacy character encoding auto-detection (`decodeSubtitleBytes`, e.g. Windows-1256 Arabic) where upstream assumes UTF-8, (4) transparent gzip decompression (`decompressIfNeeded` for `.srt.gz`), (5) Cloudflare Cache API with `rebuildOffer` fallback, (6) unified D1 `app_log` observability (category `subtitle`).

The pipeline is **list → pick → advertise → click → fetch/convert → serve**, deliberately the same method as AIOMetadata's Jellyfin integration: no proxying, no retry chain, no fallback bodies. A click either serves the converted file or answers 502.

**1. Listing**
- **One List Call per Addon:** Every addon that advertises the `subtitles` resource is asked once for the video id (the episode's `tt…:s:e` when there is one) with the default source's file hints (`videoHash`, `videoSize`, `filename`). Stream-attached subtitles (`stream.subtitles`) are merged in first and deduplicated by URL. No candidate probing, no per-episode filtering.
- **MicroDVD Exclusion:** Bare `.sub` URLs are dropped at list time because no client can render them.
- **Round-Robin Pick:** `pickSubtitles` keeps the first eight tracks of every language (`SUBTITLES_PER_LANGUAGE = 8`, deliberate deviation from upstream 3), then takes one round at a time across languages up to 40 (`SUBTITLES_MAX = 40`), so a late language is never lost to a cap. The `English 2`-style ordinal comes from that round number. No custom ordering, no language priority.
- **Embedded Tracks:** Probe-reported embedded tracks are advertised before external ones and count toward the index base.

**2. Advertisement**
- **Full Jellyfin Field Set:** Each external track advertises `Type/Index/Codec/Language/Title/DisplayTitle` (`${title} (external)`), the `Is*` flags, `DeliveryMethod: "External"`, and both `DeliveryUrl` and `Path` — exactly the fields AIOMetadata sends.
- **Index-Addressed Delivery:** `DeliveryUrl` is `/Videos/{item}/{source}/Subtitles/{index}/0/Stream.{format}?ApiKey=…`; the external index starts after video/audio/embedded streams. The offered list is kept per owner/item/source for an hour (`rememberOffered`), and the click resolves `tracks[index - embedded]`. If the edge record expired, the route rebuilds it from the same list call.
- **Format Negotiation:** `subtitleFormatFor` is a direct port: ASS source + profile accepts ass → `Stream.ass`; Kodi → `Stream.srt`; profile accepts vtt → `Stream.vtt`; srt → `Stream.srt`; ass → `Stream.ass`; otherwise `Stream.vtt`.

**3. Fetch and conversion**
- **Single Fetch, 502 on Failure:** The clicked URL is fetched once (`redirect: follow`, 15 s cap, 5 MB cap), decoded, converted to the requested format, and served with `Cache-Control: private, max-age=3600`. A failure answers 502 with an empty body — there is no alternate-file chain, no proxy, and no fallback cue.
- **Conversion:** SRT/VTT/ASS are parsed into cues and re-stamped (`cuesToVtt`/`cuesToSrt`/`cuesToJellyfinJson`); ASS is passed through untouched when the client asked for ass.
- **Legacy Encodings:** Upstream bytes are decoded by BOM, UTF-16 pattern, strict UTF-8 validation, then a language-hinted legacy table (Windows-1256 for Arabic, 1251 for Cyrillic, Shift-JIS, GBK, …). Arabic providers still ship Windows-1256, and serving mojibake is a failure.

**4. Caching**
- **Edge Caches:** List responses, converted bodies, and offered menus live in the edge cache for one hour each; nothing subtitle-related is written to R2, and maintenance does not prune subtitle objects.

**5. Observability**
- **Forensic Subtitle Log:** Every serve, 401, 404, and 502 lands in D1 `app_log` under category `subtitle` (timestamp, item, track, format, outcome, exact upstream URL, bytes, latency, profile). A subtitle-shaped path no route matches is logged as `404 unmatched route`; a `//Videos/...` double-slash path is rewritten in place (no 308) and logged as `double-slash rewritten` so clients that concatenate `baseUrl + DeliveryUrl` still get a body. Failures also record the offer state (`src`, `embedded`, track count, `recalled`/`rebuilt`) so a stale index is diagnosable from the log alone.
- **Menu Row:** A playback `PlaybackInfo` writes one `menu: N external, M embedded · <client> on <device>` row per item per five minutes, so "the client never asked" is distinguishable from "the server advertised nothing".

### B. Metadata Delivery (AIOMetadata Method)

> **Credit & Source of Truth.** Metadata transformation into Jellyfin `BaseItemDto` follows **AIOMetadata**'s Jellyfin integration — [github.com/cedya77/aiometadata](https://github.com/cedya77/aiometadata) on branch **`dev`**, pinned at commit `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29). The upstream files are `addon/lib/jellyfin/items.ts`, `dto.ts`, and `people.ts`.

- **DTO Mapping:** Follows AIOMetadata's `metaToBaseItem`, `buildEpisodes`, and `buildSeasons` 1:1, but extracts richer metadata (`Studios`, `ProductionCompanies`, `Taglines`, `Status`, `CriticRating`, `RecursiveItemCount`, dynamic aspect ratios) from `meta.app_extras`.
- **Episode Paging Optimization (commit `f3835d19`):** `/Shows/:id/Episodes` slices the raw video array by `StartIndex` and `Limit` *before* constructing DTOs when no watch filters are active. This prevents CPU and memory spikes on long-running anime or shows with 1000+ episodes.
- **Episode Chronological Sorting:** `episodeDto` prefixes `SortName` with a 4-digit zero-padded episode index (`0001 - ...`) so alphabetical sorting in Jellyfin clients preserves exact episode sequence.
- **Per-Entry Anime Provider ID Isolation:** Per-entry anime (`kitsu`, `mal`, `anilist`, `anidb`) do not attach series-level Western IMDb/TMDB IDs to prevent Jellyfin clients from collapsing multiple anime seasons into one item.
- **Cross-Addon Fallback (`meta-merge.ts`):** Queries up to two auxiliary metadata addons if the primary addon returns sparse fields (missing cast, missing episode lists, or missing season posters).

### C. Stream Fetching & Playback

> **Credit & Source of Truth.** Stream transformation into Jellyfin `MediaSourceInfo` and `MediaStream` follows **AIOMetadata**'s Jellyfin integration — [github.com/cedya77/aiometadata](https://github.com/cedya77/aiometadata) on branch **`dev`**, pinned at commit `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29). The upstream files are `addon/lib/jellyfin/streams.ts` and `addon/lib/jellyfin/index.ts`.

- **Small-Caps & Unicode Normalization (`foldLabel`):** Debrid scraper stream titles containing Unicode small capitals (`ᴀ`–`ᴢ`) and zero-width characters (e.g. `ᴜʜᴅ`, `ʜᴇᴠᴄ`, `ʜᴅʀ`, `ᴅᴠ`, `ᴀᴛᴍᴏs`) are unfolded to ASCII before tag and codec matching, ensuring accurate HDR and resolution badges.
- **Video Route Aliases:** Direct video streams are served at `/Videos/:id/stream`, `/Videos/:id/stream.:ext`, `/Videos/:id/stream/:filename`, `/Videos/:id/original`, `/Videos/:id/original.:ext`, and `/Videos/:id/original/:filename`.
- **MediaSources Endpoints:** Both scoped (`/Users/:userId/Items/:id/MediaSources`) and unscoped (`/Items/:id/MediaSources`) endpoints are exposed for Infuse and Kodi clients.
- **SupportsProbing Rule:** Set to `false` on Cloudflare Workers to prevent subrequest/CPU exhaustion from remote HTTP range probing.
- **Addon Video Ids:** An episode's stream request carries the video's own `id` from the item meta (`tt…:s:e`, `xtremio_episode_…:s:e`), the id Stremio and Nuvio send. Addons whose episode ids are not the synthesized `seriesId:season:episode` form (such as xTremio) answer `{"streams":[]}` to the synthesized id, so playback and episode warming resolve the id from meta first.
- **No Deduplication, No Dropping:** Every stream returned by every enabled addon is preserved as-is. Never filter, deduplicate, or alter stream titles or release tags.
- **Ordering:** Streams are ordered by the user's configured addon priority in their profile.
- **Pure Bridge, No Slicing, No Caps:** Jellino acts strictly as a bridge. There is no addon slicing (`MAX_PLAYBACK_ADDONS`) and no source capping (`MAX_SOURCES`); it queries all configured addons and waits as long as the addons take. The only safeguard is a server-side request timeout for outbound addon calls (default 30 s, 5-120 s, configurable in Settings → General) as a deadlock guard against hung upstreams — the addons' answers are never filtered.
- **Direct Play:** All streams are returned as direct playable HTTP sources (`DirectPlay`).
- **Playable Only:** An addon entry with no `url` is not media. `externalUrl`-only entries (browser links such as YouTube) and `infoHash`-only torrents are excluded from media sources rather than handed to a player that cannot open them.
- **Version Picker and Placeholder Sources:** Detail responses for playable items always carry `EnableMediaSourceDisplay: true` and never fewer than two `MediaSources`, because Moonfin draws its Versions button whenever `item.mediaSources.length > 1`. A detail request that asks for `Fields=MediaSources` (Moonfin always does) resolves the real sources and their subtitle tracks inline so the Versions picker lists real versions and the Subtitles button gets real tracks; if resolution returns nothing, the response falls back to the two placeholders (`Streams load when played` and `Load the stream list`) rather than an empty list. A plain detail load stays on placeholders, and `PlaybackInfo` always resolves fresh. The marker id (`ph.…`) unwraps to its item id in `PlaybackInfo` and `/Videos/:id/stream`, so a client that plays or probes the marker lands on the real streams. Season and episode listings carry the same two placeholders.

### D. Media Segments (Intro/Outro/Recap Skips)

> **Credit & Source of Truth.** Media segment detection and resolution follows **AIOMetadata**'s Jellyfin skip pipeline — [github.com/cedya77/aiometadata](https://github.com/cedya77/aiometadata) on branch **`dev`**, pinned at commit `f5846af709c853abe2c77e09c1b8fa757c70006d` (synced 2026-09-29). The upstream files are `addon/lib/jellyfin/segments.ts` and `addon/utils/publicmetadbUtils.ts`.

- **Provider Precedence:** Queries up to three skip providers in priority order: `PublicMetaDB` (requires optional API key, favors streaming releases) → `AniSkip` (for anime OP/ED/recap skips) → `IntroDB` (free community intro/outro/recap database). First provider to find a given segment type wins.
- **Anime MAL ID Isolation:** Only queries AniSkip when a true MyAnimeList numeric ID is verified (`mal:...` or `meta.mal_id`), preventing Kitsu IDs from erroneously querying unrelated MAL anime.
- **Runtime Propagation:** Supplies target `runtimeMs` from metadata to allow length-based release matching on AniSkip.
- **Tiered Edge Caching:** Positive segment matches are cached for 7 days; empty segment misses are cached for 5 minutes, preventing redundant upstream calls across household profiles.

### E. Playback Progress & Watch State
- **Debounced Writes:** Progress ticks (`/Sessions/Playing/Progress`) are only written to D1 if the playback position changes by more than 10 seconds (100,000,000 ticks) from the last recorded position.
- **Immediate Commit:** Pause and Stop events (`/Sessions/Playing/Stopped`) commit to D1 immediately.
- **Watched Threshold:** Content watched past 90% is marked as fully played (`played = 1`). Resume progress follows **Nuvio's own rule**, not Jellyfin's: anything watched at least one second (`MIN_STORE_PROGRESS_TICKS`, Nuvio's `shouldStoreProgress`) is kept and surfaces in Continue Watching, and Nuvio-side progress entries are imported as-is no matter how small. Only a sub-second stop is discarded, and that stop deletes the Nuvio progress row so nothing appears there either. This exists because a short watch used to pass Nuvio's 1 s store rule while Jellino's 5 % / 90 s minimum wiped it locally, so Continue Watching disagreed between Moonfin and every Nuvio app.
- **Manual Marking:** Marking watched or unwatched works through both the scoped routes (`/Users/:userId/PlayedItems/:itemId`) and the legacy routes Moonfin clients call (`/UserPlayedItems/:itemId`, `/UserFavoriteItems/:itemId`, with an optional `userId` query that must match the token owner). Toggling watched resets the resume position to 0 and syncs the full state to Nuvio: marking pushes a watched-history entry **and deletes the Nuvio progress row**; unmarking deletes the history entry **and deletes the progress row**. That is exactly what Nuvio's own apps do (`WatchProgressRepository.clearProgress` on both toggles) and what Jellyfin does (`MarkPlayed(resetPosition: true)`), so a toggle never leaves a phantom resume point on either side.
- **Completion Resets Position:** A stop past 90% marks the item watched, clears the local resume position, and pushes the watched entry plus a Nuvio progress deletion instead of a progress upsert. A completed item therefore stops appearing in Continue Watching in both Jellino and Nuvio, while re-watching writes fresh progress normally.
- **Nuvio Removals Propagate Back:** Removing an item from Continue Watching in the official Nuvio app clears the same row in `watch_state`, so Moonfin stops offering it without any local action. This runs through the watch-progress delta feed rather than the snapshot (see Nuvio Account Synchronization), and Resume/NextUp wait for the throttled refresh before building their rows so a removal is visible on the first home load, not the second.
- **Local Activity Wins Races:** A delta delete never clears a row that Moonfin wrote within its grace window — `NUVIO_PROGRESS_DELETE_GRACE_SECONDS` (300 s) for continue-watching removals and `NUVIO_WATCHED_DELETE_GRACE_SECONDS` (60 s) for watched-history removals. Progress written while watching a title removed remotely survives and is pushed back to Nuvio on the next sync. A skipped delete is not lost: it is queued and re-applied once the grace expires if the local row has not moved on (see Deferred Deletes).
- **Unified Continue Watching & Next Up:** `/Users/:userId/Items/Resume` (and `Filters=IsResumable`) unifies in-progress movies/episodes with the Next Up episode for completed episodes when a series has watched history and no active in-progress episode. This matches Nuvio and AIOMetadata behavior, ensuring clients that only show Resume on the home screen (such as Odin) seamlessly offer the next episode. Unplayed Next Up episodes carry `UserData.LastPlayedDate` matching the series latest watch activity, ensuring Moonfin `_byLastPlayedDate` comparator correctly surfaces them at the top of Continue Watching and Next Up rows.
- **Odin Card Title Resolution:** `/Users/:userId/Items?Ids=...` resolves full item DTOs (movie, series, season, episode) backed by an in-memory isolate cache (`itemDtoMemoryCache`, 500 entries, 10 min TTL) so Odin displays the true series title and poster rather than a raw IMDb id.

### F. Nuvio Account Synchronization
- **Token Keep-Alive:** Proactive refresh within a 60-second expiration window, and automatic re-authentication upon 401/403 responses.
- **Backoff:** Exponential backoff for transient Nuvio API errors (429/5xx).
- **Sync Cadence:**
  - Background scheduled cron event running every 15 minutes (`crons = ["*/15 * * * *"]`).
  - On-demand manual "Sync Now" button in the WebUI.
  - Automatic background sync on client boot and home/resume queries (`/Users`, `/Users/:id`, `/UserViews`, `/Users/:userId/Items/Resume`, `/Shows/NextUp`) if >= 60 seconds have elapsed since last sync. Resume/NextUp await the throttled (30 s) watch refresh so removals land before the rows are built.
  - Asynchronous background push (`ctx.waitUntil`) on playback stop.
- **Two-Way Continue Watching (delta sync):** Snapshots alone cannot express a deletion, so per-profile watch progress syncs through Nuvio's event feed. `sync_get_watch_progress_delta_cursor` is captured before the first snapshot and stored as `nuvio_progress_cursor:<profileId>`; afterwards every refresh pulls `sync_pull_watch_progress_delta` since the stored cursor (paged at 900, capped at 10 pages, cursor persisted after each applied page), applies events in ascending `event_id` order with the latest event per `progress_key` winning, and maps each `progress_key` (`<id>` or `<id>_s<season>e<episode>`) back to its `movie:`/`episode:` item key. `delete` events clear the local position (respecting the local-activity grace); `upsert` events reuse `mergeNuvioProgress`'s conflict rules. When a cursor is unavailable the old snapshot-only behavior remains.
- **Two-Way Watched History (delta sync):** Marking or unmarking anything as watched in Nuvio propagates to `watch_state` through `sync_pull_watched_items_delta`, stored as `nuvio_watched_cursor:<profileId>`. Watched history events are sparse (one per mark/unmark, unlike progress ticks), so an unknown cursor bootstraps by replaying the feed from event 0 in 900-event pages (10 pages per sync, cursor persisted after each page, so a large history catches up over successive syncs and never replays work twice). `upsert` marks the movie/episode played with the remote `watched_at` and clears its resume position; `delete` unmarks it and clears the position. Series-level entries without a season/episode are ignored because Jellino has no whole-series played identity to apply them to. Snapshot pulls keep working as a fast path for the first 100 entries.
- **Deferred Deletes:** A delta delete that arrives while the local row is inside its grace window (300 s progress, 60 s watched) is written to `nuvio_pending_deletes:<profileId>` with the row's `updated_at`. Every later sync re-checks each entry once its grace expires: unchanged rows are cleared or unmarked then, rows that moved on are dropped (the newer local state is pushed to Nuvio by the normal write path), and rows that are already gone are discarded. This is what keeps a quick "watch in Moonfin, remove in Nuvio" sequence from either being stomped mid-play or stranded in Continue Watching forever.
- **Bootstrap Reconciliation:** The first progress sync after this feature ships has no cursor, so delete events for already-removed items are unreachable. On that single bootstrap the snapshot is treated as authoritative: local resume rows whose IMDb id (`tt…`) is absent from a complete snapshot (fewer than the 200-row server cap) and untouched for 30 minutes are cleared once. Non-IMDb ids are never reconciled this way because Jellino cannot push them to Nuvio, so absence carries no meaning.
- **Batching:** Addons, watch progress, watched items, and library favorites are imported in batched D1 operations.
- **Isolation:** Up to 6 profiles isolated completely (indices 0 to 5).

### G. Authentication & Profile Access
- **Mandatory Credentials:** Every profile must have a local password (8 to 256 characters) to authenticate; PINs were removed. Passwordless logins are never allowed: `POST /Users/AuthenticateByName` returns 401 for any profile without a password, even when an empty password is supplied (Quick Connect stays the passwordless path).
- **Admin Enforcement:** `POST /api/admin/profiles` requires a password, and `POST /api/admin/profiles/:id/password` rejects clearing a password back to empty. Profiles imported by the Nuvio sync start without a password and stay locked until an admin sets one.
- **Quick Connect:** Supported on `/QuickConnect/*`. A 6-digit code entered on a TV or client can be authorized in the Admin WebUI dashboard to log the device in instantly without typing a password, including for profiles that have no password yet.
- **Quick Connect Security:** Authorizing a Quick Connect session for a profile other than the caller's own requires administrator privileges.
- **Browser CORS:** Every route answers with `Access-Control-Allow-Origin: *`, preflights reflect the requested headers (so `X-Emby-Authorization` and friends pass), and `Location`/`Content-Range`/`Content-Type` are exposed. Browser-based clients (Moonfin Web, Jellyfin Web) cannot fetch subtitles or call the API at all without this; auth stays header/token-based with no cookies, so the wildcard grants a cross-origin page nothing it could not already present a token for.

### H. Library Management & Layout
- **Per-Profile Scoping:** Each profile supports `inherit` (mirrors admin) or `custom` mode with isolated `builtin_sections`, `catalog_disabled`, `catalog_no_library`, `catalog_kinds`, `custom_libraries`, `library_order`, and `catalog_limits`.
- **Custom Catalog Types:** Nuvio shows catalogs of any type, so Jellino accepts every type an addon declares except non-video kinds (`music`, `audio`, `books`, …). Only the protocol names (`movie`/`movies`, `series`/`tvshows`/`show`/`shows`, exact match, case-insensitive) set a library kind; every other type stays **Mixed** rather than guessing from the word, and each catalog item's own meta type decides whether it renders as a Movie or a Series.
- **Manual Kind Override:** `catalog_kinds` maps a catalog key to `movies`, `tvshows`, or `mixed`. The Library Manager exposes an Auto/Movies/TV Shows/Mixed selector per catalog so a Mixed catalog can be typed explicitly; the override also forces the item DTO (Series vs Movie) for that catalog's items, and Nuvio sync never clears it.
- **Nuvio Is the Source of Truth:** `enabled` (from Nuvio's hidden catalogs) is read-only in the admin UI; a hidden catalog is omitted from views, search, and the home screen. The admin addon editor is likewise read-only while a Nuvio account is linked (`PUT /api/admin/profiles/:id/addons` returns 409) and reopens only when no Nuvio account exists. The Addon Manager links directly to `https://nuvio.tv/account?tab=addons`.
- **Manual Layout Re-Sync:** The Library Manager's **Sync with Nuvio** button calls `POST /api/admin/libraries/sync?profile=<id>`, which pulls that profile's Nuvio home settings and collections through the RPC helpers and re-runs `deriveLibraryFromNuvio`, restoring Nuvio's row order, titles, collections, and Nuvio-driven hidden rows without a full account sync. An inheriting profile re-derives the admin profile's layout instead of switching itself to custom mode, and Jellino-local choices (`catalog_no_library`, `catalog_kinds`, `catalog_limits`, and manual hides reconciled through `catalog_disabled_nuvio`) are preserved.
- **Nuvio Titles and Order:** The sync mirrors each profile's Nuvio home catalog settings — row order (`library_order`), hidden rows (`catalog_disabled`), custom titles, and, when Nuvio's `show_catalog_type` is on, the `catalog name - type label` title Nuvio itself displays (`library_names`). A Nuvio custom title always wins over the composed one.
- **Jellino-Local Hidden:** The admin presentation control is a three-way Home / Collection / Hidden switch. Hidden writes the catalog key to `catalog_disabled` without touching Nuvio; the `catalog_disabled_nuvio` reconciliation keeps that manual hide across Nuvio syncs, and `profileSearch` now skips disabled catalogs so a hidden row never resurfaces through search.
- **Per-Library Item Limit:** `catalog_limits` (global) / `catalog_limits:<profileId>` (scoped, custom mode) map unified row ids (`catalog:<base>|<type>|<id>`, `custom:<id>`) to a fetch size. Default 20, cap 500. On the first page of a library (`StartIndex=0`) the effective limit is `max(clientLimit, itemLimit)`, and `/Items/Latest` now fills across addon pages instead of stopping at the first one. `/Items` reports a larger `TotalRecordCount` while `hasMore` is true so clients keep paging past the old 120-item ceiling.
- **Home vs. Collection (remux-parity):**
  - `library: true` → the row is a Jellyfin `CollectionFolder` library in `/UserViews`, `/Library/MediaFolders`, and `/Library/VirtualFolders`.
  - `library: false` → the row is converted to a Jellyfin `BoxSet` (`src/library.ts` `boxSetDto`) and excluded from every view listing. BoxSets are surfaced through the synthetic **Collections** folder (`COLLECTIONS_VIEW_ID = "collections"`, `CollectionType: "boxsets"`), which is appended to the view listings only when at least one BoxSet exists. BoxSets are reachable via `IncludeItemTypes=BoxSet`, `ParentId=collections`, item detail, and generated tile images.
- **Custom Bundles:** Allows combining multiple Stremio addon feeds into a single unified virtual library.
- **Parallel Fetching:** Catalogs within custom collections and bundles are fetched concurrently via `Promise.all`.

---

## 4. Database Schema (Cloudflare D1)

All tables are initialized via a single idempotent migration [`migrations/0001_init.sql`](migrations/0001_init.sql) and mirrored in [`src/schema.ts`](src/schema.ts). Because `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already exists, `ensureSchema` also runs a self-healing column upgrade on first request per isolate: it reads `PRAGMA table_info` per table and issues `ALTER TABLE ... ADD COLUMN` for any column an older live database is missing (profile Nuvio/avatar/disabled/token-epoch columns, watch-state source/subtitle columns, addon health `latency_ms`, and `app_log` `url`/`category`), so a database created by an early build can never silently lose logging or watch state. Legacy tables from early builds (`active_sessions`, `subtitle_log`, `display_prefs`) are dropped on startup; all logs now live in `app_log`:

- `profiles`: User accounts, admin flags, Nuvio mapping, avatar colors/URLs, and token epochs.
- `profile_addons`: Per-profile enabled Stremio addons, URLs, and display order.
- `watch_state`: Per-profile watch progress (position ticks, played flag, play count, updated timestamp, chosen `media_source_id`, and preferred `subtitle_index`).
- `profile_favorites`: Favorited movies and series per profile.
- `rate_limits`: IP-based sliding window rate limits.
- `settings`: Key-value server settings.
- `quick_connect`: 6-digit code authentication state machine.
- `addon_health`: Failure counts, error messages, and upstream query latency (`latency_ms`) per addon.
- `hidden_items`: Per-profile Continue Watching / Next Up exclusions.
- `sync_tombstones`: Causal delete markers that keep stale Nuvio snapshots from resurrecting removed state.
- `app_log`: Unified application log (subtitle, stream, meta, catalog, sync, playstate, route404) with `category`/`kind`/`level` filters and 7-day retention.

---

## 5. Maintenance & Cleanup

Maintenance runs asynchronously via `runMaintenance(db, fetchImpl, now)`:
- Periodic scheduled cron event running every 15 minutes, with heavy database pruning throttled via `maintenanceDue()` to run once per hour.
- Expired Quick Connect codes, old rate-limit entries, and stale addon health rows (>30 days) are removed using batched D1 execution.
