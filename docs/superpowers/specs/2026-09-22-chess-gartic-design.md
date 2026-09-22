# Chess and Gartic inside Cord

## Intent and constraints

Deliver two complete multiplayer activities inside the existing meeting, with rules,
responsive UI, movement/drawing feedback, cameras, avatars, speaking indicators,
spectators, reconnect and production publication. The user authorized design through
deployment and asked for efficient checks. This is architectural work split into two
engines, two interfaces and one shared integration. No independent accounts or embedded
third-party application. Existing Poker, Durak, music, chat and call controls remain usable.

Gartic is interpreted as both draw-and-guess and drawing telephone unless the user
chooses otherwise. Capacity follows Cord's ten-person room. Games use Russian UI.
WebView2 loads the same served web client, so no native release is necessary unless a
native change is actually needed. Java 25 / Spring Boot 4.1.1 and React 19.2 / Vite 8
remain the stack. No media permission bypass and no SFU restart for this delivery.

## Reuse decision

See `docs/games-open-source-research.md` for the comparison of twelve implemented open
source projects and verified licenses. Three approaches were considered:

1. Embed a standalone game: fastest prototype, but duplicates room identity, permissions,
   recovery, clocks and media participants. Rejected for the intended native integration.
2. Reuse rules and interaction patterns inside Cord: selected. Chess uses MIT
   `io.github.asdfjkl:jchesslib:1.2` from Maven Central. Drawing is an original state machine
   following public, generic turn rotation, private prompts and reveal concepts.
3. Write everything, including chess move legality: unnecessary correctness risk.

No third-party logos, drawing backgrounds, word databases or restricted artwork are
copied. Notices accompany reused code/dependencies. Chess rendering uses original SVG
piece artwork; the server supplies legal moves, so the client needs no second rules
engine. Server library integration checks legality before applying and computes SAN
before mutation. Wrapper tests cover special moves and end conditions.

## Shared architecture and ownership

Games are serializable fields of JDBC-persisted `RoomState`, protected by the existing
room row lock and idempotent command receipts. No schema migration is needed. New
`Chess`/`ChessView` and `Gartic`/`GarticView` classes are isolated under `game/`. Internal
classes ignore unknown JSON fields to preserve additive compatibility. Only view records
reach clients. Waiting/unapproved members receive neither game.

The integration owner edits `Contracts`, `RoomService`, `Lifecycle`, `OpenApiConfig`,
`RoomState`, transport quotas, TypeScript snapshot adapters, Stage and GamesGroup.
Engine owners edit only their engine/view/test files (and chess Maven dependency).
UI owners edit only their own game component, stylesheet, helper and component tests.
The parent supplies a common `GamePeople` media presentation component.

One stage activity at a time: watch, poker, durak, chess or gartic. Music and room chat
continue. Both directions of every open guard enforce exclusivity. Any admitted active
member may join a game; opening follows Cord integration permissions. Starting, closing
and reveal advancement belong to the game host or meeting owner. Host transfer follows
the existing room lifecycle when the host leaves.

Commands retain the common envelope and existing constructors. New commands use `text`
for UCI, guesses, prompts and compact bounded drawing JSON; `option` for mode/action;
`chips` and `positionMs` for numeric settings or expected turn/ply; `contentId` identifies
the particular game. Every phase-sensitive mutation checks game identity and turn token
to reject delayed commands from previous rounds or a rematch. Idempotence remains in
the existing receipt layer, and drawing stroke IDs prevent duplicate geometry.

Snapshots add optional nullable `chess` and `gartic`. REST and WebSocket share validation,
authorization and command dispatch. Events remain `room.changed`; replay fetches the
correct per-viewer state. Never place secrets in broadcast event payloads. API generation
uses the running application and existing `npm run generate:api`, never handwritten
generated types. The existing synchronization clock drives all deadlines and UI timers.

## Chess rules and state

Lobby has white/black seats. Opening seats the opener as white; a second player chooses
the free side. Host starts after two seats are occupied. Spectators can watch and flip
the board. Seats may change in lobby or after the result. Players may resign, offer a
draw, accept/decline an opponent's offer, claim an available draw, or request a rematch.
Rematch requires both players and switches colors. No engine opponent or ranked ladder.

Supported presets: untimed, 3+2, 5+0, 10+5, 15+10. Server stores remaining milliseconds,
the running side and anchor timestamp. A move first charges elapsed time, rejects a flag
fall, validates current game/ply/side and legality, then adds increment and changes side.
Clock continues through disconnect and server downtime, as an explicit online-game rule.
The deadline scheduler ends timed games without requiring the next client request.

State stores FEN, UCI/SAN moves with resulting FEN, clocks, participants, result, draw
offer and bounded repetition keys. Legal move list is computed for the current position
and shown only as permitted moves; the server always revalidates. Checkmate, stalemate,
dead material, resignation, agreement and time forfeit are distinct outcomes. Threefold
and fifty-move draws are claimable; fivefold and seventy-five-move draws automatic,
with checkmate precedence. Repetition uses effective en passant rights (only a legal
capture changes the key). Timeout with no possible mating material is a draw. Extremely
long games have a documented bounded move history sufficient for the draw rules.

Dead-position detection is material based. It does not solve arbitrary locked-pawn
fortresses or prove reachability of mate for every constructed position. This limitation
also applies to exceptional flag-fall positions; the implementation is not a tournament
arbiter or a tablebase service.

UI: board centered between player bars, compact move list at the side (below on narrow
screens), live clocks, turn/check markers, captured pieces and result. Click/tap and
pointer dragging both work; keyboard can select origin and destination. Promotion is an
explicit Q/R/B/N chooser. Last move and legal targets are visible. Original SVG pieces
move with bounded CSS animation; initial/recovery snapshots do not replay old moves.
Respect reduced motion. Flip board, review history without changing the game, return
to live, and export PGN. Every player bar uses Cord identity and speaking state.

## Gartic draw-and-guess

Lobby supports 2–10 players; join/leave and viewer mode are explicit. Host selects 2–5
rounds and 45/60/90-second drawing turns. Default 3 rounds, 60 seconds. Each round every
player draws once. The drawer privately chooses one of three original Russian words
within 15 seconds; timeout chooses one. Guessers see letter-length hints, never the
answer or choices. Hints reveal a small part as the round progresses.

Drawer draws; other active players submit guesses in a dedicated panel. Text is trimmed,
case normalized, whitespace collapsed and ё/е normalized. Correct answers become a
neutral success notice rather than leaking the secret through chat. Already-correct
players and spectators cannot guess again. Scoring rewards earlier guesses; drawer gains
points per correct player. A short reveal shows the answer and scores, then rotation
continues. Everyone guessed or drawer left advances safely; reconnect retains score and
identity. Match end shows rankings and a host-controlled new match.

The drawing surface has palette, brush sizes, eraser, undo and clear. Mouse, touch and
pen use normalized coordinates on a fixed aspect surface. Local ink is immediate;
network updates are queued bounded batches, with one in-flight request and retry of the
same stroke IDs. Live partial strokes are sent at no more than four batches/second.
No base64 screenshots or arbitrary SVG/HTML are accepted. Limits: 256 strokes and 4000
points per drawing, 128 points per stroke segment, 32 segments per batch, command text
<=4000 characters. Guess text is capped at 80 characters; telephone text at 120.
Every coordinate/color/width/id is validated; clearing and undoing use the same phase
token. Canvas reconstruction comes from the authoritative stroke list on reconnect.
Limit errors preserve local feedback and explicitly ask the drawer to undo/clear.

Drawing has a separate bounded rate bucket (300 commands/minute/member), so it cannot
consume room chat/control quota. REST and WS apply the same bucket. Geometry caps bound
storage and snapshot size. The selected limit favors a dependable first integration;
an ephemeral delta transport is a possible future optimization if measured load needs it.

## Gartic telephone

3–10 players start together; initial step asks each for a short prompt. Then every step
alternates drawing the received text and describing the received drawing. A cyclic
assignment ensures nobody gets their own immediately preceding entry. There are as many
steps as starting players, and a fixed frozen roster for the match. Players submit once;
all submitted or the deadline advances the round. Draft drawings are saved as strokes;
timeouts store the drawing so far or a clearly marked skipped text. Late joiners spectate.
Departed players do not prevent progress. Default text steps 45 seconds, drawing 90.

Each participant sees only their assigned previous entry and their own draft. Others'
chains remain absent from the JSON. Completed albums are revealed together at the end,
one selected entry at a time, controlled by the host; all clients share the reveal cursor.
The view includes album/step metadata and only the current revealed drawing, preventing
an entire ten-drawing album from overflowing the WebSocket buffer. UI animates the next
entry and clearly credits the author. Host can select albums, step through them, and
start a new match. No public persistent gallery; albums live with the room/game.

## Recovery, privacy and compatibility

Rejoin rebinds member IDs in seats, ownership and telephone assignments. Transient media
loss does not count as leaving. Disconnected chess players retain seats while their clocks
run. Gartic phase deadlines keep the match progressing. Closing the meeting clears games;
empty-game cleanup follows the existing idle policy. Server restart reloads room JSON and
rearms deadlines. No game owns or stops a LiveKit track: camera elements only attach/detach.

| Client/server | Behavior |
| --- | --- |
| Old client, new server | Ignores additive snapshots; chat/media and old games remain compatible. |
| New client, new server | Full new activities. |
| New client, old server | Missing snapshots treated as null; unsupported opening returns existing command error. |
| Previous server after rollback | Unknown game fields ignored; core room stays readable, active new games cannot be resumed until redeploy. |

## Focused verification and delivery

Engine tests target actual rules, stale commands, hidden information, JSON round-trip,
clocks, deadline transitions, reconnect identity and bounded/malformed drawing data.
Integration tests target admitted vs waiting access, host rights, bidirectional scene
exclusivity, receipts and different viewers. Browser tests use separate participants to
play chess moves/end a game, draw and guess a word, complete telephone and reconnect.
Inspect desktop and narrow layouts, light/dark themes, reduced motion, keyboard and
console errors. Reuse existing checks once at integration, rerun only failures or changes.

Build core and gateway images, preserve rollback image tags, deploy only changed services,
verify health and public HTTPS, then verify both local/remote main branches. Do not restart
databases, LiveKit or edge. Record commands, results and unverified hardware/load limits.
