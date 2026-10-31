import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byIndex, wins } from './merge';
import type { BoardElement, ClientMessage, ServerMessage } from './protocol';
import { BoardSync, type BoardCanvas, type Cursor, type SocketLike } from './sync';

/**
 * Синхронизация доски (R159) против поддельного ядра с теми же правилами, что у `BoardRoom.java`:
 * «последний побеждает» по version/versionNonce, номер пачки, возврат по since, очистка поколением.
 * Сеть и кадры — ручные: тест сам решает, когда что доходит.
 */

type Wire = { to: FakeSocket; data: string } | { close: FakeSocket; code: number };

class Network {
  queue: Wire[] = [];
  frames: (() => void)[] = [];
  /** Доставить всё, что в пути, и прокрутить кадры — пока есть что. */
  run() {
    for (let guard = 0; guard < 1000 && (this.queue.length || this.frames.length); guard++) {
      const frames = this.frames.splice(0);
      for (const frame of frames) frame();
      const wire = this.queue.shift();
      if (!wire) continue;
      if ('close' in wire) {
        wire.close.readyState = 3;
        wire.close.onclose?.({ code: wire.code });
      } else wire.to.onmessage?.({ data: wire.data });
    }
  }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: ClientMessage[] = [];
  member = '';
  constructor(
    private server: FakeServer,
    private net: Network,
  ) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send(data: string) {
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    this.server.receive(this, message);
  }
  deliver(message: ServerMessage) {
    this.net.queue.push({ to: this, data: JSON.stringify(message) });
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 2;
    this.server.leave(this);
    this.net.queue.push({ close: this, code });
  }
}

/** Ядро в миниатюре: то же слияние и та же нумерация, что у `BoardRoom` и `BoardSocket`. */
class FakeServer {
  epoch = 0;
  seq = 0;
  elements = new Map<string, BoardElement>();
  ring: { seq: number; from: string; els: BoardElement[] }[] = [];
  sockets = new Set<FakeSocket>();
  drawers = new Set<string>();
  offline = false;
  constructor(private net: Network) {}
  socket(member: string) {
    const socket = new FakeSocket(this, this.net);
    socket.member = member;
    return socket;
  }
  receive(socket: FakeSocket, message: ClientMessage) {
    if (this.offline) return;
    switch (message.type) {
      case 'auth': {
        this.sockets.add(socket);
        const replay = message.epoch === this.epoch && message.since >= 0 && message.since <= this.seq;
        socket.deliver({
          type: 'hello',
          me: socket.member,
          canDraw: this.drawers.has(socket.member),
          epoch: this.epoch,
          seq: this.seq,
          peers: [],
          mode: replay ? 'replay' : 'scene',
          st: 0,
        });
        this.catchUp(socket, replay ? message.since : -1);
        break;
      }
      case 'sync':
        this.catchUp(socket, message.epoch === this.epoch ? message.since : -1);
        break;
      case 'ops': {
        const accepted: BoardElement[] = [];
        const stale: BoardElement[] = [];
        for (const el of message.els) {
          const stored = this.elements.get(el.id);
          if (stored && !wins(el, stored)) {
            if (stored.version !== el.version || stored.versionNonce !== el.versionNonce) stale.push(stored);
            continue;
          }
          this.elements.set(el.id, el);
          accepted.push(el);
        }
        if (accepted.length) {
          this.seq++;
          this.ring.push({ seq: this.seq, from: socket.member, els: accepted });
          for (const other of this.sockets)
            if (other !== socket)
              other.deliver({
                type: 'ops',
                seq: this.seq,
                from: socket.member,
                t: message.t,
                st: 0,
                els: accepted,
              });
        }
        socket.deliver({
          type: 'ack',
          seq: this.seq,
          n: accepted.length,
          ...(stale.length ? { stale } : {}),
        });
        break;
      }
      case 'ink':
      case 'presence':
        for (const other of this.sockets)
          if (other !== socket) other.deliver({ ...message, from: socket.member, st: 0 } as ServerMessage);
        break;
    }
  }
  catchUp(socket: FakeSocket, since: number) {
    if (since >= 0 && (since === this.seq || this.ring.some((batch) => batch.seq === since + 1))) {
      for (const batch of this.ring.filter((b) => b.seq > since))
        socket.deliver({ type: 'ops', seq: batch.seq, from: batch.from, replay: true, els: batch.els });
      socket.deliver({ type: 'synced', seq: this.seq });
      return;
    }
    socket.deliver({
      type: 'scene',
      epoch: this.epoch,
      seq: this.seq,
      files: [],
      els: [...this.elements.values()],
    });
  }
  clear(by: string) {
    this.epoch++;
    this.seq++;
    this.elements.clear();
    this.ring = [];
    for (const socket of this.sockets)
      socket.deliver({ type: 'cleared', epoch: this.epoch, seq: this.seq, by });
  }
  leave(socket: FakeSocket) {
    this.sockets.delete(socket);
  }
}

/** Холст в миниатюре: элементы по номеру, порядок — по `index`, как у Excalidraw. */
class FakeCanvas implements BoardCanvas {
  map = new Map<string, BoardElement>();
  editingIds = new Set<string>();
  drawingEl: BoardElement | null = null;
  shown = new Map<string, Cursor>();
  replaced = 0;
  elements() {
    return [...this.map.values()].sort(byIndex);
  }
  editing() {
    return this.editingIds;
  }
  drawing() {
    return this.drawingEl;
  }
  merge(elements: BoardElement[]) {
    for (const el of elements) this.map.set(el.id, el);
  }
  replace(elements: BoardElement[]) {
    this.replaced++;
    this.map = new Map(elements.map((el) => [el.id, el]));
  }
  ink(put: BoardElement[], remove: string[]) {
    for (const el of put) this.map.set(el.id, el);
    for (const id of remove) if (this.map.get(id)?.customData) this.map.delete(id);
  }
  cursors(cursors: ReadonlyMap<string, Cursor>) {
    this.shown = new Map(cursors);
  }
  /** Нарисовать или поправить элемент «у себя» — как это делает Excalidraw. */
  put(id: string, version: number, extra: Partial<BoardElement> = {}) {
    const el: BoardElement = {
      id,
      type: 'rectangle',
      version,
      versionNonce: version * 7 + id.length,
      isDeleted: false,
      index: `a${id}`,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      ...extra,
    };
    this.map.set(id, el);
    return el;
  }
}

function client(server: FakeServer, net: Network, member: string, now = () => 1000) {
  const canvas = new FakeCanvas();
  const sockets: FakeSocket[] = [];
  const sync = new BoardSync({
    roomId: 'room',
    credential: `${member}.secret`,
    canvas,
    now,
    connect: () => {
      const socket = server.socket(member);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    frame: (callback) => net.frames.push(callback),
  });
  return { canvas, sync, sockets, socket: () => sockets.at(-1)! };
}

async function settle(net: Network) {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    net.run();
  }
}

let net: Network;
let server: FakeServer;

beforeEach(() => {
  net = new Network();
  server = new FakeServer(net);
  server.drawers = new Set(['anna', 'boris']);
});

afterEach(() => {
  vi.useRealTimers();
});

async function pair() {
  const anna = client(server, net, 'anna');
  const boris = client(server, net, 'boris');
  anna.sync.start();
  boris.sync.start();
  await settle(net);
  return { anna, boris };
}

describe('доска: синхронизация (R159)', () => {
  it('свой штрих уходит одним сообщением за кадр — последней версией', async () => {
    const { anna, boris } = await pair();
    for (const version of [1, 2, 3]) {
      anna.canvas.put('a', version);
      anna.sync.localChange();
    }
    await settle(net);
    const ops = anna.socket().sent.filter((m) => m.type === 'ops');
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type === 'ops' && ops[0]!.els[0]!.version).toBe(3);
    expect(boris.canvas.map.get('a')?.version).toBe(3);
    expect(anna.sync.seq).toBe(boris.sync.seq);
  });

  it('чужая правка ложится у соседа и эхом не возвращается', async () => {
    const { anna, boris } = await pair();
    anna.canvas.put('a', 1);
    anna.sync.localChange();
    await settle(net);
    boris.sync.localChange();
    await settle(net);
    expect(boris.socket().sent.filter((m) => m.type === 'ops')).toHaveLength(0);
    expect(server.seq).toBe(1);
  });

  it('одновременные правки одного элемента сходятся у всех и у ядра', async () => {
    const { anna, boris } = await pair();
    anna.canvas.put('a', 1);
    anna.sync.localChange();
    await settle(net);
    // Оба правят одну версию разом: у Анны nonce больше, у Бориса меньше — побеждает Борис.
    anna.canvas.put('a', 2, { versionNonce: 900, x: 100 });
    boris.canvas.put('a', 2, { versionNonce: 5, x: -100 });
    anna.sync.localChange();
    boris.sync.localChange();
    await settle(net);
    expect(server.elements.get('a')?.x).toBe(-100);
    expect(anna.canvas.map.get('a')?.x).toBe(-100);
    expect(boris.canvas.map.get('a')?.x).toBe(-100);
    // Разные элементы — оба на месте.
    anna.canvas.put('b', 1);
    boris.canvas.put('c', 1);
    anna.sync.localChange();
    boris.sync.localChange();
    await settle(net);
    expect([...anna.canvas.map.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect([...boris.canvas.map.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('своё, что сейчас правят, не перебивается, а ложится после правки', async () => {
    const { anna, boris } = await pair();
    boris.canvas.put('t', 1, { type: 'text', text: 'При' });
    boris.sync.localChange();
    await settle(net);
    anna.canvas.editingIds.add('t');
    anna.canvas.put('t', 1, { type: 'text', text: 'При', versionNonce: 1 });
    boris.canvas.put('t', 5, { type: 'text', text: 'Привет' });
    boris.sync.localChange();
    await settle(net);
    expect(anna.canvas.map.get('t')?.text).toBe('При');
    anna.canvas.editingIds.clear();
    anna.sync.localChange();
    await settle(net);
    expect(anna.canvas.map.get('t')?.text).toBe('Привет');
  });

  it('после обрыва — только пропущенное, а своё неподтверждённое досылается', async () => {
    const { anna, boris } = await pair();
    anna.canvas.put('a', 1);
    anna.sync.localChange();
    await settle(net);
    // Ядро «не слышит» Анну: её правка уходит в никуда, и сокет рвётся.
    server.offline = true;
    anna.canvas.put('b', 1);
    anna.sync.localChange();
    await settle(net);
    anna.socket().close(1006);
    await settle(net);
    server.offline = false;
    boris.canvas.put('c', 1);
    boris.sync.localChange();
    await settle(net);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await settle(net);
    expect(anna.sync.state.get()).toBe('live');
    const auth = anna.socket().sent.find((m) => m.type === 'auth');
    expect(auth && auth.type === 'auth' && auth.since).toBe(1);
    expect(anna.canvas.map.has('c')).toBe(true);
    expect(server.elements.has('b')).toBe(true);
    expect(boris.canvas.map.has('b')).toBe(true);
  });

  it('разрыв в номерах — просьба о пропущенном, и сцена догоняет', async () => {
    const { anna } = await pair();
    anna.sync.receive({ type: 'ops', seq: anna.sync.seq + 5, from: 'x', els: [] });
    const sync = anna.socket().sent.find((m) => m.type === 'sync');
    expect(sync).toBeTruthy();
    await settle(net);
    expect(anna.sync.seq).toBe(server.seq);
  });

  it('очистка — пустая доска у всех и новое поколение', async () => {
    const { anna, boris } = await pair();
    anna.canvas.put('a', 1);
    anna.sync.localChange();
    await settle(net);
    server.clear('boris');
    await settle(net);
    expect(anna.canvas.map.size).toBe(0);
    expect(boris.canvas.map.size).toBe(0);
    expect(anna.sync.epoch).toBe(1);
    expect(anna.sync.notice.get()).toMatchObject({ kind: 'cleared', by: 'boris' });
    // Старое поколение не воскресает: своё до очистки забыто, новое уходит.
    anna.canvas.put('n', 1);
    anna.sync.localChange();
    await settle(net);
    expect([...server.elements.keys()]).toEqual(['n']);
  });

  it('штрих в процессе — дельтами точек; у соседа временный, готовый заменяет его', async () => {
    const { anna, boris } = await pair();
    const stroke = (count: number, version: number) =>
      anna.canvas.put('s', version, {
        type: 'freedraw',
        points: Array.from({ length: count }, (_, i) => [i, i * 2]),
        pressures: Array.from({ length: count }, () => 0.5),
      });
    anna.canvas.drawingEl = stroke(3, 3);
    anna.sync.localChange();
    await settle(net);
    anna.canvas.drawingEl = stroke(5, 5);
    anna.sync.localChange();
    await settle(net);
    const ink = anna.socket().sent.filter((m) => m.type === 'ink');
    expect(ink.map((m) => m.type === 'ink' && [m.start, m.pts.length])).toEqual([
      [0, 3],
      [3, 2],
    ]);
    expect(anna.socket().sent.filter((m) => m.type === 'ops')).toHaveLength(0);
    const temp = boris.canvas.map.get('s');
    expect(temp?.points).toHaveLength(5);
    expect(temp?.locked).toBe(true);
    // Перо поднято — готовый элемент одной правкой, временный уходит.
    anna.canvas.drawingEl = null;
    stroke(6, 9);
    anna.sync.localChange();
    await settle(net);
    expect(boris.canvas.map.get('s')?.version).toBe(9);
    expect(boris.canvas.map.get('s')?.locked).toBeUndefined();
    expect(server.elements.get('s')?.points).toHaveLength(6);
  });

  it('смотрящий не шлёт правок, а получает их', async () => {
    server.drawers = new Set(['anna']);
    const { anna, boris } = await pair();
    expect(boris.sync.canDraw.get()).toBe(false);
    boris.canvas.put('x', 1);
    boris.sync.localChange();
    anna.canvas.put('a', 1);
    anna.sync.localChange();
    await settle(net);
    expect(boris.socket().sent.filter((m) => m.type === 'ops')).toHaveLength(0);
    expect(boris.canvas.map.has('a')).toBe(true);
  });

  it('курсор уходит не чаще 30 раз в секунду, а сосед видит его своим', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { anna, boris } = await pair();
    const sent = () => anna.socket().sent.filter((m) => m.type === 'presence').length;
    for (let i = 0; i < 20; i++) anna.sync.pointer(i, i, 'pointer', 'up');
    await settle(net);
    expect(sent()).toBe(1);
    anna.sync.pointer(50, 60, 'laser', 'down');
    await settle(net);
    expect(sent()).toBe(1);
    vi.advanceTimersByTime(40);
    await settle(net);
    expect(sent()).toBe(2);
    for (let i = 0; i < 30; i++) net.run();
    expect(boris.canvas.shown.get('anna')).toMatchObject({ x: 50, y: 60, tool: 'laser', button: 'down' });
  });

  it('картинка уходит соседям только после своих байтов', async () => {
    const uploads: string[] = [];
    let release!: () => void;
    const anna = client(server, net, 'anna');
    const ready = new Set<string>();
    const files = {
      ready: (id: string) => ready.has(id),
      upload: (id: string) =>
        new Promise<void>((resolve) => {
          uploads.push(id);
          release = () => {
            ready.add(id);
            resolve();
          };
        }),
      need: () => {},
      known: () => {},
    };
    const sync = new BoardSync({
      roomId: 'room',
      credential: 'anna.s',
      canvas: anna.canvas,
      files,
      now: () => 0,
      connect: () => {
        const socket = server.socket('anna');
        anna.sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      frame: (callback) => net.frames.push(callback),
    });
    sync.start();
    await settle(net);
    anna.canvas.put('img', 1, { type: 'image', fileId: 'f1' });
    sync.localChange();
    await settle(net);
    expect(uploads).toEqual(['f1']);
    expect(server.elements.has('img')).toBe(false);
    release();
    await settle(net);
    expect(server.elements.has('img')).toBe(true);
    sync.dispose();
  });

  it('задержка — по меткам времени в чужих правках', async () => {
    const anna = client(server, net, 'anna', () => 5000);
    const boris = client(server, net, 'boris', () => 5040);
    anna.sync.start();
    boris.sync.start();
    await settle(net);
    anna.canvas.put('a', 1);
    anna.sync.localChange();
    await settle(net);
    expect(boris.sync.latency.stats()).toMatchObject({ p50: 40, p95: 40, count: 1 });
  });

  it('элемент, пропавший из сцены без удаления, уходит соседям удалённым', async () => {
    const { anna, boris } = await pair();
    anna.canvas.put('a', 3);
    anna.sync.localChange();
    await settle(net);
    expect(boris.canvas.map.get('a')?.isDeleted).toBe(false);
    anna.canvas.map.delete('a');
    anna.sync.localChange();
    await settle(net);
    expect(server.elements.get('a')).toMatchObject({ isDeleted: true, version: 4 });
    expect(boris.canvas.map.get('a')?.isDeleted).toBe(true);
  });

  it('«Вытеснила другая вкладка» и «доски нет» — без самовозврата', async () => {
    const { anna, boris } = await pair();
    anna.socket().close(4010);
    boris.socket().close(4001);
    await settle(net);
    expect(anna.sync.state.get()).toBe('replaced');
    expect(boris.sync.state.get()).toBe('closed');
    anna.sync.reconnect();
    await settle(net);
    expect(anna.sync.state.get()).toBe('live');
  });
});
