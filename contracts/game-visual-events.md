# Game movement and Durak reactions

`Snapshot.poker.visualEvents` and `Snapshot.durak.visualEvents` are additive lists of
`GameVisualEvent { id, at, type, fromSeat, toSeat, count, cards }`. IDs increase within
one table lifetime and survive persisted-room recovery. `at` is server epoch milliseconds,
nondecreasing; ID breaks ties. Only the latest 128 entries are retained. This is a
visualization history, not a replacement for authoritative game state or room replay.

Clients baseline their cursor from the first/recovery snapshot without replaying old
movements. A newly opened table starts its own counter. Missing fields mean no animation.
Reduced-motion clients can always render the settled authoritative snapshot directly.

| Type | From → to | Public content |
| --- | --- | --- |
| `deal` | deck (`null`) → seat | One card per event, `cards: []` |
| `draw` | deck (`null`) → Durak seat | One card per event, `cards: []` |
| `draw` | deck (`null`) → poker board (`null`) | One public board card |
| `play` | Durak seat → board (`null`) | The publicly played card |
| `take` | board (`null`) → Durak defender | Only cards already public on the board |
| `discard` | board (`null`) → discard (`null`) | Only cards already public on the board |
| `discard` | leaving/folding seat → discard (`null`) | Private card count, `cards: []` |

Private movement never exposes cards, even to the owner; the ordinary per-viewer hand
remains the sole private-hand channel. Burn cards are never emitted. Initial dealing
follows actual logical-seat dealing order, with separate events for each card. Durak
take/discard events mark bout closing; subsequent refill events occur when the bout
settles. Do not infer movement by comparing private hand arrays.

`durak.react` uses the existing idempotent command envelope with `option` equal to one
of the 54 catalog IDs `durak-online-01` through `durak-online-54`. The active room member
must occupy a seat. The room lock and command receipt transaction serialize admission,
cooldown and replay. Unknown IDs fail `400 DURAK_REACTION`; unseated members fail `403`;
cooldown attempts fail `429 DURAK_REACTION_COOLDOWN`. Cooldown is 1500ms, including
participant rebind/recovery. An accepted reaction replaces that seat's preceding one.

`Snapshot.durak.reactions` contains `{ id, at, expiresAt, seat, stickerId }` for up to six
seats. IDs increase separately from visual-event IDs. Lifetime is 2500ms. Snapshots omit
expired entries; clients hide at `expiresAt` using the room server-clock offset without
requiring another broadcast. Departure removes the reaction; reactions stay room-local.

| Client | Server | Behavior |
| --- | --- | --- |
| Old | New | Existing game state and commands unchanged; extra fields ignored. |
| New | Old | Missing lists render settled state; reaction picker must remain unavailable. |
| New | New | Event animations and reactions enabled; existing receipt IDs prevent duplicates. |

`events.schema.json` continues referencing generated OpenAPI `Command` and `Snapshot`;
the new record schemas are generated from Java through the existing API generation task.
