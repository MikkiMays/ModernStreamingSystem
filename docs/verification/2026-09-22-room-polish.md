# Room polish — implementation and verification

Implemented in the `codex/room-polish` worktrees for ModernStreamingSystem and
ModernStreamingSystem.Windows. Production services and data were not changed.
Chess and Gartic remain the next phase, as agreed in the implementation plan.

## Changes

- `web/src/ui/Services.tsx`, `services-status.ts`: music status comes from the music
  API, including disabled/loading/error; active game names and phases are displayed.
- `Sidebar.tsx`, `MeetingView.tsx`, `core/fullscreen.ts`, `room-polish.css`: message
  copy with feedback, subtle message backgrounds, shared fullscreen button state
  and separate target layout. Copy remains accessible on touch and keyboard focus.
- `PokerTable.tsx`, `DurakTable.tsx`, `GamesGroup.tsx`, `GamePresentation.tsx`,
  `DurakReactions.tsx`, `game-polish.css`, `core/game-layout.ts`: occupied-seat
  geometry, turn indicators, server-timed animation, hand scrolling, a single seat
  action, compact game tiles and lazy history dialog. Durak fairness UI removed;
  the shuffle and private-hand protection remain intact.
- `web/public/games/`: two attributed game icons and 29 distinct Durak Online images.
  The 54 source entries retain stable protocol aliases. Source URLs, checksums and
  artwork-license status are recorded in `ATTRIBUTION.md` and `durak-stickers.json`.
- Java game/view/room classes and `GameVisualEvent.java`: bounded public visual
  events and room-local reactions, 1500 ms cooldown and 2500 ms display lifetime.
  Private deal/draw events contain counts, never hidden card values.
- `FavoriteService`, `FavoriteController`, additive migration `V7__favorite_order.sql`:
  profile-specific transactional order, conflict handling, expiry row locking and
  new-room-first behavior. Web favorite hooks/components support pointer and keyboard
  reorder with optimistic rollback. Native `FavoriteClient`, `Contracts`,
  `MainWindow.xaml`, `MainWindow.xaml.cs`, `MainWindow.Favorites.cs` add the same
  server order, native drag/context actions and cross-view refresh; the five-room cap
  is removed.
- `services/cord_services/cinema.py`, `dash.py`, `WatchTheater.tsx`, `watch-dash.ts`,
  `watch-levels.ts`, `core/cinema.ts`, package manifests: optional YouTube DASH,
  bounded real MP4 index reads, codec-aware quality ladders, signed Range delivery,
  expiry recovery and progressive fallback. Upstream redirects are rejected.
  HLS quality is not capped by viewport size.
- `contracts/openapi.json`, `web/src/api/generated.ts`: regenerated from the local
  server. `contracts/game-visual-events.md` documents wire behavior and compatibility.
  Old servers omit event/reaction fields; their reaction picker stays unavailable.
  Old clients keep HLS/progressive because DASH requires capability opt-in.

## Automated verification

Commands were run in the isolated worktrees. Java commands used the installed
`maven:3-eclipse-temurin-25` Docker image, with the local Maven cache; PostgreSQL
tests used Testcontainers through the Docker socket and host networking.

| Command | Result |
| --- | --- |
| `mvn -q test` | 230 tests, zero failures/errors/skips, including PostgreSQL |
| `mvn -q -pl server fmt:format` | Passed; three task files formatted |
| `mvn -q -DskipTests package` | Passed; local verification JAR built |
| `API_SCHEMA_URL=http://127.0.0.1:18590/api/openapi npm run generate:api` | Passed; generated contracts updated |
| `npm test` | 50 files, 369 tests passed |
| `npm run build` | Passed; Vite retains large-chunk warnings |
| `npm run format:check` | All matched files passed |
| `PYTHONPATH=services /opt/meet/ModernStreamingSystem/.local/services-venv/bin/python -m unittest discover -s services/tests` | 78 tests passed |
| Native `dotnet test --project /opt/meet/.worktrees/room-polish/ModernStreamingSystem.Windows/tests/Cord.Core.Tests/Cord.Core.Tests.csproj -p:EnableWindowsTargeting=true -- --filter-class '*FavoriteOrderTests'` | Three tests passed |
| Native full Core suite with the same command, without the filter | 51 passed, two Linux DPAPI platform failures |
| `git diff --check` in both repositories | Passed |

Native tests used installed SDK 10.0.112 from a temporary SDK-selection directory;
the repository's pinned 10.0.400 configuration was preserved. The two full-suite
failures are `BoundaryTests.AServerPasswordIsKeptEncryptedAndSeparatelyForEachServer`
and `BoundaryTests.ProfilePersistsAcrossRestartsAndKeepsServersIsolated`: Windows
DPAPI is unavailable on Linux. Native WinUI build/runtime is still unverified.

## Browser and source checks

Final browser checks attached through CDP to Chrome running as an unprivileged user
with its sandbox enabled. Tests used isolated local core/LiveKit/services and no
camera/microphone permission overrides.

- Eleven game layout scenarios: 2–6 Durak and 2/6/10 Poker seats, mobile/desktop,
  keyboard reactions, long hands and a six-card hand at 360 px. No page errors or
  document overflow; action targets at least 44 px. Reduced-motion clocks retain
  their actual duration. Screenshots are under ignored `.local/game-polish/`.
- A real local room showed music disabled. Multiline chat copy succeeded. Entering
  fullscreen from either the game or call controls updated both buttons; exiting
  reset both. Child fullscreen did not apply room fullscreen layout. No page errors.
- Two real clients completed a Poker hand through showdown, with opponent cards
  hidden before showdown. Durak deal, reaction propagation/expiry, keyboard attack,
  taking and refill passed. Fifteen authoritative card-flight elements were observed.
  The live check exposed an action-button overlap in a short Poker stage; fitting
  the ellipse to both available dimensions fixed it, and the same flow passed.
- Favorite pointer and keyboard moves each produced successful server writes and
  retained the order after reload. Actual touch input in a 1280×1000 viewport
  auto-scrolled a long list by 579 px and saved the drop successfully.
- Real indexed YouTube MPD playback advanced at 1080p and 1440p after seeks to
  60/120 seconds, with decoded audio increasing and no player/page errors. DASH
  chooses a supported codec ladder initially; switches apply at segment boundaries.
  This avoids an observed dash.js cross-codec/seek race.
- Live Twitch master manifests for `kato_junichi0817`, `fps_shaka` and `ironmouse`
  each exposed 1080p60, 720p60, 480p30, 360p30 and 160p30 on 2026-09-22. No full
  streams were downloaded for that probe. This confirms availability on these
  sources, not a guarantee that every channel offers HD.

Hours-long signed-URL expiry, multi-client DASH synchronization and the
Safari/Firefox/WebView2 decoder matrix were not exercised end to end. Expiry,
parser bounds, codec selection and cleanup have automated coverage. Final UI
runtime on Windows still requires a Windows machine.
