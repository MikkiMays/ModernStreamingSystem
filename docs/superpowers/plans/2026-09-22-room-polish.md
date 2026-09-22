# Room polish implementation

Approved in conversation on 2026-09-22. Implement in both sibling worktrees on codex/room-polish. No production restart, deployment, or data mutation.

## Task 1: Room UI
Music card uses MusicState enabled/status rather than bot presence; distinguish disabled/connecting/playing/paused/idle/error/loading. Games status includes Durak and Poker names and lobby/playing. Shared fullscreen state updates dock and game/player buttons for enter/exit/Esc/fallback without losing target layout. Chat gets hover/focus copy, touch access, multiline preservation, feedback/error, subtle theme-based differentiation. Own Services, Sidebar, MeetingView, fullscreen, related tests and NEW room-polish.css (avoid shared styles.css edits).

## Task 2: Game presentation
Occupied logical seats distributed by equal ellipse arc length, self at bottom, stable after fold/out. Single seat action outside felt, responsive readable names/cards, separate own hand band, prominent contextual turns and server clock timer. Nonselectable game decoration/cards, selectable input/dialog content. History in lazy dialog; compact tiles without descriptions, per-game accent and CC-BY poker-hand/card-joker assets. Durak fairness UI removed, secure shuffle retained. Server-event-driven card deal/draw/play/take/discard animations, no replay on reconnect, reduced motion. Exact Durak Online sticker images from public packs (26 at tgtg.su/pack/DurakOnlineAllEmoji, 28 at botobot.ru/catalog/stickers/yodurakonline), deduplicated/local with provenance, avatar picker, 1500ms cooldown, 2500ms display. Own game UI/CSS/core helpers/assets/e2e and handwritten game TS types; coordinate event interfaces with task 3. Do not edit fullscreen or generated.ts.

## Task 3: Game events/backend
Authoritative bounded monotonic game visual events (ID/server time/type/from/to/card count/public cards only), start/draw/play/take/discard action coverage. Durak reaction command validates catalog IDs, player membership and cooldown 1500ms, expires2500ms, stays room-local. Preserve private hands, command idempotency and recovery. Own Java game/room integration, tests, events schema. Communicate exact additive types to task2 before edits; no generated.ts edits. Parent regenerates OpenAPI after integration.

## Task 4: Video
Preserve HLS quality levels and correct bitrate/codec grouping. No unproven region workaround. DASH fallback for YouTube VOD without usable HLS using lazy dash.js5.2.1 on same video/room sync. Adaptive capability opt-in preserves old clients. MP4 video/AAC audio, real ftyp/moov/sidx ranges via bounded reads starting64KiB max1MiB concurrency4, static MPD separate codec/language sets via signed existing Range proxy. Expiry re-resolve restores position; progressive fallback explains limitations. Tests for indexes/range bounds/security XML/codecs/languages/quality/seek/cleanup. Own services cinema/new dash module/tests, web cinema/watch player/helpers/package manifests. Avoid general UI shared files.

## Task 5: Favorites (parent)
Add sort_order via additive migration preserving saved_at order, new PUT /api/v1/favorites/order {roomIds:UUID[]} transactionally checks profile exact set/duplicates, stale conflict; new favorite at top. Web Home/DesktopHome reorder with touch/keyboard/rollback. Windows native reorder ListView, saved server order and bridge refresh, remove false5-room cap. Own favorites Java/controller/tests migration, web favorites and Home/DesktopHome, native repo, generated contracts after integration.

## Verification
Regression-first for behavior. Focused unit/server tests then integrated npm test/build, Maven tests and contracts generation; native Core tests and Windows-only runtime gap reported. Browser checks locally only: no bypassing media permissions. Test2–6/10 occupied seats, sparse IDs, long text/large hands, themes/mobile/keyboard/reduced motion/reconnect/errors; no hidden hand leakage; favorites persistence/isolation/conflicts;1080/1440 manual/auto, seek and audio sync, malformed Range/MP4/expiry. Independent review after integration.

## Compatibility
New snapshot fields optional for old clients; absent animation/reaction fields settle normally on new clients. New favorites operation gracefully reports unsupported old server without losing prior order. DASH kind only returned on opt-in. No changes to applied migrations or production state.
