# Durak pause and private move guidance

`durak.settings` now accepts `option: "pause"` and `option: "resume"` through the
existing command envelope. Both require an active room member who is the integration
host (`durak.hostId`) or room owner. No additional HTTP endpoint, WebSocket event or
command type is introduced. Existing room locking, command receipts and the database
transaction protect the state change, ACK and `room.changed` event together.

Pausing is allowed while `phase == "bout"`, including initial dealing and the short
settlement between bouts. Repeated pause/resume requests do not restart a clock.
Replaying a previously acknowledged pause command after a later resume returns its
original ACK and does not pause again. Pausing a lobby/finished game fails with
`409 DURAK_IDLE`; unauthorized settings fail with `403 FORBIDDEN`.

The viewer snapshot adds three optional properties:

| Property          | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `paused`          | Whether the host has explicitly stopped the game.                            |
| `pausedAt`        | Server epoch milliseconds when progress indicators froze, otherwise zero.    |
| `pausedRemaining` | Milliseconds remaining to the next turn/settlement deadline, otherwise zero. |

While paused `deadline == 0`, the server schedules no game timeout, and `acting`
retains the seat identity for a frozen turn indicator. `you.turn` is false and
`you.actions` / `you.plays` are empty. Card moves, dealing, active-player standing and
turn-length changes fail with `409 DURAK_PAUSED` without changing game state. Seating
for a future hand, reactions, unrelated settings and explicit closing remain available.
A participant may still leave the meeting; presence changes are recorded but cannot
advance a paused game. The pause survives the persisted room JSON, reconnects, host
identity rebind and server restart. The enclosing room's ordinary retention policy is
unchanged.

Resume shifts `actionAt`, `dealtAt` and `boutAt` by the frozen interval, restores
`deadline = now + pausedRemaining`, and excludes the paused interval from absence
grace periods. A pause with zero remaining time becomes due immediately on resume,
rather than granting a new turn or losing the deadline. The server remains the sole
clock authority; clients must not simulate a local-only pause.

`DurakYou.plays` is an optional list of `{ card, option, under }`. `option` is one of
`attack`, `beat`, `transfer`; `under` is a public attack card for `beat`, otherwise
null. Each entry is derived solely from this viewer's own cards and the public table,
using the same nonmutating validators as the command. Spectators have `you: null`.
Paused/inactive players have no choices. Hints are advisory snapshots: the server
revalidates every actual move, so concurrent/stale choices retain existing conflict
errors. Reading hints does not mutate hands, timers, scores or movement events.

| Client | Server | Behavior                                                                                                                                  |
| ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Old    | New    | Extra view fields are ignored. The server enforces pause even if the old UI has no pause display; attempted moves receive `DURAK_PAUSED`. |
| New    | Old    | Missing `paused` means unsupported: hide pause controls. Missing `plays` uses basic selection guidance without promising legal targets.   |
| New    | New    | Host/owner pause controls, frozen clocks and authoritative card/target guidance are available.                                            |

Windows uses the same web game UI inside WebView2; its native bridge does not deserialize
Durak game snapshots and needs no protocol or release update. `events.schema.json`
continues referencing the generated `Command` and `Snapshot` schemas. OpenAPI and
TypeScript must be regenerated from the running updated Java application with
`npm run generate:api`, never edited by hand.

Rolling back to a pre-pause server while a room is paused is not transparent: that
server ignores pause metadata and does not understand its zero deadline. Resume paused
games before an intentional server downgrade, or restore an explicit matching room
snapshot through the existing operator recovery process. No migration is required for
forward deployment; older persisted rooms default to an unpaused game.
