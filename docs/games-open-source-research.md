# Gartic-style drawing and chess: open-source investigation

Research date: 2026-09-22. Scope: twelve implemented public projects, six drawing games
and six chess libraries, interfaces or servers. This is an implementation decision record,
not a claim that the external applications have passed Cord's production checks.

## Decision and evidence quality

**Recommendation, high confidence:** implement the two games inside Cord's existing room
and participant system. Reuse `io.github.asdfjkl:jchesslib:1.2` for Java chess move rules;
build Cord-specific orchestration and UI. For drawing, use the independently implemented
state machine and canvas protocol described below, informed by the drawing projects.
Neither game needs a second login, iframe, Socket.IO server, Firebase database or media
session.

Evidence levels used here:

- **High:** read repository license/manifests/source or fetched the published artifact.
- **Medium:** upstream README describes the feature and implementation files exist;
  gameplay was not executed during this investigation.
- **Recommendation:** a design judgment for Cord, not a measured upstream property.

All twelve license classifications below were checked against the repository's actual
`LICENSE`, not inferred from a search result. Feature and stack observations use upstream
README/manifests. The selected Java library was inspected at the **published 1.2 source
JAR**, because default-branch documentation may describe unreleased behavior. No external
source, artwork, word lists or logos were copied into Cord during this research.

## Constraints observed in Cord

The checked-out parent [pom.xml](../pom.xml) specifies Java 25 and Spring Boot 4.1.1.
[server/pom.xml](../server/pom.xml) uses Spring JDBC, PostgreSQL, Redis and WebSockets.
[web/package.json](../web/package.json) specifies React 19.2.8, TypeScript 5.9.3,
Vite 8.2.2 and LiveKit client 2.22.3, with an npm lockfile.

Existing integration points:

- [RoomService](../server/src/main/java/dev/mikki/stream/room/RoomService.java) applies
  game commands with room authorization, serialized room changes and command receipts.
- [RoomState](../server/src/main/java/dev/mikki/stream/room/RoomState.java) owns persisted
  game state; public game views are distinct from private state.
- [GameClock](../server/src/main/java/dev/mikki/stream/room/GameClock.java) and lifecycle
  scheduling already support authoritative deadlines and recovery.
- [GamesGroup](../web/src/ui/GamesGroup.tsx) supplies integration selection; games occupy
  the meeting stage and can use the meeting's existing participant identity and media.
- [Game visual event contract](../contracts/game-visual-events.md) already defines
  monotonically increasing event IDs, snapshot recovery baselines and reduced-motion
  behavior. The new games should follow these semantics.

These are the integration facilities selected during research. Implementation and
verification are recorded in [the acceptance report](verification/2026-09-22-chess-gartic.md).

## Six drawing-game implementations

| Project and verified license | Observed stack / useful capabilities | Reuse decision and limitations |
| --- | --- | --- |
| [Scribble.rs](https://github.com/scribble-rs/scribble.rs), [BSD-3-Clause license](https://github.com/scribble-rs/scribble.rs/blob/1bda7ed8b880bb598dede5096c0e2f3f58abe0b8/LICENSE) | Go, browser client, WebSocket rooms, configurable lobby cleanup, translations and self-hosted packaging. A substantial reference for a live draw-and-guess room. | Study canvas synchronization, drawer/guesser separation and round lifecycle. A Go sidecar would duplicate Cord room ownership. **README explicitly excludes logo, background and favicon from its BSD license and separately credits other assets.** Do not copy those assets. |
| [Drawphone](https://github.com/tannerkrewson/drawphone), [MIT license](https://github.com/tannerkrewson/drawphone/blob/517fd73f3b9bd57462b06d31e0903c8f60122bb7/LICENSE) | Node.js, jQuery, Pug and Socket.IO; telephone drawing game with alternating picture and description contributions. | Closest permissive conceptual reference for telephone chains and a reveal experience. Its own README warns that its early-project code is messy. Porting its complete server and DOM UI would add maintenance work; implement equivalent room-native transitions. |
| [Garlicphone](https://github.com/durancristhian/garlicphone), [MIT license](https://github.com/durancristhian/garlicphone/blob/03364fd3142e6f4b71f18cdcaa3ea183037b0386/LICENSE) | TypeScript, Next.js 10, React 17, Chakra UI, Firebase, drawing helpers, animation and GIF-related dependencies. Repository contains components, contexts and game flows. | Useful reference for split prompt/draw/guess/reveal screens. React concepts transfer, but its historical dependency stack and Firebase lifecycle do not fit Cord. Presence of GIF dependencies is not proof that every export path works. |
| [Type Draw Type Game](https://github.com/Bronkoknorb/type-draw-type-game), [AGPL-3.0 license](https://github.com/Bronkoknorb/type-draw-type-game/blob/680cf59d1ebde35e56e051e403c4a00e55f8b3c8/LICENSE) | Java/Spring Boot backend and React/TypeScript frontend; mobile-installable telephone pictionary. Upstream describes each player contributing to each story before unveiling it. | Especially relevant architecture comparison because the languages match Cord. Use as a behavioral reference. Do not incorporate AGPL source as though it were permissive; adopting it would require an explicit project-wide licensing decision. |
| [Paint by words](https://github.com/Bipoliaras/paint-by-words), [MIT license](https://github.com/Bipoliaras/paint-by-words/blob/5a59675d7ba2810359febd09570e9946d01024c4/LICENSE) | TypeScript Node `ws` server, React/Next.js client, shared generated Protocol Buffer messages; draw-and-guess scoring. | Good small example of a shared typed command envelope. Keep Cord's generated OpenAPI/WS contract rather than adding Protocol Buffers. Historical React 16/Next 9 dependencies make direct application reuse unattractive. |
| [DrawGuess](https://github.com/ZACHSTRIVES/Draw-Guess-Game), [MIT license](https://github.com/ZACHSTRIVES/Draw-Guess-Game/blob/61649d79b72d9fd948a97109c5d888bb395c5421/LICENSE) | React, Node/Express, MongoDB and Socket.IO; private/public rooms, canvas paths, brush controls, chat guesses, rankings and match records. | Useful UX reference for separating canvas, guessing and score feedback. Reuse the concept of persisted vector paths. Its separate accounts, MongoDB and room directory duplicate Cord; README-level descriptions were not treated as proof of secret-word confidentiality. |

Source commits above were captured with GitHub's repository/commit APIs. They pin the
license evidence, not a recommendation to install those revisions. The old dependency
versions are facts from their manifests, not a complete vulnerability assessment.

## Six chess implementations

| Project and verified license | Observed role and capabilities | Reuse decision and limitations |
| --- | --- | --- |
| [jchesslib](https://github.com/asdfjkl/jchesslib), [MIT license](https://github.com/asdfjkl/jchesslib/blob/96ab7b18fdcf7f7c39c8244b21d3f5954b82dbaa/LICENSE) | Java legal move generation, FEN, SAN, checks, mate/stalemate, game trees and PGN. Published `io.github.asdfjkl:jchesslib:1.2` is on Maven Central. | **Selected rules library.** Fits the current backend without another runtime or repository. Validate before applying moves; see the concrete limitations below. Cord still owns clocks, seats, repetition history, draw offers and results. |
| [Chesslib](https://github.com/bhlangonijr/chesslib), [Apache-2.0 license](https://github.com/bhlangonijr/chesslib/blob/12dac82e072696c209143f3b10a440044da9531b/LICENSE) | Java legal move generation, FEN/PGN, bitboards and history. README installation uses JitPack, currently version 1.3.7. | Strong alternative, but the tested Central coordinate returned 404 while JitPack returned 200. Additional artifact infrastructure is unnecessary when the Central library provides the required rules. Do not use a floating `master` dependency. |
| [chess.js](https://github.com/jhlywa/chess.js), [BSD-2-Clause license](https://github.com/jhlywa/chess.js/blob/d43e6683efeefbd07f8c53e8e7a47c62cf612439/LICENSE) | TypeScript rules library with legal moves, notation and end-state detection; deliberately not a computer opponent. | Good independent comparison source and optional client helper. Never make browser-only validation authoritative. Sending legal UCI moves in Cord snapshots avoids maintaining a second production rule engine initially. |
| [react-chessboard](https://github.com/Clariity/react-chessboard), [MIT license](https://github.com/Clariity/react-chessboard/blob/5f99614dabadfcad6f78eaa5d7822e42b28179e6/LICENSE) | React board component; upstream main manifest has React/ReactDOM `^19.0.0` peers and dnd-kit dependencies. | A viable permissive board candidate if its pinned published release, assets and interaction API are checked. A Cord-specific accessible board is also reasonable when the required scope is move/capture animation, orientation and promotion. The manifest on `main` is not proof of a particular npm release's API. |
| [Chessground](https://github.com/lichess-org/chessground), [GPL-3.0 license](https://github.com/lichess-org/chessground/blob/14bbbaced761274d1c14bd8fee73c79628958d72/LICENSE) | TypeScript board used by Lichess, drag/click moves, touch, premoves, arrows, move/fade animations, FEN and destination highlights; no chess rules inside. | Excellent behavior reference. Upstream explicitly describes combined-work GPL obligations. Do not install it into Cord on the assumption that all JavaScript libraries are permissive. |
| [Lila / Lichess](https://github.com/lichess-org/lila), [AGPL-3.0 license](https://github.com/lichess-org/lila/blob/a08067128f5284d5128f17783a786ab5fe94e0d0/LICENSE) | Scala 3 server, TypeScript client, MongoDB, Redis-connected separate WS service, gameplay, analysis, tournaments and studies. | Reference for game lifecycle, spectators, move history and server authority. A whole-server integration has far more deployment, identity and licensing consequences than this feature requires. Analysis clusters, ratings and tournaments are outside the two-game scope. |

Chess repository heads were captured using `git ls-remote ... HEAD`. Licensing decisions
here are conservative engineering choices; this research does not assert that GPL/AGPL
software can never be integrated with Cord.

## Selected Java dependency: concrete integration details

The following primary artifact URLs were fetched successfully (HTTP 200):

- [jchesslib 1.2 published POM](https://repo.maven.apache.org/maven2/io/github/asdfjkl/jchesslib/1.2/jchesslib-1.2.pom)
- [jchesslib 1.2 published sources](https://repo.maven.apache.org/maven2/io/github/asdfjkl/jchesslib/1.2/jchesslib-1.2-sources.jar)

The POM targets Java 11 and declares ICU4J 67.1 as a runtime dependency. The source JAR
shows ICU imports **only in `PgnReader`**, for charset detection. Excluding
`com.ibm.icu:icu4j` is appropriate if Cord only uses `Board`/`Move` and creates PGN text
from its own accepted SAN move history. If PGN import via `PgnReader` is added later,
restore a deliberately selected compatible ICU dependency and test that path.

`Board` imports `java.awt.Point`; verify the deployed runtime retains `java.desktop`.
Headless operation does not itself imply this module is absent. Source inspection is
not a substitute for the integration build on Cord's Java 25 runtime.

Verified public API in the **1.2 release**:

```java
import io.github.asdfjkl.jchesslib.Board;
import io.github.asdfjkl.jchesslib.Move;

Board board = new Board(true);         // standard initial position
Board recovered = new Board(fen);      // position only, not repetition history
Move move = new Move("e7e8q");          // UCI, including promotion
if (!board.isLegal(move)) {
    throw new IllegalArgumentException("Illegal move");
}
String san = board.san(move);           // compute before changing the board
board.apply(move);
String nextFen = board.fen();
boolean check = board.isCheck();
boolean mate = board.isCheckmate();
boolean stalemate = board.isStalemate();
```

Additional verified APIs: `board.legalMoves()`, `move.getUci()`,
`board.canClaimFiftyMoves()` and `board.isInsufficientMaterial()`.

Important limitations and wrapper responsibilities:

1. **`apply` does not validate.** Strictly validate UCI shape, seat, turn, game status and
   membership, then call `isLegal`. Reject null moves and malformed promotion values.
2. **FEN is not game history.** Persist normalized position keys or accepted moves for
   repetition. Position identity includes side, castling rights and only a legally
   relevant en-passant target; it excludes halfmove/fullmove counters.
3. **SAN corner case observed in source:** kingside-castling mate can append `#+` because
   that branch independently appends check after mate. Normalize that suffix or derive
   the final check/mate suffix from the post-move position. A focused regression is useful.
4. **Material helper is conservative.** Its source handles ordinary K/K, K+B/K, K+N/K and
   opposite-side bishops on the same square color, but does not fully model every
   promoted-bishop configuration. A small wrapper can detect all-bishops-on-one-color
   material. General dead positions and a particular side's ability to mate on flag fall
   are broader questions; do not claim that one insufficient-material predicate settles
   them all.
5. **Draw policy belongs to Cord.** Distinguish claimable threefold/50-move outcomes from
   automatic fivefold/75-move outcomes if implementing standard tournament draw semantics.
   Document any intentionally simpler casual-game policy; do not silently label it FIDE.
6. Keep mutable library boards private to one command execution or room lock; persist
   simple Cord records instead of serializing library internals.

Comparison evidence: the tested
[Chesslib 1.3.7 Central coordinate](https://repo.maven.apache.org/maven2/com/github/bhlangonijr/chesslib/1.3.7/chesslib-1.3.7.pom)
returned HTTP 404, whereas its
[JitPack POM](https://jitpack.io/com/github/bhlangonijr/chesslib/1.3.7/chesslib-1.3.7.pom)
returned HTTP 200. This establishes availability for these exact coordinates at research
time; it does not prove that no other Central fork or coordinate exists.

## Drawing-game design implications

“Gartic” can mean live drawing/guessing or telephone chains. They share a canvas, but their
privacy and round logic differ. A complete implementation should name its modes clearly.

**Live draw-and-guess:** the server picks candidate words, discloses them only to the active
drawer, accepts one choice, runs a deadline, admits bounded ordered strokes from that
drawer and evaluates guesses privately. Reveal only a word mask to guessers before the
round ends. Never broadcast a raw correct guess to remaining guessers. Compute points
on the server from the deadline and first accepted correct guess; retries must not award
points twice. Advance when all eligible guessers finish or time expires.

**Telephone:** freeze a roster at start; everyone writes an initial prompt, then alternates
drawing and describing. Assign each participant exactly one predecessor's entry per
phase, keep the rest of each chain private, and seal submissions before advancement.
New arrivals spectate until the next game. After the final phase, publish the completed
chains for synchronized reveal. A participant leaving must produce a deterministic skip
or placeholder, not permanently block every remaining participant.

**Shared canvas protocol:** store bounded vectors in normalized coordinates, with server
revision, author, brush color/width and stroke identifier. Render immediately locally,
batch movement points, reconcile with accepted state and deduplicate retries. Validate
finite coordinates, point count, color, width, per-round totals and submission size.
Pointer input must cover mouse/touch/stylus, pointer cancellation and release outside the
canvas. Undo/clear must be explicit authorized commands. Store replayable vector state;
base64 images in every room snapshot would amplify traffic and persistence cost.

Use existing snapshots to recover accepted strokes. Throttle canvas persistence and
broadcasting in a way consistent with the room transaction model; first measure before
introducing a separate high-frequency transport. The research did not benchmark Cord's
current snapshot throughput, so it does not justify a claimed FPS or player limit.

## Cord UI, media and animation implications

- Use existing room participants for names, avatars, speaking indication, microphones,
  connection state and participant menus. Game seats map to stable participant/member
  identities. Do not create a separate LiveKit room for a game.
- Keep the game on the main stage, meeting controls usable, and voice participants visible.
  On narrow screens prioritize the board/canvas and collapse secondary history/chat.
- Chess: show oriented board, legal destinations, last move, check, promotion choice,
  clocks, SAN history, turn owner, draw/resign actions, final result and rematch. Spectator
  controls cannot submit moves. Click/tap and keyboard interaction must work without drag.
- Animate chess from accepted move metadata: piece travel, capture fade, both castling
  pieces and promotion replacement. Use stable move sequence IDs and skip historical
  animation on initial/recovery snapshots. Reduced motion renders the settled position.
- Drawing: use clear phase labels, remaining time, visible progress/submission status,
  reversible local editing before acceptance and clear “waiting for others” feedback.
  Telephone reveal can animate entries progressively; animation cannot gate state changes.
- Reuse Cord icons or create original figures/controls. The package's top-level license
  does not automatically establish provenance of every separately credited art asset.
  Unicode chess symbols can be a functional fallback but have inconsistent platform
  rendering; deliberately drawn SVG pieces provide predictable contrast and sizing.

## Efficient verification and unresolved evidence

Focused verification should cover the risky boundaries rather than repeatedly rebuilding
unchanged layers: chess special moves and terminal states, illegal/wrong-turn commands,
duplicate commands, deadline/reconnect recovery, private drawing views, stale/oversized
strokes, telephone phase advancement, and two-browser participant/media integration.
One build/contract-generation cycle plus these targeted checks is more informative than
many repetitions of already-passing unrelated tests.

Research performed: local `cat`/`sed`/`rg` reads of instructions, manifests, existing game
contracts and integration points; primary GitHub/README/license browsing; concurrent
Python `urllib` fetches of public metadata, source files and Maven artifacts; six successful
`git ls-remote <repository> HEAD` reads. Utility scripts exited 0. A local filename search
for `CLAUDE`/nested `AGENTS.md` had no matches and exited 1. GitHub's anonymous API quota
was reached partway through; raw repository files and read-only Git resolved the remaining
evidence. Expected 404s on guessed upstream manifest paths were replaced by actual
README/manifests, not treated as missing implementations.

Unverified in this research: running any of the twelve applications; their security,
accessibility or performance; published react-chessboard release/API compatibility;
Java 25 runtime execution of jchesslib; end-to-end Cord game behavior and production
deployment. The official FIDE handbook fetch timed out, so this document deliberately
does not certify formal rules compliance. The next implementation evidence is the selected
library's targeted rule tests and actual Cord integration tests, with any adopted draw
policy written into the product rules.
