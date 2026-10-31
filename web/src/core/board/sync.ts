import { Store } from '../store';
import { LatencyWindow, type LatencyStats } from './latency';
import { isInk } from './export';
import {
  addInk,
  inkElement,
  inkStyle,
  jsonBytes,
  normalizeRemote,
  remoteWins,
  type InkStroke,
} from './merge';
import {
  CLOSE,
  LIMITS,
  type BoardElement,
  type ClientMessage,
  type ServerMessage,
  type Tool,
} from './protocol';

/**
 * Синхронизация доски (R159): сокет `/api/v1/board`, свои правки — по кадру, чужие — слиянием без
 * истории отмены, возврат после обрыва — по номеру правки.
 *
 * МГНОВЕННО У СЕБЯ. Свой штрих Excalidraw рисует сразу; сюда он попадает через `onChange` и уходит
 * один раз за кадр (`requestAnimationFrame`): всё, что изменилось за кадр, — одним сообщением, по
 * последней версии каждого элемента. Штрих «в процессе» уходит не элементом целиком (500 точек на
 * каждое движение пера), а дельтой новых точек (`ink`); готовый элемент — одной правкой, когда перо
 * поднято.
 *
 * ЧУЖОЕ — СЛИЯНИЕМ. Пришедшая правка ложится, только если она побеждает свою (`merge.ts`); своё, что
 * человек прямо сейчас правит, не перебивается, а откладывается до конца правки. Чужие правки идут мимо
 * истории (`CaptureUpdateAction.NEVER` у холста) — отмена у каждого своя.
 *
 * ПОСЛЕ ОБРЫВА. Ядро нумерует принятые пачки (`seq`) и помнит последние: вернувшийся сокет говорит, что
 * у него было, и получает только пропущенное — или сцену целиком, если пропущено слишком много или
 * доску очистили (новое поколение, `epoch`). Своё неотправленное и неподтверждённое досылается после
 * этого: оно по-прежнему лежит в сцене.
 */

/** Чужой курсор: где он, лазер ли это и что выделено. */
export interface Cursor {
  x: number;
  y: number;
  tool: Tool;
  button: 'up' | 'down';
  selection: string[];
}

/** Холст, с которым работает синхронизация: в жизни — Excalidraw, в тестах — подделка. */
export interface BoardCanvas {
  /** Все элементы сцены, вместе с удалёнными. */
  elements(): readonly BoardElement[];
  /** Что человек правит сам прямо сейчас: набираемый текст, растягиваемая фигура. */
  editing(): ReadonlySet<string>;
  /** Свой штрих, который ещё рисуется (перо не поднято), или `null`. */
  drawing(): BoardElement | null;
  /** Положить чужие победившие правки поверх своих — мимо истории отмены. */
  merge(elements: BoardElement[]): void;
  /** Заменить сцену целиком (новое поколение доски) и забыть историю отмены. */
  replace(elements: BoardElement[]): void;
  /** Временные штрихи соседей: поставить или обновить `put`, убрать `remove`. */
  ink(put: BoardElement[], remove: string[]): void;
  /** Курсоры соседей. */
  cursors(cursors: ReadonlyMap<string, Cursor>): void;
}

/** Картинки доски (`files.ts`): что уже на сервере, загрузить свою, достать чужую. */
export interface BoardFilesPort {
  ready(fileId: string): boolean;
  upload(fileId: string): Promise<void>;
  need(fileId: string): void;
  known(ids: readonly string[]): void;
}

/** То, что синхронизации нужно от сокета: браузерный `WebSocket` или подделка теста. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type BoardState = 'connecting' | 'live' | 'offline' | 'closed' | 'replaced';

/** О чём сказать человеку: доска полна, правка не принята, доску очистил сосед. */
export type BoardNotice =
  | { kind: 'full'; at: number }
  | { kind: 'rejected'; at: number }
  | { kind: 'cleared'; by: string; at: number };

export interface BoardSyncOptions {
  roomId: string;
  credential: string;
  canvas: BoardCanvas;
  files?: BoardFilesPort;
  /** Часы сервера (`Meeting.serverNow`): по ним меряется задержка. */
  now: () => number;
  /** Открыть сокет; по умолчанию — `wss://<этот адрес>/api/v1/board`. */
  connect?: () => SocketLike;
  /** Следующий кадр; по умолчанию — `requestAnimationFrame`. */
  frame?: (callback: () => void) => void;
}

const OPEN = 1;
/** Сколько ждать перед следующей попыткой подключиться. */
const BACKOFF = [0, 500, 1000, 2000, 3000];
/** Штрих соседа, от которого ничего не приходит столько времени, убирается: перо, видно, ушло. */
const INK_EXPIRES_MS = 4000;

const same = (k: { v: number; n: number } | undefined, el: BoardElement) =>
  !!k && k.v === el.version && k.n === el.versionNonce;

export class BoardSync {
  readonly state = new Store<BoardState>('connecting');
  /** Может ли этот участник рисовать — по слову ядра; `null` — ядро ещё не ответило. */
  readonly canDraw = new Store<boolean | null>(null);
  readonly peers = new Store<ReadonlySet<string>>(new Set());
  readonly latency = new LatencyWindow();
  readonly stats = new Store<LatencyStats | null>(null);
  readonly notice = new Store<BoardNotice | null>(null);
  /** Номер этого участника, как его назвало ядро. */
  me = '';
  /** Поколение и номер последней правки, что есть у этого холста. */
  epoch = -1;
  seq = -1;
  /** Ждём ответа на «я что-то пропустил»: правки с разрывом до тех пор не трогаем. */
  private syncing = false;
  /** Какая версия каждого элемента есть у ядра — насколько мы знаем. */
  private known = new Map<string, { v: number; n: number }>();
  /** Что уйдёт в следующем кадре: последняя версия каждого изменённого элемента. */
  private pending = new Map<string, BoardElement>();
  /** Отправленное и ещё не подтверждённое — по сообщению на запись. */
  private inflight: Map<string, { v: number; n: number }>[] = [];
  /** Чужие правки, отложенные, пока человек правит этот элемент сам. */
  private deferred = new Map<string, BoardElement>();
  /**
   * Что было в сцене при прошлом взгляде. Элемент, пропавший из сцены без удаления (Excalidraw заменил
   * сцену загруженным файлом), уходит соседям удалённым — иначе у них он остался бы навсегда.
   */
  private lastSeen = new Map<string, BoardElement>();
  /** Свой штрих «в процессе»: сколько точек уже ушло. */
  private inkSent = new Map<string, number>();
  private inkOut: BoardElement | null = null;
  /** Штрихи соседей «в процессе». */
  private strokes = new Map<string, InkStroke>();
  private inkPut = new Set<string>();
  private inkRemove = new Set<string>();
  private cursorTarget = new Map<string, Cursor>();
  private cursorShown = new Map<string, Cursor>();
  private presenceOut: { x: number; y: number; tool: Tool; button: 'up' | 'down' } | null = null;
  private presenceAt = 0;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private selection = '';
  private selectionOut: string[] | null = null;
  private socket?: SocketLike;
  private live = false;
  private attempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;
  private ticks = 0;
  private lastPong = 0;
  private scheduled = false;
  private disposed = false;
  private versionSum = Number.NaN;

  constructor(private readonly options: BoardSyncOptions) {}

  start() {
    if (this.disposed) return;
    this.connect();
    this.tick = setInterval(() => this.onTick(), 1000);
  }

  /** Вернуть доску после «вытеснила другая вкладка» — по просьбе человека. */
  reconnect() {
    if (this.disposed) return;
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    const old = this.socket;
    this.socket = undefined;
    old?.close();
    this.goneOffline();
    this.state.set('connecting');
    this.connect();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.presenceTimer);
    clearInterval(this.tick);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000);
    this.state.set('closed');
  }

  /** Сцена изменилась у себя (`onChange` Excalidraw): найти, что уходит в следующем кадре. */
  localChange() {
    if (this.disposed) return;
    const canvas = this.options.canvas;
    const elements = canvas.elements();
    if (this.deferred.size) this.retryDeferred();
    if (this.canDraw.get() === false) return;
    const drawing = canvas.drawing();
    let sum = 0;
    for (const el of elements) sum += el.version * 31 + el.versionNonce;
    if (sum === this.versionSum && !drawing) return;
    this.versionSum = sum;
    const seen = new Map<string, BoardElement>();
    for (const el of elements) {
      // Чужой недорисованный штрих — не своя правка, даже когда его уже убирают с холста.
      if (this.strokes.has(el.id) || this.inkRemove.has(el.id) || isInk(el)) continue;
      seen.set(el.id, el);
      if (drawing && el.id === drawing.id) {
        this.inkOut = el;
        continue;
      }
      if (same(this.known.get(el.id), el)) continue;
      this.pending.set(el.id, el);
      this.inkSent.delete(el.id);
    }
    for (const [id, el] of this.lastSeen)
      if (!seen.has(id) && !el.isDeleted && this.known.has(id) && !this.strokes.has(id))
        this.pending.set(id, {
          ...el,
          isDeleted: true,
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
        });
    this.lastSeen = seen;
    if (drawing && !elements.some((el) => el.id === drawing.id)) this.inkOut = drawing;
    if (this.pending.size || this.inkOut) this.schedule();
  }

  /** Свой курсор и лазер — в сцене холста. */
  pointer(x: number, y: number, tool: Tool, button: 'up' | 'down') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.presenceOut = { x, y, tool, button };
    this.schedulePresence();
  }

  /** Своё выделение — соседи видят его рамкой своего цвета. */
  select(ids: readonly string[]) {
    const key = [...ids].sort().join(',');
    if (key === this.selection) return;
    this.selection = key;
    this.selectionOut = [...ids].slice(0, 500);
    if (this.presenceOut) this.schedulePresence();
  }

  // --- сокет -------------------------------------------------------------------------------

  private connect() {
    if (this.disposed) return;
    if (this.state.get() !== 'offline') this.state.set('connecting');
    const socket = this.options.connect
      ? this.options.connect()
      : (new WebSocket(
          `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/board`,
        ) as unknown as SocketLike);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastPong = Date.now();
      this.send({
        type: 'auth',
        roomId: this.options.roomId,
        credential: this.options.credential,
        epoch: this.epoch,
        since: this.seq,
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.disposed) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.goneOffline();
      if (this.disposed) return;
      if (event.code === CLOSE.boardClosed || event.code === CLOSE.forbidden) {
        this.state.set('closed');
        return;
      }
      if (event.code === CLOSE.replaced) {
        this.state.set('replaced');
        return;
      }
      this.state.set('offline');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(
        () => this.connect(),
        BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)],
      );
    };
    socket.onerror = () => socket.close();
  }

  /** Связь пропала: неподтверждённое снова считается неизвестным ядру и уйдёт после возврата. */
  private goneOffline() {
    this.live = false;
    for (const batch of this.inflight) for (const id of batch.keys()) this.known.delete(id);
    this.inflight = [];
    this.inkOut = null;
    this.inkSent.clear();
    this.versionSum = Number.NaN;
  }

  private send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private onTick() {
    this.ticks++;
    const now = Date.now();
    // Штрих соседа без новых точек — убрать: перо ушло, а готовый элемент не придёт.
    for (const [id, stroke] of this.strokes) if (now - stroke.at > INK_EXPIRES_MS) this.dropInk(id);
    if (this.inkRemove.size) this.schedule();
    this.stats.set(this.latency.stats());
    if (this.live && this.ticks % 10 === 0) this.send({ type: 'ping', id: String(this.ticks) });
    if (this.live && now - this.lastPong > 25_000) this.socket?.close();
  }

  /** Пришло от ядра. Открыто ради тестов. */
  receive(message: ServerMessage) {
    this.lastPong = Date.now();
    switch (message.type) {
      case 'hello':
        this.me = message.me;
        this.canDraw.set(message.canDraw);
        this.peers.set(new Set(message.peers));
        this.attempt = 0;
        break;
      case 'scene':
        this.scene(message.epoch, message.seq, message.els);
        this.options.files?.known(message.files.map((file) => file.id));
        break;
      case 'synced':
        if (message.seq >= this.seq) this.seq = message.seq;
        this.syncing = false;
        this.becomeLive();
        break;
      case 'ops':
        if (message.seq <= this.seq) break;
        if (message.seq !== this.seq + 1) {
          this.requestSync();
          break;
        }
        this.seq = message.seq;
        this.mergeRemote(message.els);
        if (!message.replay && message.t) this.latency.add(this.options.now() - message.t);
        break;
      case 'ack':
        this.inflight.shift();
        if (message.stale?.length) this.mergeRemote(message.stale);
        if (message.rejected?.length)
          this.notice.set({
            kind: message.rejected.some((item) => item.code === 'BOARD_FULL') ? 'full' : 'rejected',
            at: Date.now(),
          });
        if (message.seq === this.seq + 1 || (!this.syncing && message.seq === this.seq))
          this.seq = message.seq;
        else if (!this.syncing && message.seq > this.seq + 1) this.requestSync();
        break;
      case 'presence':
        this.cursorTarget.set(message.from, {
          x: message.x,
          y: message.y,
          tool: message.tool,
          button: message.button,
          selection: message.sel ?? this.cursorTarget.get(message.from)?.selection ?? [],
        });
        if (!this.cursorShown.has(message.from))
          this.cursorShown.set(message.from, { ...this.cursorTarget.get(message.from)! });
        this.schedule();
        break;
      case 'ink':
        this.remoteInk(message.from, message.id, message.start, message.pts, message.el);
        if (message.t) this.latency.add(this.options.now() - message.t);
        break;
      case 'joined':
        this.peers.update((peers) => new Set([...peers, message.from]));
        break;
      case 'left':
        this.peers.update((peers) => new Set([...peers].filter((id) => id !== message.from)));
        this.cursorTarget.delete(message.from);
        this.cursorShown.delete(message.from);
        for (const [id, stroke] of this.strokes) if (stroke.from === message.from) this.dropInk(id);
        this.options.canvas.cursors(this.cursorShown);
        this.schedule();
        break;
      case 'cleared':
        if (message.epoch !== this.epoch) {
          this.epoch = message.epoch;
          this.seq = message.seq;
          this.resetScene([]);
          if (message.by !== this.me) this.notice.set({ kind: 'cleared', by: message.by, at: Date.now() });
          // Своё, отправленное до того, как сюда дошла очистка, ядро уже положило в новое поколение:
          // сцена этого поколения целиком — и своё вернётся.
          this.syncing = true;
          this.send({ type: 'sync', epoch: this.epoch, since: -1 });
        }
        break;
      case 'access':
        this.canDraw.set(message.canDraw);
        if (!message.canDraw) {
          this.pending.clear();
          this.inkOut = null;
        } else {
          this.versionSum = Number.NaN;
          this.localChange();
        }
        break;
      case 'pong':
        break;
      case 'error':
        if (message.code === 'VIEW_ONLY') this.canDraw.set(false);
        break;
    }
  }

  /** Сцена целиком: того же поколения — слиянием и досылкой своего, другого — заменой. */
  private scene(epoch: number, seq: number, elements: BoardElement[]) {
    const remote = elements.map(normalizeRemote).filter((el): el is BoardElement => !!el);
    this.syncing = false;
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.seq = seq;
      this.resetScene(remote);
    } else {
      this.seq = seq;
      this.known = new Map(remote.map((el) => [el.id, { v: el.version, n: el.versionNonce }]));
      this.mergeRemote(remote);
    }
    this.becomeLive();
  }

  private resetScene(elements: BoardElement[]) {
    this.known = new Map(elements.map((el) => [el.id, { v: el.version, n: el.versionNonce }]));
    this.pending.clear();
    this.inflight = [];
    this.deferred.clear();
    for (const id of [...this.strokes.keys()]) this.dropInk(id);
    this.inkPut.clear();
    this.inkRemove.clear();
    this.options.canvas.replace(elements);
    this.lastSeen = new Map(elements.map((el) => [el.id, el]));
    for (const el of elements) this.needFile(el);
  }

  private becomeLive() {
    this.live = true;
    this.attempt = 0;
    this.state.set('live');
    // Своё, чего ядро не знает: неподтверждённое до обрыва и нарисованное без сети.
    this.versionSum = Number.NaN;
    this.localChange();
    this.schedule();
  }

  private requestSync() {
    if (this.syncing) return;
    this.syncing = true;
    this.send({ type: 'sync', epoch: this.epoch, since: this.seq });
  }

  /** Чужие правки: победившие — на холст и в «известное ядру», проигравшие своей — пропустить. */
  private mergeRemote(elements: readonly BoardElement[]) {
    const canvas = this.options.canvas;
    const local = new Map(canvas.elements().map((el) => [el.id, el]));
    const editing = canvas.editing();
    const winners: BoardElement[] = [];
    for (const raw of elements) {
      const el = normalizeRemote(raw);
      if (!el) continue;
      if (this.strokes.has(el.id)) {
        // Готовый штрих соседа заменяет его временный.
        this.strokes.delete(el.id);
        this.inkPut.delete(el.id);
        winners.push(el);
        this.known.set(el.id, { v: el.version, n: el.versionNonce });
        continue;
      }
      const mine = local.get(el.id);
      if (mine && editing.has(el.id) && !same({ v: mine.version, n: mine.versionNonce }, el)) {
        this.deferred.set(el.id, el);
        continue;
      }
      if (!remoteWins(mine, el, editing)) continue;
      winners.push(el);
      this.known.set(el.id, { v: el.version, n: el.versionNonce });
      this.pending.delete(el.id);
    }
    if (!winners.length) return;
    canvas.merge(winners);
    for (const el of winners) this.lastSeen.set(el.id, el);
    this.versionSum = Number.NaN;
    for (const el of winners) this.needFile(el);
  }

  /** Отложенное на время своей правки — когда правка кончилась. */
  private retryDeferred() {
    const editing = this.options.canvas.editing();
    const ready = [...this.deferred.values()].filter((el) => !editing.has(el.id));
    if (!ready.length) return;
    for (const el of ready) this.deferred.delete(el.id);
    this.mergeRemote(ready);
  }

  private needFile(el: BoardElement) {
    if (el.type === 'image' && !el.isDeleted && typeof el.fileId === 'string')
      this.options.files?.need(el.fileId);
  }

  // --- штрих «в процессе» -----------------------------------------------------------------

  private remoteInk(
    from: string,
    id: string,
    start: number,
    points: number[][],
    style: InkStroke['style'] | undefined,
  ) {
    const exists = this.options.canvas.elements().some((el) => el.id === id);
    if (exists && !this.strokes.has(id)) return;
    let stroke = this.strokes.get(id);
    if (!stroke) {
      stroke = { from, points: [], pressures: [], style: style ?? {}, at: Date.now() };
      this.strokes.set(id, stroke);
    }
    if (style) stroke.style = style;
    addInk(stroke, start, points);
    stroke.at = Date.now();
    this.known.set(id, { v: 1, n: 0 });
    this.inkPut.add(id);
    this.inkRemove.delete(id);
    this.schedule();
  }

  private dropInk(id: string) {
    if (!this.strokes.delete(id)) return;
    this.lastSeen.delete(id);
    this.inkPut.delete(id);
    this.inkRemove.add(id);
    this.known.delete(id);
  }

  // --- кадр --------------------------------------------------------------------------------

  private schedule() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    const frame =
      this.options.frame ??
      (typeof requestAnimationFrame === 'function'
        ? (callback: () => void) => requestAnimationFrame(callback)
        : (callback: () => void) => setTimeout(callback, 16));
    frame(() => {
      this.scheduled = false;
      if (!this.disposed) this.flush();
    });
  }

  private schedulePresence() {
    const wait = LIMITS.presenceMs - (Date.now() - this.presenceAt);
    if (wait <= 0) {
      this.schedule();
      return;
    }
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.schedule();
    }, wait);
  }

  /** Раз в кадр: свои правки, свой штрих, свой курсор; чужие штрихи и курсоры — на холст. */
  flush() {
    const canvas = this.options.canvas;
    if (this.live) {
      this.flushOps();
      this.flushInk();
      if (this.presenceOut && Date.now() - this.presenceAt >= LIMITS.presenceMs) {
        const { x, y, tool, button } = this.presenceOut;
        const sel = this.selectionOut ?? undefined;
        if (
          this.send({ type: 'presence', x, y, tool, button, ...(sel ? { sel } : {}), t: this.options.now() })
        ) {
          this.presenceAt = Date.now();
          this.presenceOut = null;
          this.selectionOut = null;
        }
      }
    }
    if (this.inkPut.size || this.inkRemove.size) {
      const put = [...this.inkPut].map((id) => inkElement(id, this.strokes.get(id)!));
      const remove = [...this.inkRemove];
      this.inkPut.clear();
      this.inkRemove.clear();
      canvas.ink(put, remove);
    }
    if (this.cursorTarget.size) this.animateCursors();
  }

  private flushOps() {
    if (!this.pending.size) return;
    const files = this.options.files;
    let chunk: BoardElement[] = [];
    let bytes = 0;
    const out = () => {
      if (!chunk.length) return;
      const versions = new Map(chunk.map((el) => [el.id, { v: el.version, n: el.versionNonce }]));
      if (this.send({ type: 'ops', els: chunk, t: this.options.now() })) {
        this.inflight.push(versions);
        for (const [id, version] of versions) this.known.set(id, version);
      } else for (const el of chunk) this.pending.set(el.id, el);
      chunk = [];
      bytes = 0;
    };
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const el of batch) {
      if (
        el.type === 'image' &&
        !el.isDeleted &&
        typeof el.fileId === 'string' &&
        files &&
        !files.ready(el.fileId)
      ) {
        // Картинка уходит после байтов: иначе сосед получит рамку без картинки.
        const id = el.id;
        void files.upload(el.fileId).then(
          () => this.resend(id),
          () => this.notice.set({ kind: 'rejected', at: Date.now() }),
        );
        continue;
      }
      const size = jsonBytes(el);
      if (size > LIMITS.elementBytes) {
        this.known.set(el.id, { v: el.version, n: el.versionNonce });
        this.notice.set({ kind: 'rejected', at: Date.now() });
        continue;
      }
      if (bytes + size > LIMITS.messageBytes || chunk.length >= LIMITS.batchElements) out();
      chunk.push(el);
      bytes += size;
    }
    out();
  }

  private resend(id: string) {
    const el = this.options.canvas.elements().find((item) => item.id === id);
    if (!el || same(this.known.get(id), el)) return;
    this.pending.set(id, el);
    this.schedule();
  }

  private flushInk() {
    const el = this.inkOut;
    this.inkOut = null;
    if (!el || !Array.isArray(el.points)) return;
    const from = this.inkSent.get(el.id) ?? 0;
    if (el.points.length <= from) return;
    const pressures = el.pressures ?? [];
    const pts = el.points.slice(from).map((point, i) => [point[0]!, point[1]!, pressures[from + i] ?? 0.5]);
    if (this.send({ type: 'ink', id: el.id, start: from, pts, el: inkStyle(el), t: this.options.now() }))
      this.inkSent.set(el.id, el.points.length);
  }

  /** Курсоры соседей плавно догоняют свои места: курсор приходит 30 раз в секунду, кадр — 60. */
  private animateCursors() {
    let moving = false;
    for (const [id, target] of this.cursorTarget) {
      const shown = this.cursorShown.get(id) ?? { ...target };
      const dx = target.x - shown.x;
      const dy = target.y - shown.y;
      const close = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;
      this.cursorShown.set(id, {
        ...target,
        x: close ? target.x : shown.x + dx * 0.5,
        y: close ? target.y : shown.y + dy * 0.5,
      });
      if (!close) moving = true;
    }
    this.options.canvas.cursors(this.cursorShown);
    if (moving) this.schedule();
  }
}
