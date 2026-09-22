# Chess and Gartic — implementation and verification

Research compared twelve implemented upstream projects and checked their actual
licenses: [decision record](../games-open-source-research.md). The selected dependency is
MIT-licensed jchesslib 1.2 from Maven Central; its license is in
[THIRD-PARTY-GAMES.md](../../THIRD-PARTY-GAMES.md). Cord's game orchestration, drawing
protocol, interfaces, chess artwork and word list are original implementations.

## Changes

- `game/Chess.java`, `ChessView.java`, `server/pom.xml`: authoritative moves, clocks,
  promotion, castling, en passant, repetition, draw claims/offers, results and rematches.
- `game/Gartic.java`, `GarticView.java`: classic draw-and-guess and telephone modes,
  private assignments, bounded vector drawings, scoring, deadlines and album reveal.
- `RoomService`, `RoomState`, `Lifecycle`, `Contracts`, `RateLimits`, REST/WS adapters:
  room permissions, persistence, reconnect, host transfer, scene exclusivity and quotas.
- `contracts/openapi.json`, `web/src/api/generated.ts`: regenerated from the running
  local application, including per-viewer game snapshots.
- `ChessTable`, `GarticTable`, `GarticCanvas`, related CSS/helpers, `GamesGroup`, `Stage`
  and service status: native game controls, animated moves/reveal, mobile layouts,
  original SVG pieces, PGN, replay and drawing recovery.
- `GamePeople`: Cord identities, participant actions, existing camera tracks and speaking
  state. Components attach/detach views without taking ownership of media tracks.
- `core/recent.ts`, `core/meeting.ts`: game snapshots are excluded from stored admission
  data; drawing commands do not repeatedly write admission storage.

No database migration, extra game service or Windows-native source change is required.
Existing WebView2 clients receive these games from the deployed web application.

## Automated checks

All commands below were actually run from the main repository, with task changes present.
Dockerized Maven used `maven:3.9.11-eclipse-temurin-25`, the local Maven cache, host
networking and Docker socket for the real PostgreSQL Testcontainers tests.

| Command | Result |
| --- | --- |
| `mvn -B -q -pl server fmt:format verify` | 268 tests; zero failures, errors or skips; package built |
| `API_SCHEMA_URL=http://127.0.0.1:18590/api/openapi npm run generate:api` | Generated both contracts successfully |
| `npm ci` | Completed |
| `npm run format && npm test && npm run build` | 55 files / 398 tests passed; production build passed |
| `npx vitest run src/core/gartic.test.ts src/ui/gartic-table.test.tsx` after queue fixes | 17 tests passed |
| `npm run build` after queue fixes | TypeScript and Vite build passed |
| Targeted Prettier and `git diff --check` | Passed |

The second Gartic test pass addresses concrete regressions: 33 short strokes split into
32+1 segments, acknowledged optimistic ink disappears after another tab's undo/clear,
clear waits for an in-flight batch and remains usable after a rejected canvas-limit batch.
The existing large-media-chunk build warning remains; no unrelated dependency upgrades
were introduced. Full suites were not repeatedly run for CSS-only changes.

## Real-browser acceptance

Three independent Chrome contexts connected to an isolated local core and LiveKit.
Chrome ran as an unprivileged user with sandbox enabled. No camera/microphone permission
override was used. Screenshots and the exported PGN are under ignored
`.local/games-acceptance/`; test data uses synthetic names.

- Chess: two players and a spectator; actual pointer drag and square clicks; seven-ply
  Scholar's Mate; every move reached the spectator; board flip; mutual rematch changing
  sides; close and return to the meeting. Exported PGN contains `Qxf7# 1-0` and both names.
- Classic Gartic: drawing reached the spectator, who did not see the answer; a correct
  guess produced a reveal and scores for the guesser/drawer. Round timeout and rotation
  also progressed during the session.
- Telephone: three prompts, three drawings, three descriptions and three resulting
  albums. Reloading one browser restored the submitted drawing segments; the host's
  reveal navigation displayed the same drawing to another participant.
- Desktop 1440×1000 and mobile 390×844, light/dark themes inspected. Both games retain
  a 390 px document width on mobile. Chess board height was corrected against the stage
  height so both player bars remain visible on desktop. Gartic now also fits the full
  canvas, drawing status and album navigation above the call controls (verified geometry).
- No JavaScript page errors occurred in the completed game flows. The local test stack
  had expected optional music-catalog 404 responses because its room IDs did not exist
  in the separate integration service. A stale Vite dependency cache after `npm ci`
  initially returned 504; restarting the test Vite server resolved it.
- PGN initially failed Playwright's artifact copy because sandboxed Chrome could not
  write the root-owned default download directory. Giving the test browser its own
  writable download directory confirmed the real file downloaded correctly.

## Limits of this evidence

Automated tests cover special chess moves, clocks, claimable/automatic draws, JSON
recovery, game authorization and stale commands, secret-word/telephone masking,
invalid geometry and departure transitions. Browser acceptance is not a full browser
matrix, ten-user load test or live camera/audio device test. Windows WebView2 runtime
and actual active-speaker/camera rendering still require a device session.

Chess dead-position detection is material based; arbitrary locked-pawn fortresses and
all exceptional mating-reachability cases are not solved. There is no chess AI, rating
ladder or persistent public Gartic gallery. The scope is room-based multiplayer games.

Production publication and final health evidence are recorded separately at release.
