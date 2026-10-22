import type { RoomApi } from '../api/client';
import type { Ack, Command, RoomEvent, Snapshot } from '../api/types';
import { Store } from './store';

type Packet =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'event'; event: RoomEvent }
  | { type: 'authenticated'; liveAfter?: number }
  | { type: 'pong'; requestId?: string }
  | { type: 'ack'; ack: Ack }
  | { type: 'preview'; participantId: string; image: string }
  | { type: 'error'; message: string; code: string };

/** Сколько ждать pong после знака сети, прежде чем счесть открытый сокет мёртвым. */
export const PROBE_MS = 3000;

export class ControlChannel {
  /** Кадр превью чужого показа (R07): ставит встреча, иначе кадры просто пропускаются. */
  onPreview?: (participantId: string, image: string) => void;
  readonly state = new Store<'connecting' | 'connected' | 'recovering' | 'closed'>('connecting');
  readonly ping = new Store<number | null>(null);
  private pingRequest?: { id: string; at: number };
  private liveAfter = Infinity;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private handshake?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private attempt = 0;
  private lastPong = Date.now();
  private sequence = -1;
  private pending = new Map<string, (ack: Ack) => void>();
  constructor(
    private api: RoomApi,
    private onSnapshot: (snapshot: Snapshot) => void,
    private onEvent: (event: RoomEvent, live: boolean) => void,
    private onRevoked: () => void,
  ) {}
  start() {
    window.addEventListener('online', this.network);
    this.connect();
  }
  /** До какого момента открытый сокет обязан ответить на pong после знака сети, иначе он мёртв. */
  private probeDeadline = 0;
  private network = () => {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.probe();
      return;
    }
    if (this.socket?.readyState !== WebSocket.CONNECTING) {
      clearTimeout(this.timer);
      this.connect();
    }
  };
  /**
   * Сеть сменилась, а сокет «открыт»: открытый — не значит живой.
   *
   * После смены адреса (VPN включили или выключили) TCP-соединение под сокетом мертво, но
   * браузер узнаёт об этом только по своему таймауту, а мы — по `lastPong` через пятнадцать
   * секунд. Поэтому по знаку сети уходит немедленный ping, и на pong даётся три секунды
   * (`PROBE_MS`): нет ответа — сокет закрывается, и канал переподключается с нулевой задержкой.
   */
  private probe() {
    if (this.probeDeadline) return;
    this.probeDeadline = Date.now() + PROBE_MS;
    this.pingRequest = undefined;
    this.measurePing();
  }
  private connect = () => {
    if (this.disposed) return;
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events`,
    );
    this.socket = socket;
    clearTimeout(this.handshake);
    this.handshake = setTimeout(() => {
      if (this.socket === socket && !this.disposed) socket.close();
    }, 5000);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'auth',
          roomId: this.api.admission.roomId,
          credential: this.api.credential,
          after: this.sequence,
        }),
      );
      this.lastPong = Date.now();
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || this.disposed) return;
      try {
        const packet = JSON.parse(String(message.data)) as Packet;
        switch (packet.type) {
          case 'authenticated':
            this.liveAfter = packet.liveAfter ?? Infinity;
            clearTimeout(this.handshake);
            this.attempt = 0;
            this.state.set('connected');
            clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
              if (
                Date.now() - this.lastPong > 15000 ||
                (this.probeDeadline && Date.now() > this.probeDeadline)
              )
                socket.close();
              else if (!document.hidden || Date.now() - this.lastPong > 5000) this.measurePing();
            }, 2000);
            this.measurePing();
            break;
          case 'pong':
            this.lastPong = Date.now();
            this.probeDeadline = 0;
            if (this.pingRequest && this.pingRequest.id === packet.requestId) {
              this.ping.set(Math.round(performance.now() - this.pingRequest.at));
            }
            this.pingRequest = undefined;
            break;
          case 'snapshot':
            this.sequence = packet.snapshot.sequence;
            this.onSnapshot(packet.snapshot);
            break;
          case 'event':
            if (packet.event.version !== 1) {
              this.sequence = -1;
              socket.close();
              break;
            }
            if (packet.event.sequence <= this.sequence) break;
            if (packet.event.sequence !== this.sequence + 1) {
              this.sequence = -1;
              socket.close();
              break;
            }
            this.sequence = packet.event.sequence;
            this.onEvent(packet.event, packet.event.sequence > this.liveAfter);
            break;
          case 'ack':
            this.pending.get(packet.ack.commandId)?.(packet.ack);
            break;
          case 'preview':
            // Кадр превью показа: не событие комнаты (без номера, без снимка) — просто картинка.
            this.onPreview?.(packet.participantId, packet.image);
            break;
          case 'error':
            if (['FORBIDDEN', 'HISTORY_EXPIRED'].includes(packet.code)) {
              this.dispose();
              this.onRevoked();
            }
            break;
        }
      } catch {
        this.sequence = -1;
        socket.close();
      }
    };
    socket.onclose = () => {
      if (this.disposed || this.socket !== socket) return;
      clearInterval(this.heartbeat);
      clearTimeout(this.handshake);
      this.ping.set(null);
      this.pingRequest = undefined;
      this.probeDeadline = 0;
      this.state.set('recovering');
      this.timer = setTimeout(this.connect, Math.min(3000, [0, 500, 1000, 2000][this.attempt++] ?? 3000));
    };
    socket.onerror = () => socket.close();
  };
  private measurePing() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.pingRequest) {
      if (performance.now() - this.pingRequest.at > 5000) this.ping.set(null);
      return;
    }
    this.pingRequest = { id: crypto.randomUUID(), at: performance.now() };
    this.socket.send(JSON.stringify({ type: 'ping', requestId: this.pingRequest.id }));
  }
  async command(command: Command): Promise<Ack> {
    if (this.socket?.readyState !== WebSocket.OPEN || this.state.get() !== 'connected')
      return this.api.command(command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.commandId);
        void this.api.command(command).then(resolve, reject);
      }, 2500);
      this.pending.set(command.commandId, (ack) => {
        clearTimeout(timer);
        this.pending.delete(command.commandId);
        resolve(ack);
      });
      this.socket!.send(JSON.stringify({ type: 'command', command }));
    });
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearTimeout(this.handshake);
    window.removeEventListener('online', this.network);
    this.socket?.close();
    this.state.set('closed');
  }
}
