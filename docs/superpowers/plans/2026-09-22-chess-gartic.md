# Chess and Gartic implementation plan

**Goal:** Publish two native multiplayer games with Cord media integration.
**Architecture:** Separate serializable rule engines and React views, integrated by the
existing room command/snapshot lifecycle. One owner for shared transport and contracts.
**Tech stack:** Java 25 / Spring Boot 4.1.1, jchesslib 1.2, React 19.2 / TypeScript.
**Spec:** `docs/superpowers/specs/2026-09-22-chess-gartic-design.md`.

The user's execution and publication authorization covers this plan. Work is delegated
in parallel as required by AGENTS.md; do not introduce repeated approval or test loops.

## Global constraints

- Preserve media ownership and existing games; do not weaken permission checks.
- Use server authority, bounded payloads, per-viewer filtering and existing receipts.
- Keep native Windows source unchanged unless actual integration requires it.
- Generate API contracts from the running application.

## Review focus

- Old phase commands must not modify a fresh round/rematch.
- Non-player snapshots must never disclose a secret word or telephone assignment.
- Pointer/keyboard input must remain usable on narrow screens and reconnect.
- Flag fall, promotion and legal en passant must survive serialization.
- Drawings must stay within payload/storage limits, including ten telephone albums.

## Task 1 — chess engine (engine owner)

- [x] Add `game/Chess.java`, `game/ChessView.java`, focused `ChessTest` and Maven dependency.
- [x] Expose open/join/leave/start/move/draw/resign/rematch/tick/rebind/presence/view operations.
- [x] Test actual special moves, draw/clock behavior, stale tokens and JSON recovery.

## Task 2 — Gartic engine (engine owner)

- [x] Add `game/Gartic.java`, `game/GarticView.java`, original word list and `GarticTest`.
- [x] Implement classic and telephone transitions, masked views and bounded stroke parsing.
- [x] Test scoring, privacy, timeouts, disconnect, reveal and invalid geometry.

## Task 3 — chess interface (UI owner)

- [x] Add `ui/ChessTable.tsx`, `chess.css`, helpers, SVG pieces and focused interaction tests.
- [x] Implement board movement, promotion, clocks, players, spectators, history and PGN.
- [x] Consume `snapshot.chess`, `meeting.command` and common `GamePeople`.

## Task 4 — Gartic interface (UI owner)

- [x] Add `ui/GarticTable.tsx`, `gartic.css`, drawing helper/canvas and focused tests.
- [x] Implement lobby, classic game, telephone rounds and synchronized album presentation.
- [x] Consume `snapshot.gartic`, phase tokens, bounded command queue and `GamePeople`.

## Task 5 — integration (parent)

- [x] Extend RoomState, Contracts, RoomService, Lifecycle and OpenApiConfig.
- [x] Add drawing rate bucket consistently to REST/WS; preserve default quotas.
- [x] Add GamePeople, Stage routes, GamesGroup settings and TypeScript adapters.
- [x] Generate contracts; test rights, replay masking, exclusivity and restart behavior.

## Task 6 — acceptance and publication (parent)

- [x] Run engine/integration tests, web tests, formatting and production build once integrated.
- [x] Run focused real-browser game flows; inspect desktop/mobile screenshots and console.
- [ ] Address concrete failures, review integrated diff, commit and push main.
- [ ] Tag rollback images, build/deploy changed core/gateway, verify public health/game flow.
- [ ] Confirm Windows main current; record production and verification evidence.
