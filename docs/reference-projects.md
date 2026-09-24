# Reference projects

Jellino is a bridge, not an original implementation. Each feature follows a pinned upstream project as closely as possible (1:1 where the protocol allows). This file is the contract: which project owns which feature, which commit we last synced against, and how to pull upstream changes.

Local checkouts live in `tmp/` (gitignored). Keep them shallow clones of the URLs below.

## Feature map

| Feature | Reference project | What we take | Jellino files |
| --- | --- | --- | --- |
| Subtitle pipeline (list → pick → advertise → click → fetch/convert → serve) | [cedya77/aiometadata](https://github.com/cedya77/aiometadata) (`feat/jellyfin-server`) | `addon/lib/jellyfin/subtitles.ts` + the subtitle handlers in `addon/lib/jellyfin/index.ts` | `src/subtitles.ts`, subtitle routes in `src/playback.ts` |
| Metadata → Jellyfin DTOs (movie/series/season/episode/person, artwork tags, provider ids, user data) | [cedya77/aiometadata](https://github.com/cedya77/aiometadata) | `addon/lib/jellyfin/{dto,items,people,artwork,watched}.ts` | `src/meta.ts`, `src/index.ts`, `src/people.ts` |
| Media segments (intro/outro/recap) | [cedya77/aiometadata](https://github.com/cedya77/aiometadata) + [PublicMetaDB](https://publicmetadb.com) | `addon/lib/jellyfin/segments.ts`, `addon/utils/publicmetadbUtils.ts`; provider order PublicMetaDB → AniSkip → IntroDB | `src/segments.ts` |
| Streams → Jellyfin MediaSources/MediaStreams | [cedya77/aiometadata](https://github.com/cedya77/aiometadata) (AIOStreams `parsedFile` field mapping) | `addon/lib/jellyfin/streams.ts` | `src/streams.ts`, `src/playback.ts` |
| Jellyfin protocol surface (routes, DTO shapes, ids, boxsets, views) | [lostb1t/remux](https://github.com/lostb1t/remux) | `crates/remux-server` Jellyfin API layer and DTO compatibility behavior | `src/index.ts`, `src/browse.ts`, `src/library.ts`, `src/ids.ts` |
| Admin UI theme and components | [lostb1t/remux](https://github.com/lostb1t/remux) | `remux-dashboard` styling | `src/ui/remux-css.ts`, `src/ui/admin-client.ts` |
| Nuvio account data model (profiles, addons, home catalog settings, collections, watch progress, watched items, library items, deltas) | [NuvioMedia/self-host](https://github.com/NuvioMedia/self-host) | `database/migrations/*.sql`: table shapes, RPC function signatures and semantics (`sync_pull_*`, `sync_push_*`, the 15 s / 30 s / 90 % progress guards, watched/library event feeds) | `src/nuvio.ts`, `src/nuvio-home.ts` |
| Nuvio auth and REST flows (password grant, refresh, profile/addon REST shapes) | [techuhak/Nuvio-Account-Manager](https://github.com/techuhak/Nuvio-Account-Manager) + NuvioMedia/self-host auth tables | `lib/nuvio.ts` auth and REST calls | `src/nuvio.ts`, `src/session.ts` |
| Nuvio tracking behavior (when the app writes progress, watched, continue watching, hide/drop semantics) | [NuvioMedia/NuvioTV](https://github.com/NuvioMedia/NuvioTV) | tracking call sites and state rules; cross-checked against NuvioMobile/NuvioDesktop for client differences | `src/sessions.ts`, `src/watch-state.ts`, `src/resume.ts`, `src/nuvio-home.ts` |
| Jellyfin client compatibility (Quick Connect, passwords, UserData flags, DisplayPreferences) | [jellyfin/jellyfin](https://github.com/jellyfin/jellyfin) | OpenAPI shapes and client behavior notes | `src/quickconnect.ts`, `src/session.ts`, `src/stubs.ts` |

## Pinned commits

Update this table whenever a reference is re-synced.

| Reference | URL | Pinned commit | Last synced |
| --- | --- | --- | --- |
| AIOMetadata | https://github.com/cedya77/aiometadata | `44bacb1bd4` | 2026-09-23 |
| Remux | https://github.com/lostb1t/remux | `da012b7c92` | 2026-09-23 |
| NuvioTV | https://github.com/NuvioMedia/NuvioTV | `8a38b0dec4` | 2026-09-23 |
| NuvioMobile | https://github.com/NuvioMedia/NuvioMobile | `b88fef2e` | 2026-09-23 |
| NuvioDesktop | https://github.com/NuvioMedia/NuvioDesktop | `fca66320` | 2026-09-23 |
| Nuvio self-host | https://github.com/NuvioMedia/self-host | `39ea2bd1bc` | 2026-09-23 |
| Nuvio Account Manager | https://github.com/techuhak/Nuvio-Account-Manager | `c122c44f86` | 2026-09-23 |

## Updating a reference

1. `git -C tmp/<project> fetch origin && git -C tmp/<project> checkout <branch> && git -C tmp/<project> pull`
2. Diff the files listed in the feature map against the pinned commit: `git -C tmp/<project> diff <pinned>..HEAD -- <paths>`
3. Decide scope: behavior changes (semantics, field names, new fields) are ported 1:1; purely internal refactors are skipped.
4. Port, add or update tests, run `bun run typecheck && bun x vitest run`.
5. Update the pinned commit and last-synced date in this table.
6. If the change affects behavior clients rely on, note it in the README feature table.

## Rules

- A reference owns a feature; do not invent behavior when the reference already defines it. If a reference field has no source in the Stremio/Nuvio data model, document it in the README "Known gaps" table instead of approximating.
- When a reference adds a field a Jellyfin DTO can carry, add it here and port it.
- Subtitle and metadata work should stay diff-able against AIOMetadata: keep the same function boundaries where practical.
